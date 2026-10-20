import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { WalletQueries } from "../../src/application/queries/wallet-queries";
import { createTestOrm } from "./support/database";
import { expectLedgerInvariant } from "./support/invariant";
import { type AppProcess, callWithRetry, startAppProcess } from "./support/processes";
import { createTestQueue } from "./support/sqs";

/**
 * Seção 13, item 4: três processos de verdade (não três instâncias no mesmo
 * processo), cada um com pool, consumidor SQS, relay da outbox e worker de
 * pendentes próprios, sobre o mesmo banco e as mesmas filas.
 */
let orm: MikroORM;
let apps: AppProcess[];
let main: Awaited<ReturnType<typeof createTestQueue>>;
let dlq: Awaited<ReturnType<typeof createTestQueue>>;
let events: Awaited<ReturnType<typeof createTestQueue>>;

beforeAll(async () => {
  orm = await createTestOrm();
  dlq = await createTestQueue("mp-dlq");
  main = await createTestQueue("mp-main", { VisibilityTimeout: "5" });
  events = await createTestQueue("mp-events");
  const env = {
    DATABASE_URL: process.env.DATABASE_TEST_URL!,
    SQS_QUEUE_URL: main.queueUrl,
    SQS_DLQ_URL: dlq.queueUrl,
    SQS_EVENTS_QUEUE_URL: events.queueUrl,
    SQS_CONSUMER_CONCURRENCY: "3",
  };
  apps = await Promise.all([1, 2, 3].map(() => startAppProcess(env)));
}, 60_000);

afterAll(async () => {
  // a limpeza roda mesmo se a invariante falhar (senão processos e conexões ficariam vivos)
  try {
    await expectLedgerInvariant(orm); // invariante final da seção 13, em toda wallet
  } finally {
    await Promise.all(apps.map((a) => a.kill()));
    await Promise.all([main.delete(), dlq.delete(), events.delete()]);
    await orm.close();
  }
});

const urls = () => apps.map((a) => a.url);
const sql = (q: string, p: unknown[] = []) => orm.em.getConnection().execute(q, p);

async function newWallet(amount: string) {
  const playerId = crypto.randomUUID();
  const res = await callWithRetry(urls, "POST", "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  return { walletId: res.body.id as string, playerId };
}

function bet(w: { walletId: string; playerId: string }, amount: string, target: string, ext = `mp-${crypto.randomUUID()}`, extra = {}) {
  return callWithRetry(
    () => [target],
    "POST",
    "/wagering/transactions",
    { providerId: "provider-a", externalTransactionId: ext, playerId: w.playerId, walletId: w.walletId, roundId: "r", gameId: "g", kind: "BET", money: { amount, currency: "BRL" }, ...extra },
    { "Idempotency-Key": `provider-a:${ext}` },
  );
}

async function until(condition: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(200);
  }
}

describe("três processos sobre o mesmo banco", () => {
  test("100 − 80 − 80 com as apostas em processos diferentes: uma passa, a outra não", async () => {
    const w = await newWallet("100.00");
    const [a, b] = await Promise.all([bet(w, "80.00", apps[0]!.url), bet(w, "80.00", apps[1]!.url)]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect((await new WalletQueries(orm).reconcile(w.walletId)).storedBalance.amount).toBe("20.00");
  });

  test("a mesma aposta 50 vezes espalhada pelos três: um único débito", async () => {
    const w = await newWallet("100.00");
    const ext = `mp-${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => bet(w, "5.00", apps[i % 3]!.url, ext)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    const [{ debits }] = (await sql("select count(*)::int as debits from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [w.walletId])) as [{ debits: number }];
    expect(debits).toBe(1);
  });

  test("carga concorrente em 10 wallets pelos três processos: saldo e ledger batem", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet("100.00")));
    const results = await Promise.all(
      wallets.flatMap((w, wi) => Array.from({ length: 30 }, (_, i) => bet(w, "5.00", apps[(wi + i) % 3]!.url))),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(10 * 20); // 20 de 5,00 cabem em 100,00
    expect(results.filter((r) => r.status === 422)).toHaveLength(10 * 10);
    const queries = new WalletQueries(orm);
    for (const w of wallets) {
      expect(await queries.reconcile(w.walletId)).toMatchObject({ consistent: true, chainBreaks: 0, storedBalance: { amount: "0.00" } });
    }
  });
});

describe("três consumidores, relays e workers ao mesmo tempo", () => {
  test("mensagens de 10 wallets: cada uma processada uma vez, na ordem de cada wallet", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet("100.00")));
    const sent: string[] = [];
    for (const w of wallets) {
      for (const amount of ["1.00", "2.00", "3.00"]) {
        const ext = `mp-sqs-${crypto.randomUUID()}`;
        sent.push(ext);
        await main.send(
          {
            messageId: `m-${ext}`,
            type: "WagerTransactionRequested",
            data: { providerId: "provider-a", externalTransactionId: ext, idempotencyKey: `provider-a:${ext}`, playerId: w.playerId, walletId: w.walletId, roundId: "r", gameId: "g", kind: "BET", money: { amount, currency: "BRL" } },
          },
          w.walletId,
        );
      }
    }

    await until(async () => {
      const [{ n }] = (await sql("select count(*)::int as n from wager_transactions where external_transaction_id = any(?::text[])", [`{${sent.join(",")}}`])) as [{ n: number }];
      return n === sent.length;
    });

    for (const w of wallets) {
      const amounts = (await sql(
        "select amount::text as a from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT' order by seq",
        [w.walletId],
      )).map((r) => r.a);
      expect(amounts).toEqual(["1.00", "2.00", "3.00"]); // ordem preservada por wallet
    }
    const [{ inbox }] = (await sql("select count(*)::int as inbox from inbox_messages where message_id = any(?::text[])", [`{${sent.map((e) => `m-${e}`).join(",")}}`])) as [{ inbox: number }];
    expect(inbox).toBe(sent.length);
    expect(await dlq.receiveAll()).toHaveLength(0);
  });

  test("REFUND num processo antes da BET em outro: algum worker resolve", async () => {
    const w = await newWallet("100.00");
    const betExt = `mp-bet-${crypto.randomUUID()}`;
    const refund = await bet(w, "30.00", apps[0]!.url, undefined, { kind: "REFUND", referenceExternalTransactionId: betExt });
    expect(refund.status).toBe(202);
    expect((await bet(w, "30.00", apps[1]!.url, betExt)).status).toBe(201);

    await until(async () => {
      const [row] = await sql("select status from wager_transactions where id = ?", [refund.body.transactionId]);
      return row?.status === "PROCESSED";
    });
    expect((await new WalletQueries(orm).reconcile(w.walletId)).storedBalance.amount).toBe("100.00");
  });

  test("os três relays esvaziam a outbox e cada evento chega à fila", async () => {
    await until(async () => {
      const [{ n }] = (await sql("select count(*)::int as n from outbox_messages where published_at is null")) as [{ n: number }];
      return n === 0;
    });
    const [{ total }] = (await sql("select count(*)::int as total from outbox_messages")) as [{ total: number }];
    const received = new Set((await events.drain()).map((e) => e.eventId));
    expect(received.size).toBe(total);
  });
});
