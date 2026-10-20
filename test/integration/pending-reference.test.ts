import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { PendingReferenceWorker } from "../../src/application/wagering/pending-reference-worker";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import type { ReferenceRetryPolicy } from "../../src/domain/wagering/reference-retry-policy";
import { WagerTransactionRepository } from "../../src/infrastructure/database/wager-transaction.repository";
import { ConnectionException } from "@mikro-orm/core";
import { ConsoleLogger, Logger } from "@nestjs/common";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";
import { createTestOrm } from "./support/database";
import { expectLedgerInvariant } from "./support/invariant";
import { command, createWallet, snapshot, type TestWallet } from "./support/fixtures";

let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  // a limpeza roda mesmo se a invariante falhar (senão processos e conexões ficariam vivos)
  try {
    await expectLedgerInvariant(orm); // invariante final da seção 13, em toda wallet
  } finally {
    await orm.close();
  }
});

const sql = (query: string, params: unknown[] = []) => orm.em.getConnection().execute(query, params);

/** Política curta para o teste não esperar segundos entre tentativas. */
const fast: ReferenceRetryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 };

function setup(policy?: ReferenceRetryPolicy) {
  const useCase = new ProcessWagerTransactionUseCase(orm, undefined, undefined, undefined, policy);
  const worker = (leaseMs = 30_000) => new PendingReferenceWorker(orm, useCase, { batchSize: 50, idleDelayMs: 0, leaseMs, maxResolutionFailures: 5 });
  return { run: (cmd: Parameters<typeof useCase.execute>[0]) => useCase.execute(cmd), worker };
}

const txRow = async (id: string) =>
  (await sql("select status, failure_code, attempts, next_attempt_at, resolution_failures from wager_transactions where id = ?", [id]))[0]!;
const makeDue = (id: string) => sql("update wager_transactions set next_attempt_at = now() where id = ?", [id]);
const eventsOf = async (walletId: string, transactionId: string) =>
  (await sql("select event_type from outbox_messages where aggregate_id = ? and payload->'data'->>'transactionId' = ? order by event_type", [walletId, transactionId])).map((r) => r.event_type);

function refundOf(w: TestWallet, betExternalId: string, amount = "30.00") {
  return command(w, { kind: "REFUND", amount, referenceExternalTransactionId: betExternalId });
}

describe("worker de PENDING_REFERENCE", () => {
  test("REFUND antes da BET: o worker resolve quando a BET chega", async () => {
    const { run, worker } = setup();
    const w = await createWallet(orm, "100.00");
    const refundCmd = refundOf(w, "bet-1");

    const refund = await run(refundCmd);
    expect(String(refund.status)).toBe("PENDING_REFERENCE");
    await run(command(w, { amount: "30.00", externalTransactionId: "bet-1" })); // BET chega depois: saldo 70

    await makeDue(refund.transactionId);
    await worker().runOnce();

    expect(await txRow(refund.transactionId)).toMatchObject({ status: "PROCESSED", failure_code: null, next_attempt_at: null });
    const state = await snapshot(orm, w.walletId);
    expect(state.balance).toBe("100.00");
    expect(state.rebuilt).toBe(state.balance);
    expect(await eventsOf(w.walletId, refund.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    // replay da mesma chave agora devolve o resultado final
    expect(await run(refundCmd)).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" }, idempotentReplay: true });
  });

  test("referência que nunca chega: rejeitada com REFERENCE_NOT_FOUND ao esgotar as tentativas", async () => {
    const { run, worker } = setup(fast);
    const w = await createWallet(orm, "100.00");
    const refund = await run(refundOf(w, "nunca-chega"));

    await makeDue(refund.transactionId);
    await worker().runOnce(); // tentativa 2: reagenda
    expect(await txRow(refund.transactionId)).toMatchObject({ status: "PENDING_REFERENCE", attempts: 2 });

    await makeDue(refund.transactionId);
    await worker().runOnce(); // tentativa 3: desiste
    expect(await txRow(refund.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_FOUND",
      attempts: 3,
      next_attempt_at: null,
    });
    expect(await eventsOf(w.walletId, refund.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
    expect((await snapshot(orm, w.walletId)).balance).toBe("100.00");
  });

  test("não processa antes da hora agendada", async () => {
    const { run, worker } = setup(); // primeira espera: 2s
    const w = await createWallet(orm, "100.00");
    const refund = await run(refundOf(w, "bet-cedo"));

    await worker().runOnce();
    expect(await txRow(refund.transactionId)).toMatchObject({ status: "PENDING_REFERENCE", attempts: 1 });
  });

  test("referência rejeitada: a pendente vira REFERENCE_NOT_PROCESSED", async () => {
    const { run, worker } = setup();
    const w = await createWallet(orm, "10.00");
    const refund = await run(refundOf(w, "bet-sem-saldo"));
    const bet = await run(command(w, { amount: "30.00", externalTransactionId: "bet-sem-saldo" }));
    expect(String(bet.failureCode)).toBe("INSUFFICIENT_FUNDS");

    await makeDue(refund.transactionId);
    await worker().runOnce();
    expect(await txRow(refund.transactionId)).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_PROCESSED" });
    expect((await snapshot(orm, w.walletId)).balance).toBe("10.00");
  });

  test("outra reversão da mesma BET chegou antes: a pendente é rejeitada, sem crédito duplo", async () => {
    const { run, worker } = setup();
    const w = await createWallet(orm, "100.00");
    const pending = await run(refundOf(w, "bet-dupla"));
    await run(command(w, { amount: "30.00", externalTransactionId: "bet-dupla" }));
    const direct = await run(command(w, { kind: "ROLLBACK", amount: "30.00", referenceExternalTransactionId: "bet-dupla" }));
    expect(String(direct.status)).toBe("PROCESSED");

    await makeDue(pending.transactionId);
    await worker().runOnce();
    expect(await txRow(pending.transactionId)).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_ALREADY_REVERSED" });
    expect((await snapshot(orm, w.walletId)).balance).toBe("100.00");
  });

  test("dois workers ao mesmo tempo: cada pendente é resolvida uma vez só", async () => {
    const { run, worker } = setup();
    const wallets = await Promise.all(Array.from({ length: 15 }, () => createWallet(orm, "100.00")));
    const pendings: string[] = [];
    for (const w of wallets) {
      const external = `bet-${crypto.randomUUID()}`;
      pendings.push((await run(refundOf(w, external))).transactionId);
      await run(command(w, { amount: "30.00", externalTransactionId: external }));
    }
    await sql("update wager_transactions set next_attempt_at = now() where id = any(?::uuid[])", [`{${pendings.join(",")}}`]);

    const workerA = worker();
    const workerB = worker();
    await Promise.all([workerA.runOnce(), workerB.runOnce(), workerA.runOnce(), workerB.runOnce()]);

    for (const id of pendings) expect((await txRow(id)).status).toBe("PROCESSED");
    for (const w of wallets) {
      const state = await snapshot(orm, w.walletId);
      expect(state).toMatchObject({ balance: "100.00", credits: 2 }); // abertura + um único estorno
      expect(state.rebuilt).toBe(state.balance);
    }
  });

  test("worker morto depois de alugar: o aluguel vence e outro worker assume", async () => {
    const { run, worker } = setup();
    const w = await createWallet(orm, "100.00");
    const refund = await run(refundOf(w, "bet-aluguel"));
    await run(command(w, { amount: "30.00", externalTransactionId: "bet-aluguel" }));
    await makeDue(refund.transactionId);

    // um worker aluga por 300ms e "morre" antes de processar
    await orm.em.fork().transactional((em) => new WagerTransactionRepository().leaseDuePendingReferences(em, 50, 300));

    await worker().runOnce(); // aluguel ainda vale: ninguém pega
    expect((await txRow(refund.transactionId)).status).toBe("PENDING_REFERENCE");

    await Bun.sleep(400);
    await worker().runOnce();
    expect((await txRow(refund.transactionId)).status).toBe("PROCESSED");
    expect((await snapshot(orm, w.walletId)).balance).toBe("100.00");
  });

  test("erro de programação recorrente: depois do limite a pendente vira FAILED, auditável", async () => {
    const { run } = setup();
    const w = await createWallet(orm, "100.00");
    const refund = await run(refundOf(w, "bet-bug"));
    class BuggyUseCase extends ProcessWagerTransactionUseCase {
      override async resolve(): Promise<never> {
        throw new Error("bug no resolve");
      }
    }
    const worker = new PendingReferenceWorker(orm, new BuggyUseCase(orm), {
      batchSize: 50, idleDelayMs: 0, leaseMs: 30_000, maxResolutionFailures: 3,
    });

    for (let i = 0; i < 2; i++) {
      await makeDue(refund.transactionId);
      await worker.runOnce();
    }
    expect(await txRow(refund.transactionId)).toMatchObject({ status: "PENDING_REFERENCE", resolution_failures: 2 });

    await makeDue(refund.transactionId);
    await worker.runOnce();
    expect(await txRow(refund.transactionId)).toMatchObject({
      status: "FAILED",
      failure_code: "PROCESSING_FAILED",
      resolution_failures: 3,
      next_attempt_at: null,
    });
    const [audit] = await sql("select last_error from wager_transactions where id = ?", [refund.transactionId]);
    expect(audit?.last_error).toBe("bug no resolve");
    expect(await eventsOf(w.walletId, refund.transactionId)).toEqual(["WagerTransactionFailed", "WagerTransactionPendingReference"]);
    expect((await snapshot(orm, w.walletId)).balance).toBe("100.00");
  });

  test("banco fora não conta como falha: a pendente continua esperando", async () => {
    const { run } = setup();
    const w = await createWallet(orm, "100.00");
    const refund = await run(refundOf(w, "bet-banco-fora"));
    class DbDownUseCase extends ProcessWagerTransactionUseCase {
      override async resolve(): Promise<never> {
        throw new ConnectionException(new Error("db down"));
      }
    }
    const worker = new PendingReferenceWorker(orm, new DbDownUseCase(orm), {
      batchSize: 50, idleDelayMs: 0, leaseMs: 30_000, maxResolutionFailures: 3,
    });

    for (let i = 0; i < 5; i++) {
      await makeDue(refund.transactionId);
      await worker.runOnce();
    }
    expect(await txRow(refund.transactionId)).toMatchObject({ status: "PENDING_REFERENCE", resolution_failures: 0 });
  });

  test("eventos da resolução carregam o correlationId da requisição original", async () => {
    const { run, worker } = setup();
    const w = await createWallet(orm, "100.00");
    const refund = await run({ ...refundOf(w, "bet-rastro"), correlationId: "corr-abc-123" });
    await run(command(w, { amount: "30.00", externalTransactionId: "bet-rastro" }));

    await makeDue(refund.transactionId);
    await worker().runOnce();

    const correlations = await sql(
      "select event_type, payload->>'correlationId' as correlation_id from outbox_messages where payload->'data'->>'transactionId' = ? order by event_type",
      [refund.transactionId],
    );
    expect(correlations).toEqual([
      { event_type: "WagerTransactionPendingReference", correlation_id: "corr-abc-123" },
      { event_type: "WagerTransactionProcessed", correlation_id: "corr-abc-123" },
      { event_type: "WalletBalanceChanged", correlation_id: "corr-abc-123" },
    ]);
  });

  test("BET chega: a pendente que a referencia fica devida na hora, sem esperar o agendamento", async () => {
    const { run, worker } = setup();
    const w = await createWallet(orm, "100.00");
    const refund = await run(refundOf(w, "bet-acorda"));
    // simula uma pendente já nas últimas tentativas: próxima checagem só daqui a 2 minutos
    await sql("update wager_transactions set next_attempt_at = now() + interval '2 minutes' where id = ?", [refund.transactionId]);

    await run(command(w, { amount: "30.00", externalTransactionId: "bet-acorda" }));

    const [due] = await sql("select next_attempt_at <= clock_timestamp() as due from wager_transactions where id = ?", [refund.transactionId]);
    expect(due!.due).toBe(true);
    await worker().runOnce(); // sem makeDue
    expect((await txRow(refund.transactionId)).status).toBe("PROCESSED");
  });

  test("BET rejeitada também acorda a pendente (que vira REFERENCE_NOT_PROCESSED)", async () => {
    const { run, worker } = setup();
    const w = await createWallet(orm, "10.00");
    const refund = await run(refundOf(w, "bet-rejeitada-acorda"));
    await run(command(w, { amount: "30.00", externalTransactionId: "bet-rejeitada-acorda" }));

    await worker().runOnce(); // sem makeDue
    expect(await txRow(refund.transactionId)).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_PROCESSED" });
  });

  test("em cadeia: resolver o REFUND acorda o ROLLBACK que aponta para ele", async () => {
    const { run, worker } = setup();
    const w = await createWallet(orm, "100.00");
    const refundCmd = refundOf(w, "bet-cadeia");
    const refund = await run(refundCmd);
    const rollback = await run(
      command(w, { kind: "ROLLBACK", amount: "30.00", referenceExternalTransactionId: refundCmd.externalTransactionId }),
    );
    expect(String(rollback.status)).toBe("PENDING_REFERENCE");

    await run(command(w, { amount: "30.00", externalTransactionId: "bet-cadeia" }));
    await worker().runOnce(); // resolve o REFUND e acorda o ROLLBACK
    await worker().runOnce(); // resolve o ROLLBACK, sem makeDue

    expect((await txRow(refund.transactionId)).status).toBe("PROCESSED");
    expect((await txRow(rollback.transactionId)).status).toBe("PROCESSED");
    expect((await snapshot(orm, w.walletId)).balance).toBe("70.00"); // 100 - 30 + 30 - 30
  });

  test("não acorda pendente de outro provedor com o mesmo id externo", async () => {
    const { run } = setup();
    const w = await createWallet(orm, "100.00");
    const other = await run({ ...refundOf(w, "bet-homonima"), providerId: "provider-b", idempotencyKey: "provider-b:x-1", externalTransactionId: "x-1" });
    await sql("update wager_transactions set next_attempt_at = now() + interval '2 minutes' where id = ?", [other.transactionId]);

    await run(command(w, { amount: "30.00", externalTransactionId: "bet-homonima" })); // provider-a

    const [due] = await sql("select next_attempt_at <= clock_timestamp() as due from wager_transactions where id = ?", [other.transactionId]);
    expect(due!.due).toBe(false);
  });

  test("logs do worker trazem os ids da transação e o correlationId original", async () => {
    const lines: Array<Record<string, any>> = [];
    Logger.overrideLogger(new JsonLogger((line) => lines.push(JSON.parse(line))));
    try {
      const { run, worker } = setup();
      const w = await createWallet(orm, "100.00");
      const refund = await run({ ...refundOf(w, "bet-log"), correlationId: "corr-worker-1" });
      await run(command(w, { amount: "30.00", externalTransactionId: "bet-log" }));
      await worker().runOnce();

      expect(lines.find((l) => l.msg === "pending reference resolved")).toMatchObject({
        transactionId: refund.transactionId,
        walletId: w.walletId,
        providerId: "provider-a",
        correlationId: "corr-worker-1",
      });
    } finally {
      Logger.overrideLogger(new ConsoleLogger());
    }
  });
});
