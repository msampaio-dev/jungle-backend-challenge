import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { EventPublisher } from "../../src/application/outbox/event-publisher";
import { OutboxRelay } from "../../src/application/outbox/outbox-relay";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import type { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { createOrmConfig } from "../../src/infrastructure/database/mikro-orm.config";
import { OutboxRepository } from "../../src/infrastructure/database/outbox.repository";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs";
import { createTestOrm } from "./support/database";
import { expectLedgerInvariant } from "./support/invariant";
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
  // a limpeza roda mesmo se a invariante falhar (senão processos e conexões ficariam vivos)
  try {
    await expectLedgerInvariant(orm); // invariante final da seção 13, em toda wallet
  } finally {
    await queue.delete();
    await orm.close();
  }
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

const idsInOrder = async (walletId: string) =>
  (await sql("select id from outbox_messages where aggregate_id = ? order by occurred_at, id", [walletId])).map((r) => String(r.id));

/** Publicador real que registra a ordem de envio; pode falhar uma vez ou travar em eventos escolhidos. */
class OrderPublisher implements EventPublisher {
  readonly sent: OutboxMessage[] = [];
  readonly started = new Set<string>();
  readonly failOnce = new Set<string>();
  readonly holdOn = new Map<string, Promise<void>>();
  async publish(message: OutboxMessage): Promise<void> {
    this.started.add(message.id);
    if (this.failOnce.delete(message.id)) throw new Error("falha momentânea");
    await this.holdOn.get(message.id);
    await sqs.publish(message);
    this.sent.push(message);
  }
  sentFor(walletId: string): string[] {
    return this.sent.filter((m) => m.aggregateId === walletId).map((m) => m.id);
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

  test("SQS fora do ar: o lote para na primeira falha em vez de insistir em todos", async () => {
    await publishEverything();
    const w = await createWallet(orm, "0.00");
    for (let i = 0; i < 5; i++) await processor(orm).execute(command(w, { kind: "LOSS", amount: "0.00" }));

    let calls = 0;
    const down: EventPublisher = { publish: async () => { calls++; throw new Error("sqs down"); } };
    expect(await new OutboxRelay(orm, down).publishBatch()).toEqual({ published: 0, failed: 1 });
    expect(calls).toBe(1);

    const attempts = (await sql("select attempts from outbox_messages where aggregate_id = ? order by occurred_at, id", [w.walletId])).map((r) => r.attempts);
    expect(attempts).toEqual([1, 0, 0, 0, 0]); // os outros não gastaram tentativa
    // e esperam o primeiro: nenhum evento desta wallet passa na frente dele
    expect((await new OutboxRelay(orm, sqs).publishBatch()).published).toBe(0);

    // passado o backoff, saem os cinco (e a outbox fica limpa para os próximos testes)
    await sql("update outbox_messages set next_attempt_at = now() where aggregate_id = ? and published_at is null", [w.walletId]);
    expect((await new OutboxRelay(orm, sqs).publishBatch()).published).toBe(5);
  });

  test("ordem por wallet: evento em backoff segura os seguintes da mesma wallet, não os de outra", async () => {
    await publishEverything();
    const w = await createWallet(orm, "0.00");
    const other = await createWallet(orm, "0.00");
    await processor(orm).execute(command(w, { kind: "WIN", amount: "10.00" })); // 2 eventos
    await processor(orm).execute(command(w, { kind: "LOSS", amount: "0.00" })); // 1 evento
    await processor(orm).execute(command(other, { kind: "LOSS", amount: "0.00" }));
    const recorded = await idsInOrder(w.walletId);

    const publisher = new OrderPublisher();
    publisher.failOnce.add(recorded[0]!); // o primeiro evento da wallet falha uma vez
    const relay = new OutboxRelay(orm, publisher, { batchSize: 100, idleDelayMs: 0 });
    await relay.publishBatch(); // falha no primeiro e para o lote
    await relay.publishBatch(); // a wallet espera o backoff; a outra segue
    expect(publisher.sentFor(w.walletId)).toEqual([]);
    expect(publisher.sentFor(other.walletId)).toHaveLength(1);

    await sql("update outbox_messages set next_attempt_at = now() where aggregate_id = ? and published_at is null", [w.walletId]);
    await relay.publishBatch();
    expect(publisher.sentFor(w.walletId)).toEqual(recorded);
  });

  test("a cabeça de cada wallet sai de um índice parcial, só com as pendentes", async () => {
    const [index] = await sql("select indexdef from pg_indexes where indexname = 'outbox_pending_by_aggregate_idx'");
    expect(index?.indexdef).toContain("(aggregate_id, occurred_at, id) WHERE (published_at IS NULL)");
  });

  test("ordem por wallet: mensagem do meio em backoff segura as que vêm depois dela", async () => {
    await publishEverything();
    const w = await createWallet(orm, "0.00");
    for (let i = 0; i < 3; i++) await processor(orm).execute(command(w, { kind: "LOSS", amount: "0.00" }));
    const recorded = await idsInOrder(w.walletId);
    await sql("update outbox_messages set next_attempt_at = now() + interval '1 hour' where id = ?", [recorded[1]]);

    const publisher = new OrderPublisher();
    await new OutboxRelay(orm, publisher, { batchSize: 100, idleDelayMs: 0 }).publishBatch();
    expect(publisher.sentFor(w.walletId)).toEqual([recorded[0]!]); // a cabeça sai; a terceira espera a segunda

    await sql("update outbox_messages set next_attempt_at = now() where id = ?", [recorded[1]]);
    await new OutboxRelay(orm, publisher, { batchSize: 100, idleDelayMs: 0 }).publishBatch();
    expect(publisher.sentFor(w.walletId)).toEqual(recorded);
  });

  test("ordem por wallet: dois relays não publicam a mesma wallet ao mesmo tempo, mas wallets diferentes sim", async () => {
    await publishEverything();
    const w = await createWallet(orm, "0.00");
    const other = await createWallet(orm, "0.00");
    await processor(orm).execute(command(w, { kind: "LOSS", amount: "0.00" }));
    await processor(orm).execute(command(w, { kind: "LOSS", amount: "0.00" }));
    await processor(orm).execute(command(other, { kind: "LOSS", amount: "0.00" }));
    const recorded = await idsInOrder(w.walletId);

    // o primeiro relay trava no primeiro evento de w, segurando a wallet
    const publisher = new OrderPublisher();
    let release!: () => void;
    publisher.holdOn.set(recorded[0]!, new Promise<void>((resolve) => (release = resolve)));
    const first = new OutboxRelay(orm, publisher, { batchSize: 1, idleDelayMs: 0 }).publishBatch();
    while (!release || !publisher.started.has(recorded[0]!)) await Bun.sleep(10);

    // o segundo pula w inteira (não só o evento travado) e publica a outra wallet
    expect((await new OutboxRelay(orm, publisher, { batchSize: 100, idleDelayMs: 0 }).publishBatch()).published).toBe(1);
    expect(publisher.sentFor(w.walletId)).toEqual([]);
    expect(publisher.sentFor(other.walletId)).toHaveLength(1);

    release();
    await first;
    await new OutboxRelay(orm, publisher, { batchSize: 100, idleDelayMs: 0 }).publishBatch();
    expect(publisher.sentFor(w.walletId)).toEqual(recorded);
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
    // o processo que vai morrer tem o próprio pool, de UMA conexão: assim sabemos qual matar
    const poolMax = process.env.DATABASE_POOL_MAX;
    process.env.DATABASE_POOL_MAX = "1";
    const dyingOrm = await MikroORM.init(createOrmConfig(process.env.DATABASE_TEST_URL));
    // atribuir undefined a process.env grava o texto "undefined": se não existia, apaga
    if (poolMax === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = poolMax;
    const [{ pid }] = (await dyingOrm.em.getConnection().execute("select pg_backend_pid() as pid")) as [{ pid: number }];
    const dying = new OutboxRelay(dyingOrm, stuck).publishBatch();
    const outcome = dying.then(
      () => "committed",
      () => "died",
    );
    while (sent.length === 0) await Bun.sleep(20);

    // enquanto ele segura o lock, outra instância não pega o mesmo evento
    expect((await new OutboxRelay(orm, sqs).publishBatch()).published).toBe(0);

    // "kill -9": o Postgres derruba a conexão do processo que travou
    const [killed] = await sql("select pg_terminate_backend(?) as ok", [pid]);
    expect(killed!.ok).toBe(true);
    release();
    // processo morto não confirma nada; e se o driver nem responder, tanto faz: ele morreu
    expect(await Promise.race([outcome, Bun.sleep(5_000).then(() => "died")])).toBe("died");
    void dyingOrm.close(true).catch(() => {});

    // o lock foi solto e o evento continua pendente: at-least-once
    const counter = new CountingPublisher();
    expect((await new OutboxRelay(orm, counter).publishBatch()).published).toBe(1);
    expect(counter.sent.get(sent[0]!)).toBe(1); // segunda entrega do mesmo eventId
  });
});

