import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { wageringPorts } from "../../src/infrastructure/wiring";
import { DeleteMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { ConnectionException } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import { type Outcome, SqsWagerConsumer, type SqsConsumerOptions } from "../../src/infrastructure/messaging/sqs-wager-consumer";
import { ConsoleLogger, Logger } from "@nestjs/common";
import { InboxRepository } from "../../src/infrastructure/database/inbox.repository";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";
import { createTestOrm } from "./support/database";
import { expectLedgerInvariant } from "./support/invariant";
import { command, createWallet, snapshot, type TestWallet } from "./support/fixtures";
import { createTestQueue } from "./support/sqs";

let orm: MikroORM;
let main: Awaited<ReturnType<typeof createTestQueue>>;
let dlq: Awaited<ReturnType<typeof createTestQueue>>;
let options: SqsConsumerOptions;

beforeAll(async () => {
  orm = await createTestOrm();
});

// filas novas por teste: nenhum teste herda mensagem de outro
beforeEach(async () => {
  dlq = await createTestQueue("consumer-dlq");
  main = await createTestQueue("consumer-main", { VisibilityTimeout: "2" });
  options = {
    queueUrl: main.queueUrl,
    dlqUrl: dlq.queueUrl,
    consumerName: "wager-transactions-consumer",
    waitTimeSeconds: 1,
    maxAttempts: 3,
    backoffBaseSeconds: 0, // reentrega imediata para o teste não esperar
    backoffMaxSeconds: 0,
  };
});

afterAll(async () => {
  // a limpeza roda mesmo se a invariante falhar (senão processos e conexões ficariam vivos)
  try {
    await expectLedgerInvariant(orm); // invariante final da seção 13, em toda wallet
  } finally {
    await orm.close();
  }
});

const useCase = () => new ProcessWagerTransactionUseCase(orm, wageringPorts());
const consumer = (uc: Pick<ProcessWagerTransactionUseCase, "execute"> = useCase(), client: SQSClient = main.client) =>
  new SqsWagerConsumer(client, orm, uc as ProcessWagerTransactionUseCase, options);

function envelope(w: TestWallet, overrides: Record<string, unknown> = {}, messageId = `msg-${crypto.randomUUID()}`) {
  const { idempotencyKey, ...data } = command(w, overrides as never);
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { ...data, idempotencyKey },
  };
}

/** Lê e processa até a fila principal esvaziar. */
async function consumeAll(c: SqsWagerConsumer): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (let empty = 0; empty < 2; ) {
    const batch = await c.pollOnce();
    if (batch.length === 0) empty++;
    outcomes.push(...batch);
  }
  return outcomes;
}

const inboxCount = async (messageId: string) =>
  (await orm.em.getConnection().execute("select 1 from inbox_messages where message_id = ?", [messageId])).length;

describe("consumidor SQS", () => {
  test("processa pelo mesmo use case da API, grava inbox e dá ack", async () => {
    const w = await createWallet(orm, "100.00");
    const msg = envelope(w, { amount: "25.00" });
    await main.send(msg, w.walletId);

    expect(await consumeAll(consumer())).toEqual(["processed"]);
    expect((await snapshot(orm, w.walletId)).balance).toBe("75.00");
    expect(await inboxCount(msg.messageId)).toBe(1);
    expect(await main.receiveAll()).toHaveLength(0); // ack feito
  });

  test("logs do consumidor trazem messageId, correlationId e os ids da transação", async () => {
    const lines: Array<Record<string, any>> = [];
    Logger.overrideLogger(new JsonLogger((line) => lines.push(JSON.parse(line))));
    try {
      const w = await createWallet(orm, "100.00");
      const msg = { ...envelope(w, { amount: "25.00" }), correlationId: "corr-sqs-1" };
      await main.send(msg, w.walletId);
      await consumeAll(consumer());

      const expected = {
        messageId: msg.messageId,
        correlationId: "corr-sqs-1",
        walletId: w.walletId,
        providerId: "provider-a",
        transactionId: expect.any(String),
      };
      expect(lines.find((l) => l.msg === "message processed")).toMatchObject(expected);
      expect(lines.find((l) => l.msg === "wager transaction processed")).toMatchObject({ ...expected, channel: "sqs" });
    } finally {
      Logger.overrideLogger(new ConsoleLogger());
    }
  });

  test.each([
    ["longo demais", "c".repeat(300)],
    ["com caracteres que não vão para log", "abc def\nlinha"],
  ])("correlationId %s não derruba a aposta: vira o messageId, como na API", async (_name, correlationId) => {
    const w = await createWallet(orm, "100.00");
    const msg = { ...envelope(w, { amount: "10.00" }), correlationId };
    await main.send(msg, w.walletId);

    expect(await consumeAll(consumer())).toEqual(["processed"]);
    expect((await snapshot(orm, w.walletId)).balance).toBe("90.00");
    const [tx] = await orm.em
      .getConnection()
      .execute("select correlation_id from wager_transactions where external_transaction_id = ?", [msg.data.externalTransactionId]);
    expect(tx?.correlation_id).toBe(msg.messageId);
  });

  test("atomicidade: falha depois de gravar a inbox desfaz tudo junto (transação, ledger, outbox e inbox)", async () => {
    const w = await createWallet(orm, "100.00");
    const msg = envelope(w, { amount: "25.00" });
    await main.send(msg, w.walletId);

    // a inbox é a ÚLTIMA coisa gravada na transação: grava e, na primeira vez, falha logo depois
    let inserts = 0;
    class InsertThenFailInbox extends InboxRepository {
      override async insert(...args: Parameters<InboxRepository["insert"]>) {
        await super.insert(...args);
        if (++inserts === 1) throw new Error("crash right after the inbox insert");
      }
    }
    const fragile = new SqsWagerConsumer(main.client, orm, useCase(), options, new InsertThenFailInbox());

    expect(await fragile.pollOnce()).toEqual(["retry"]);
    const ext = msg.data.externalTransactionId;
    const [left] = await orm.em.getConnection().execute(
      `select
         (select count(*)::int from inbox_messages where message_id = ?) as inbox,
         (select count(*)::int from wager_transactions where external_transaction_id = ?) as tx,
         (select count(*)::int from outbox_messages where payload->'data'->>'externalTransactionId' = ?) as outbox`,
      [msg.messageId, ext, ext],
    );
    expect(left).toEqual({ inbox: 0, tx: 0, outbox: 0 });
    expect((await snapshot(orm, w.walletId)).debits).toBe(0);

    // se a inbox tivesse ficado, a reentrega seria descartada como duplicata e a aposta se perderia
    expect(await consumeAll(fragile)).toEqual(["processed"]);
    expect(await inboxCount(msg.messageId)).toBe(1);
    expect((await snapshot(orm, w.walletId)).debits).toBe(1);
  });

  test("a mesma mensagem entregue duas vezes produz um único débito", async () => {
    const w = await createWallet(orm, "100.00");
    const msg = envelope(w, { amount: "25.00" });
    await main.send(msg, w.walletId);
    await main.send(msg, w.walletId);

    expect(await consumeAll(consumer())).toEqual(["processed", "duplicate"]);
    expect(await snapshot(orm, w.walletId)).toMatchObject({ balance: "75.00", debits: 1 });
  });

  test("mesmo messageId com outro conteúdo não é descartado: vai para a DLQ", async () => {
    const w = await createWallet(orm, "100.00");
    await main.send(envelope(w, { amount: "10.00" }, "msg-reused"), w.walletId);
    await main.send(envelope(w, { amount: "20.00" }, "msg-reused"), w.walletId);

    expect(await consumeAll(consumer())).toEqual(["processed", "dead-letter"]);
    const [dead] = await dlq.receiveAll();
    expect(dead?.MessageAttributes?.errorCode?.StringValue).toBe("MESSAGE_ID_CONFLICT");
    expect(JSON.parse(dead!.Body!).data.money.amount).toBe("20.00");
    expect((await snapshot(orm, w.walletId)).balance).toBe("90.00");
  });

  test("rejeição de negócio é resultado, não erro: ack e nada na DLQ", async () => {
    const w = await createWallet(orm, "10.00");
    await main.send(envelope(w, { amount: "25.00" }), w.walletId);

    expect(await consumeAll(consumer())).toEqual(["processed"]);
    const [tx] = await orm.em.getConnection().execute(
      "select status, failure_code from wager_transactions where wallet_id = ? and kind = 'BET'",
      [w.walletId],
    );
    expect(tx).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    expect(await dlq.receiveAll()).toHaveLength(0);
  });

  test.each([
    ["JSON inválido", () => "{ não é json", "INVALID_ENVELOPE"],
    ["tipo desconhecido", () => ({ messageId: "m", type: "Other", data: {} }), "INVALID_ENVELOPE"],
    ["messageId gigante", (w: TestWallet) => envelope(w, {}, "m".repeat(256)), "INVALID_ENVELOPE"],
    ["dinheiro inválido", (w: TestWallet) => envelope(w, { money: { amount: "1e3", currency: "BRL" } }), "INVALID_MONEY"],
    // o motivo da DLQ repete o valor recebido; o SQS recusa caractere de controle em atributo
    ["dinheiro com caractere de controle", (w: TestWallet) => envelope(w, { money: { amount: "1\u0000", currency: "BRL" } }), "INVALID_MONEY"],
    ["wallet inexistente", (w: TestWallet) => envelope({ ...w, walletId: Bun.randomUUIDv7() }), "WALLET_NOT_FOUND"],
  ])("erro permanente (%s) vai direto para a DLQ com o motivo", async (_name, build, code) => {
    const w = await createWallet(orm, "100.00");
    await main.send(build(w), w.walletId);

    expect(await consumeAll(consumer())).toEqual(["dead-letter"]);
    const [dead] = await dlq.receiveAll();
    expect(dead?.MessageAttributes?.errorCode?.StringValue).toBe(code);
    expect(await main.receiveAll()).toHaveLength(0);
  });

  test("erro transitório: tenta de novo e, esgotado o limite, vai para a DLQ", async () => {
    const w = await createWallet(orm, "100.00");
    await main.send(envelope(w), w.walletId);
    const down = { execute: async () => Promise.reject(new ConnectionException(new Error("db down"))) };

    expect(await consumeAll(consumer(down))).toEqual(["retry", "retry", "dead-letter"]);
    const [dead] = await dlq.receiveAll();
    expect(dead?.MessageAttributes?.errorCode?.StringValue).toBe("RETRIES_EXHAUSTED");
    expect((await snapshot(orm, w.walletId)).debits).toBe(0);
  });

  test("erro transitório que se resolve: processa uma vez só", async () => {
    const w = await createWallet(orm, "100.00");
    await main.send(envelope(w), w.walletId);
    const real = useCase();
    let calls = 0;
    const flaky = {
      execute: (...args: Parameters<ProcessWagerTransactionUseCase["execute"]>) =>
        ++calls === 1 ? Promise.reject(new ConnectionException(new Error("blip"))) : real.execute(...args),
    };

    expect(await consumeAll(consumer(flaky))).toEqual(["retry", "processed"]);
    expect((await snapshot(orm, w.walletId)).debits).toBe(1);
  });

  test("depois de um retry, as próximas mensagens da mesma wallet esperam a vez", async () => {
    const w = await createWallet(orm, "100.00");
    await main.send(envelope(w, { amount: "10.00" }), w.walletId);
    await main.send(envelope(w, { amount: "20.00" }), w.walletId);

    const real = useCase();
    const applied: string[] = [];
    let calls = 0;
    const flaky = {
      execute: async (...args: Parameters<ProcessWagerTransactionUseCase["execute"]>) => {
        if (++calls === 1) throw new ConnectionException(new Error("blip"));
        applied.push(args[0].money.amount);
        return real.execute(...args);
      },
    };

    await consumeAll(consumer(flaky));
    expect(applied).toEqual(["10.00", "20.00"]);
  });

  test("banco fora antes do use case (consulta da inbox) vira retry, não exceção", async () => {
    const w = await createWallet(orm, "100.00");
    await main.send(envelope(w, { amount: "25.00" }), w.walletId);
    let finds = 0;
    class FlakyInbox extends InboxRepository {
      override async find(...args: Parameters<InboxRepository["find"]>) {
        if (++finds === 1) throw new ConnectionException(new Error("db down"));
        return super.find(...args);
      }
    }
    const worker = new SqsWagerConsumer(main.client, orm, useCase(), options, new FlakyInbox());

    expect(await worker.pollOnce()).toEqual(["retry"]);
    expect(await consumeAll(worker)).toEqual(["processed"]);
    expect((await snapshot(orm, w.walletId)).debits).toBe(1);
  });

  test("mensagem que só esperou a vez não gasta entregas: chega à primeira tentativa com contador 1", async () => {
    const lines: Array<Record<string, any>> = [];
    Logger.overrideLogger(new JsonLogger((line) => lines.push(JSON.parse(line))));
    try {
      options.maxAttempts = 8;
      const w = await createWallet(orm, "100.00");
      const msgs = ["1.00", "2.00", "3.00"].map((amount) => envelope(w, { amount }));
      for (const m of msgs) await main.send(m, w.walletId);

      // banco fora nas 3 primeiras tentativas (todas da primeira mensagem)
      const real = useCase();
      let calls = 0;
      const flaky = {
        execute: async (...args: Parameters<ProcessWagerTransactionUseCase["execute"]>) => {
          if (++calls <= 3) throw new ConnectionException(new Error("db down"));
          return real.execute(...args);
        },
      };
      await consumeAll(consumer(flaky));

      const processed = (id: string) => lines.find((l) => l.msg === "message processed" && l.messageId === id);
      expect(processed(msgs[0]!.messageId)?.receiveCount).toBe(4); // 3 falhas + o sucesso
      expect(processed(msgs[1]!.messageId)?.receiveCount).toBe(1); // só esperou: nenhuma entrega gasta
      expect(processed(msgs[2]!.messageId)?.receiveCount).toBe(1);
      expect(await dlq.receiveAll()).toHaveLength(0);
    } finally {
      Logger.overrideLogger(new ConsoleLogger());
    }
  });

  test.each([0, -1, 1.5, Number.NaN])("número de leitores inválido (%p) é recusado ao montar", (concurrency) => {
    expect(() => new SqsWagerConsumer(main.client, orm, useCase(), { ...options, concurrency })).toThrow(/invalid consumer concurrency/);
  });

  test("leitores em paralelo: wallets diferentes ao mesmo tempo, a mesma wallet uma de cada vez", async () => {
    const wallets = await Promise.all([1, 2, 3].map(() => createWallet(orm, "100.00")));
    for (const w of wallets) for (const amount of ["1.00", "2.00"]) await main.send(envelope(w, { amount }), w.walletId);

    const real = useCase();
    const running = new Map<string, number>();
    let maxSameWallet = 0;
    let maxOverall = 0;
    let overall = 0;
    const slow = {
      async execute(...args: Parameters<ProcessWagerTransactionUseCase["execute"]>) {
        const walletId = args[0].walletId;
        running.set(walletId, (running.get(walletId) ?? 0) + 1);
        overall++;
        maxSameWallet = Math.max(maxSameWallet, running.get(walletId)!);
        maxOverall = Math.max(maxOverall, overall);
        try {
          await Bun.sleep(200);
          return await real.execute(...args);
        } finally {
          running.set(walletId, running.get(walletId)! - 1);
          overall--;
        }
      },
    };
    const worker = new SqsWagerConsumer(main.client, orm, slow as ProcessWagerTransactionUseCase, { ...options, concurrency: 3 });
    worker.start();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const states = await Promise.all(wallets.map((w) => snapshot(orm, w.walletId)));
      if (states.every((st) => st.debits === 2)) break;
      await Bun.sleep(100);
    }
    await worker.stop();

    expect(maxOverall).toBeGreaterThanOrEqual(2); // wallets diferentes em paralelo
    expect(maxSameWallet).toBe(1); // nunca duas da mesma wallet ao mesmo tempo
    for (const w of wallets) expect((await snapshot(orm, w.walletId)).debits).toBe(2);
  });

  test("worker morto depois do commit e antes do ack: reentrega não duplica", async () => {
    const w = await createWallet(orm, "100.00");
    const msg = envelope(w, { amount: "25.00" });
    await main.send(msg, w.walletId);

    // cliente que trava para sempre no DeleteMessage: o processo "morreu" ali
    const dyingClient = {
      send: (cmd: unknown, opts?: unknown) =>
        cmd instanceof DeleteMessageCommand ? new Promise(() => {}) : main.client.send(cmd as never, opts as never),
    } as unknown as SQSClient;
    void consumer(useCase(), dyingClient).pollOnce();
    while ((await inboxCount(msg.messageId)) === 0) await Bun.sleep(50); // commit aconteceu

    // a visibilidade (2s) expira, a mensagem volta e outra instância pega
    await Bun.sleep(2_500);
    const outcomes = await consumeAll(consumer());
    expect(outcomes).toEqual(["duplicate"]);
    expect(await snapshot(orm, w.walletId)).toMatchObject({ balance: "75.00", debits: 1 });
  });

  test("ack que falha depois do commit não manda mensagem já processada para a DLQ", async () => {
    options.maxAttempts = 1; // na última tentativa o bug mandava para a DLQ
    const w = await createWallet(orm, "100.00");
    await main.send(envelope(w, { amount: "25.00" }), w.walletId);

    let deletes = 0;
    const flakyAck = {
      send: (cmd: unknown, opts?: unknown) =>
        cmd instanceof DeleteMessageCommand && ++deletes === 1
          ? Promise.reject(new Error("network blip on ack"))
          : main.client.send(cmd as never, opts as never),
    } as unknown as SQSClient;

    expect(await consumer(useCase(), flakyAck).pollOnce()).toEqual(["processed"]);
    expect(await dlq.receiveAll()).toHaveLength(0);

    // sem ack, a mensagem volta depois da visibilidade e a inbox a reconhece
    await Bun.sleep(2_500);
    expect(await consumeAll(consumer())).toEqual(["duplicate"]);
    expect(await snapshot(orm, w.walletId)).toMatchObject({ balance: "75.00", debits: 1 });
  });

  test("consumidor parado e iniciado de novo volta a processar", async () => {
    const worker = consumer();
    worker.start();
    await worker.stop();
    worker.start();

    const w = await createWallet(orm, "100.00");
    await main.send(envelope(w, { amount: "25.00" }), w.walletId);
    const deadline = Date.now() + 8_000;
    while ((await snapshot(orm, w.walletId)).debits === 0 && Date.now() < deadline) await Bun.sleep(200);
    await worker.stop();

    expect((await snapshot(orm, w.walletId)).debits).toBe(1);
  });

  test("parar durante a espera por mensagens não engole a que chegar nesse instante", async () => {
    const w = await createWallet(orm, "100.00");
    const worker = new SqsWagerConsumer(main.client, orm, useCase(), { ...options, waitTimeSeconds: 2, concurrency: 2 });
    worker.start();
    await Bun.sleep(200); // os dois leitores estão esperando mensagens (long polling)

    const stopping = worker.stop();
    await main.send(envelope(w, { amount: "10.00" }), w.walletId); // chega enquanto eles param
    await stopping;

    // a mensagem tem que estar disponível de novo na hora (não presa pela visibilidade de 2s)
    const started = performance.now();
    const outcomes = await consumer().pollOnce();
    expect(outcomes).toEqual(["processed"]);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect((await snapshot(orm, w.walletId)).debits).toBe(1);
  });

  test("SIGTERM: termina a mensagem em andamento e devolve as outras à fila", async () => {
    const w = await createWallet(orm, "100.00");
    for (let i = 0; i < 3; i++) await main.send(envelope(w, { amount: "10.00" }), w.walletId);

    const real = useCase();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const slow = {
      async execute(...args: Parameters<ProcessWagerTransactionUseCase["execute"]>) {
        markStarted();
        await Bun.sleep(300);
        return real.execute(...args);
      },
    };

    const worker = consumer(slow);
    worker.start();
    await started;
    await worker.stop(); // só volta depois de concluir a mensagem em andamento

    expect((await snapshot(orm, w.walletId)).debits).toBe(1);

    // as que não começaram voltaram para a fila e outra instância termina o serviço
    await consumeAll(consumer());
    expect(await snapshot(orm, w.walletId)).toMatchObject({ balance: "70.00", debits: 3 });
  });
});
