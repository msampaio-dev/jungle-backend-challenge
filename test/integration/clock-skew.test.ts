import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { EventPublisher } from "../../src/application/outbox/event-publisher";
import { OutboxRelay } from "../../src/application/outbox/outbox-relay";
import { PendingReferenceWorker } from "../../src/application/wagering/pending-reference-worker";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import { createTestOrm } from "./support/database";
import { command, createWallet } from "./support/fixtures";

/**
 * Relógio da aplicação diferente do relógio do banco, como acontece entre
 * máquinas. Agendamentos (próxima checagem, backoff da outbox) são
 * comparados com now() do banco, então precisam ser calculados nele.
 */
let orm: MikroORM;
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  orm = await createTestOrm();
});

afterEach(() => {
  setSystemTime(); // volta ao relógio real
});

afterAll(async () => {
  await orm.close();
});

const sql = (q: string, p: unknown[] = []) => orm.em.getConnection().execute(q, p);

test("app adiantada 1h: a pendente continua sendo checada ~2s depois, não 1h depois", async () => {
  const useCase = new ProcessWagerTransactionUseCase(orm);
  const worker = new PendingReferenceWorker(orm, useCase, { batchSize: 50, idleDelayMs: 0, leaseMs: 30_000, maxResolutionFailures: 5 });
  const w = await createWallet(orm, "100.00");

  setSystemTime(new Date(Date.now() + HOUR));
  const refund = await useCase.execute(command(w, { kind: "REFUND", amount: "30.00", referenceExternalTransactionId: "bet-skew" }));
  await useCase.execute(command(w, { amount: "30.00", externalTransactionId: "bet-skew" }));

  const [row] = await sql("select extract(epoch from next_attempt_at - now()) as wait from wager_transactions where id = ?", [refund.transactionId]);
  expect(Number(row!.wait)).toBeLessThan(5); // agendado no relógio do banco

  await Bun.sleep(2_200);
  await worker.runOnce();
  const [resolved] = await sql("select status from wager_transactions where id = ?", [refund.transactionId]);
  expect(resolved!.status).toBe("PROCESSED");
});

test("app atrasada 1h: o backoff da outbox continua valendo", async () => {
  const w = await createWallet(orm, "0.00");
  await new ProcessWagerTransactionUseCase(orm).execute(command(w, { kind: "LOSS", amount: "0.00" }));
  await sql("update outbox_messages set published_at = now() where aggregate_id <> ? and published_at is null", [w.walletId]);

  setSystemTime(new Date(Date.now() - HOUR));
  const down: EventPublisher = { publish: async () => Promise.reject(new Error("sqs down")) };
  expect((await new OutboxRelay(orm, down).publishBatch()).failed).toBe(1);

  // logo em seguida o evento ainda está no backoff de 1s: ninguém deve tentar de novo
  let calls = 0;
  const counting: EventPublisher = { publish: async () => void calls++ };
  await new OutboxRelay(orm, counting).publishBatch();
  expect(calls).toBe(0);

  const [row] = await sql("select extract(epoch from next_attempt_at - now()) as wait from outbox_messages where aggregate_id = ?", [w.walletId]);
  expect(Number(row!.wait)).toBeGreaterThan(0);
  expect(Number(row!.wait)).toBeLessThan(5);
});

test("publicação lenta que falha: o backoff conta a partir da falha, não do início da transação", async () => {
  const w = await createWallet(orm, "0.00");
  await new ProcessWagerTransactionUseCase(orm).execute(command(w, { kind: "LOSS", amount: "0.00" }));
  await sql("update outbox_messages set published_at = now() where aggregate_id <> ? and published_at is null", [w.walletId]);

  const slowAndDown: EventPublisher = {
    publish: async () => {
      await Bun.sleep(1_500); // mais que o backoff de 1s
      throw new Error("sqs timeout");
    },
  };
  expect((await new OutboxRelay(orm, slowAndDown).publishBatch()).failed).toBe(1);

  const [row] = await sql("select extract(epoch from next_attempt_at - now()) as wait from outbox_messages where aggregate_id = ?", [w.walletId]);
  expect(Number(row!.wait)).toBeGreaterThan(0); // ainda no backoff, não vencido
});

test("app adiantada 1h: eventos de abertura de wallet saem na hora, não 1h depois", async () => {
  await sql("update outbox_messages set published_at = now() where published_at is null");
  setSystemTime(new Date(Date.now() + HOUR));
  const w = await createWallet(orm, "50.00");

  let published = 0;
  const counting: EventPublisher = { publish: async () => void published++ };
  await new OutboxRelay(orm, counting).publishBatch();
  expect(published).toBe(2); // WagerTransactionProcessed + WalletBalanceChanged da abertura
  const [row] = await sql("select count(*)::int as n from outbox_messages where aggregate_id = ? and published_at is null", [w.walletId]);
  expect(row!.n).toBe(0);
});
