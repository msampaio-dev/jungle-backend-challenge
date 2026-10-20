import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DeleteMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { ConnectionException } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import { type Outcome, SqsWagerConsumer, type SqsConsumerOptions } from "../../src/infrastructure/messaging/sqs-wager-consumer";
import { createTestOrm } from "./support/database";
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
  await orm.close();
});

const useCase = () => new ProcessWagerTransactionUseCase(orm);
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

  test("a mesma mensagem entregue duas vezes produz um único débito", async () => {
    const w = await createWallet(orm, "100.00");
    const msg = envelope(w, { amount: "25.00" });
    await main.send(msg, w.walletId);
    await main.send(msg, w.walletId);

    expect(await consumeAll(consumer())).toEqual(["processed", "duplicate"]);
    expect(await snapshot(orm, w.walletId)).toMatchObject({ balance: "75.00", debits: 1 });
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
    ["dinheiro inválido", (w: TestWallet) => envelope(w, { money: { amount: "1e3", currency: "BRL" } }), "INVALID_MONEY"],
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
