import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { EventPublisher } from "../../src/application/outbox/event-publisher";
import { OutboxRelay } from "../../src/application/outbox/outbox-relay";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import type { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { OutboxRepository } from "../../src/infrastructure/database/outbox.repository";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs";
import { createTestOrm } from "./support/database";
import { command, createWallet, processor, snapshot } from "./support/fixtures";
import { createTestQueue } from "./support/sqs";

let orm: MikroORM;
let queue: Awaited<ReturnType<typeof createTestQueue>>;
let sqs: SqsEventPublisher;

beforeAll(async () => {
  orm = await createTestOrm();
  queue = await createTestQueue("outbox-test");
  sqs = new SqsEventPublisher(queue.client, queue.queueUrl);
});

afterAll(async () => {
  await queue.delete();
  await orm.close();
});

const sql = (query: string, params: unknown[] = []) => orm.em.getConnection().execute(query, params);
const outboxFor = (walletId: string) =>
  sql("select event_type, published_at from outbox_messages where aggregate_id = ? order by occurred_at, event_type", [walletId]);
const pendingCount = async () => Number((await sql("select count(*)::int as n from outbox_messages where published_at is null"))[0]!.n);

/** Esvazia a outbox entre testes, para cada teste contar só o que gerou. */
async function publishEverything(): Promise<void> {
  const relay = new OutboxRelay(orm, sqs, { batchSize: 100, idleDelayMs: 0 });
  while ((await relay.publishBatch()).published > 0);
}

/** Publicador real que conta quantas vezes cada evento foi enviado. */
class CountingPublisher implements EventPublisher {
  readonly sent = new Map<string, number>();
  async publish(message: OutboxMessage): Promise<void> {
    await sqs.publish(message);
    this.sent.set(message.id, (this.sent.get(message.id) ?? 0) + 1);
  }
}

describe("eventos gravados junto com a operação", () => {
  test("BET processada gera WagerTransactionProcessed e WalletBalanceChanged", async () => {
    const w = await createWallet(orm, "100.00");
    await processor(orm).execute(command(w));
    const types = (await outboxFor(w.walletId)).map((r) => r.event_type);
    // 2 da abertura (OPENING) + 2 da aposta
    expect(types.filter((t) => t === "WalletBalanceChanged")).toHaveLength(2);
    expect(types.filter((t) => t === "WagerTransactionProcessed")).toHaveLength(2);
  });

  test("LOSS gera só WagerTransactionProcessed: saldo não mudou", async () => {
    const w = await createWallet(orm, "0.00"); // sem OPENING
    await processor(orm).execute(command(w, { kind: "LOSS", amount: "0.00" }));
    expect((await outboxFor(w.walletId)).map((r) => r.event_type)).toEqual(["WagerTransactionProcessed"]);
  });

  test("rejeição e referência pendente geram seus eventos", async () => {
    const w = await createWallet(orm, "0.00");
    await processor(orm).execute(command(w, { amount: "5.00" }));
    await processor(orm).execute(command(w, { kind: "REFUND", amount: "5.00", referenceExternalTransactionId: "x" }));
    const types = (await outboxFor(w.walletId)).map((r) => r.event_type).sort();
    expect(types).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
  });

  test("replay não gera evento novo", async () => {
    const w = await createWallet(orm, "100.00");
    const bet = command(w);
    await processor(orm).execute(bet);
    const before = (await outboxFor(w.walletId)).length;
    await processor(orm).execute(bet);
    expect(await outboxFor(w.walletId)).toHaveLength(before);
  });

  test("atomicidade: se gravar a outbox falhar, nada da operação fica", async () => {
    const w = await createWallet(orm, "100.00");
    class BrokenOutbox extends OutboxRepository {
      override async insert(): Promise<void> {
        throw new Error("disk full");
      }
    }
    const broken = new ProcessWagerTransactionUseCase(orm, undefined, undefined, new BrokenOutbox());

    await expect(broken.execute(command(w, { externalTransactionId: "atomic-1" }))).rejects.toThrow("disk full");

    const state = await snapshot(orm, w.walletId);
    expect(state).toMatchObject({ balance: "100.00", version: 1, debits: 0 });
    expect(await sql("select 1 from wager_transactions where external_transaction_id = 'atomic-1'")).toHaveLength(0);
  });
});

describe("relay", () => {
  test("publica no SQS com o envelope completo e marca como publicado", async () => {
    await publishEverything();
    const w = await createWallet(orm, "0.00");
    await processor(orm).execute(command(w, { kind: "WIN", amount: "10.00" }));

    const relay = new OutboxRelay(orm, sqs);
    expect((await relay.publishBatch()).published).toBe(2);
    expect((await relay.publishBatch()).published).toBe(0);
    expect((await outboxFor(w.walletId)).every((r) => r.published_at !== null)).toBe(true);

    const bodies = (await queue.drain()).filter((b) => b.aggregateId === w.walletId);
    const changed = bodies.find((b) => b.eventType === "WalletBalanceChanged");
    expect(changed).toMatchObject({
      version: 1,
      data: { balanceBefore: { amount: "0.00" }, balanceAfter: { amount: "10.00" }, walletVersion: 2 },
    });
    expect(changed?.eventId).toBeString();
    expect(changed?.correlationId).toBeString();
  });

  test("falha ao publicar agenda nova tentativa sem perder o evento", async () => {
    await publishEverything();
    const w = await createWallet(orm, "0.00");
    await processor(orm).execute(command(w, { kind: "LOSS", amount: "0.00" }));

    const down: EventPublisher = { publish: async () => Promise.reject(new Error("sqs unavailable")) };
    expect(await new OutboxRelay(orm, down).publishBatch()).toEqual({ published: 0, failed: 1 });

    const [row] = await sql("select attempts, last_error, published_at, next_attempt_at > now() as later from outbox_messages where aggregate_id = ?", [w.walletId]);
    expect(row).toMatchObject({ attempts: 1, last_error: "sqs unavailable", published_at: null, later: true });

    // depois do backoff, outro relay publica
    await sql("update outbox_messages set next_attempt_at = now() where aggregate_id = ?", [w.walletId]);
    expect((await new OutboxRelay(orm, sqs).publishBatch()).published).toBe(1);
  });

  test("dois publicadores na mesma outbox: cada evento sai uma vez", async () => {
    await publishEverything();
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(orm, "100.00")));
    await Promise.all(wallets.flatMap((w) => [1, 2, 3].map(() => processor(orm).execute(command(w, { amount: "1.00" })))));
    const expected = await pendingCount(); // 10 * (2 abertura + 3 * 2 apostas) = 80

    const counter = new CountingPublisher();
    const drainWith = async (relay: OutboxRelay) => {
      while ((await relay.publishBatch()).published > 0);
    };
    await Promise.all([
      drainWith(new OutboxRelay(orm, counter, { batchSize: 7, idleDelayMs: 0 })),
      drainWith(new OutboxRelay(orm, counter, { batchSize: 7, idleDelayMs: 0 })),
    ]);

    expect(expected).toBe(80);
    expect(counter.sent.size).toBe(80);
    expect([...counter.sent.values()].every((n) => n === 1)).toBe(true);
    expect(await pendingCount()).toBe(0);
  });
});

describe("crash", () => {
  test("commit feito e processo morto antes de publicar: outra instância publica", async () => {
    await publishEverything();
    const w = await createWallet(orm, "100.00");
    await processor(orm).execute(command(w)); // commit confirmado; nenhum relay rodou ("processo morreu")

    expect(await pendingCount()).toBe(4);
    const otherInstance = new OutboxRelay(orm, sqs);
    expect((await otherInstance.publishBatch()).published).toBe(4);
  });

  test("processo morre depois de enviar ao SQS e antes do commit: evento volta e sai de novo", async () => {
    await publishEverything();
    const w = await createWallet(orm, "0.00");
    await processor(orm).execute(command(w, { kind: "LOSS", amount: "0.00" }));

    // publicador que envia de verdade e depois trava, segurando a transação aberta
    let release!: () => void;
    const sent: string[] = [];
    const stuck: EventPublisher = {
      async publish(message) {
        await sqs.publish(message);
        sent.push(message.id);
        await new Promise<void>((resolve) => (release = resolve));
      },
    };
    const dying = new OutboxRelay(orm, stuck).publishBatch();
    while (sent.length === 0) await Bun.sleep(20);

    // enquanto ele segura o lock, outra instância não pega o mesmo evento
    expect((await new OutboxRelay(orm, sqs).publishBatch()).published).toBe(0);

    // "kill -9": o Postgres derruba a conexão do processo que travou
    await sql(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where state = 'idle in transaction' and query ilike '%outbox_messages%' and pid <> pg_backend_pid()`,
    );
    release();
    await expect(dying).rejects.toThrow();

    // o lock foi solto e o evento continua pendente: at-least-once
    const counter = new CountingPublisher();
    expect((await new OutboxRelay(orm, counter).publishBatch()).published).toBe(1);
    expect(counter.sent.get(sent[0]!)).toBe(1); // segunda entrega do mesmo eventId
  });
});

