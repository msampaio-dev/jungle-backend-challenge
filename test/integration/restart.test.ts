import { afterAll, beforeAll, expect, test } from "bun:test";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { WalletQueries } from "../../src/application/queries/wallet-queries";
import { createTestOrm } from "./support/database";
import { type AppProcess, callWithRetry, startAppProcess } from "./support/processes";
import { createTestQueue } from "./support/sqs";

/**
 * Seção 13, item 8 e "recuperação após reinicialização": carga mista em
 * três processos, kill -9 em um deles no meio, um processo novo no lugar,
 * e a consistência final conferida por conta fechada.
 */
let orm: MikroORM;
let apps: AppProcess[] = [];
let env: Record<string, string>;
let main: Awaited<ReturnType<typeof createTestQueue>>;
let dlq: Awaited<ReturnType<typeof createTestQueue>>;
let events: Awaited<ReturnType<typeof createTestQueue>>;

beforeAll(async () => {
  orm = await createTestOrm();
  dlq = await createTestQueue("rs-dlq");
  main = await createTestQueue("rs-main", { VisibilityTimeout: "5" });
  events = await createTestQueue("rs-events");
  env = {
    DATABASE_URL: process.env.DATABASE_TEST_URL!,
    SQS_QUEUE_URL: main.queueUrl,
    SQS_DLQ_URL: dlq.queueUrl,
    SQS_EVENTS_QUEUE_URL: events.queueUrl,
    SQS_CONSUMER_CONCURRENCY: "3",
  };
  apps = await Promise.all([1, 2, 3].map(() => startAppProcess(env)));
}, 60_000);

afterAll(async () => {
  await Promise.all(apps.map((a) => a.kill()));
  await Promise.all([main.delete(), dlq.delete(), events.delete()]);
  await orm.close();
});

const sql = (q: string, p: unknown[] = []) => orm.em.getConnection().execute(q, p);
const one = async <T>(q: string, p: unknown[] = []) => ((await sql(q, p)) as T[])[0]!;
const live = () => apps.map((a) => a.url);

test("kill -9 em um dos três processos no meio da carga: nada perdido, nada duplicado", async () => {
  const WALLETS = 8;
  const BETS = 15;
  const wallets = await Promise.all(
    Array.from({ length: WALLETS }, async () => {
      const playerId = crypto.randomUUID();
      const res = await callWithRetry(live, "POST", "/wallets", { playerId, initialBalance: { amount: "200.00", currency: "BRL" } });
      return { walletId: res.body.id as string, playerId };
    }),
  );

  const httpExternalIds: string[] = [];
  const send = (w: (typeof wallets)[number], kind: string, amount: string, ext: string, reference?: string) => {
    httpExternalIds.push(ext);
    return callWithRetry(
      live,
      "POST",
      "/wagering/transactions",
      {
        providerId: "provider-a", externalTransactionId: ext, playerId: w.playerId, walletId: w.walletId,
        roundId: "r", gameId: "g", kind, money: { amount, currency: "BRL" },
        ...(reference ? { referenceExternalTransactionId: reference } : {}),
      },
      { "Idempotency-Key": `provider-a:${ext}` },
      60_000,
    );
  };

  // REFUNDs que chegam ANTES das apostas que devolvem (o worker resolve depois)
  const refundedBets = wallets.flatMap((w) => [1, 2, 3].map(() => ({ w, ext: `rs-rbet-${crypto.randomUUID()}` })));
  await Promise.all(refundedBets.map(({ w, ext }) => send(w, "REFUND", "5.00", `rs-ref-${crypto.randomUUID()}`, ext)));

  // mensagens pela fila: 3 apostas de 1,00 por wallet, enviadas em paralelo
  // com as rodadas HTTP, para os consumidores estarem trabalhando no kill
  const sqsMessageIds: string[] = [];
  const sqsSends: Array<() => Promise<void>> = [];
  for (const w of wallets) {
    for (let i = 0; i < 3; i++) {
      const ext = `rs-sqs-${crypto.randomUUID()}`;
      sqsMessageIds.push(`m-${ext}`);
      sqsSends.push(() =>
        main.send(
          {
            messageId: `m-${ext}`, type: "WagerTransactionRequested",
            data: { providerId: "provider-a", externalTransactionId: ext, idempotencyKey: `provider-a:${ext}`, playerId: w.playerId, walletId: w.walletId, roundId: "r", gameId: "g", kind: "BET", money: { amount: "1.00", currency: "BRL" } },
          },
          w.walletId,
        ),
      );
    }
  }

  // apostas em rodadas; na rodada 5, kill -9 COM a rodada em andamento
  let retried = 0;
  let committedBeforeKill = 0;
  for (let round = 0; round < BETS; round++) {
    void Promise.all(sqsSends.splice(0, 2).map((sendMessage) => sendMessage()));
    const inFlight = Promise.all(wallets.map((w) => send(w, "BET", "2.00", `rs-bet-${crypto.randomUUID()}`)));
    if (round === 5) {
      await Bun.sleep(15); // requisições já saíram e estão sendo processadas
      const victim = apps[1]!;
      apps = apps.filter((a) => a !== victim);
      await victim.kill(); // sem shutdown: o que estava em andamento morre junto
      void startAppProcess(env).then((fresh) => apps.push(fresh)); // a réplica nova entra quando ficar pronta
    }
    const results = await inFlight;
    const resent = results.filter((r) => r.attempts > 1);
    retried += resent.length;
    // reenvio que voltou como replay: o processo morreu DEPOIS do commit
    committedBeforeKill += resent.filter((r) => r.body?.idempotentReplay).length;
  }
  await Promise.all(sqsSends.splice(0).map((sendMessage) => sendMessage()));
  // as apostas que os REFUNDs esperavam
  await Promise.all(refundedBets.map(({ w, ext }) => send(w, "BET", "5.00", ext)));

  // assentar: nada pendente, outbox vazia, fila principal vazia
  const deadline = Date.now() + 120_000;
  for (;;) {
    const { pending } = await one<{ pending: number }>("select count(*)::int as pending from wager_transactions where status = 'PENDING_REFERENCE'");
    const { outbox } = await one<{ outbox: number }>("select count(*)::int as outbox from outbox_messages where published_at is null");
    const { Attributes = {} } = await main.client.send(
      new GetQueueAttributesCommand({ QueueUrl: main.queueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }),
    );
    const inQueue = Number(Attributes.ApproximateNumberOfMessages) + Number(Attributes.ApproximateNumberOfMessagesNotVisible);
    if (pending === 0 && outbox === 0 && inQueue === 0) break;
    if (Date.now() > deadline) throw new Error(`não assentou: pendentes=${pending} outbox=${outbox} fila=${inQueue}`);
    await Bun.sleep(500);
  }
  console.log(
    `requisições HTTP reenviadas por causa do kill: ${retried} ` +
      `(${committedBeforeKill} já tinham sido confirmadas e voltaram como replay; ${retried - committedBeforeKill} morreram antes do commit)`,
  );
  // sem isso o teste não provaria nada: o kill tem que ter pego requisição no meio
  expect(retried).toBeGreaterThan(0);

  // 1. cada requisição HTTP virou exatamente uma transação, já resolvida
  const { httpTx, httpDistinct } = await one<{ httpTx: number; httpDistinct: number }>(
    "select count(*)::int as \"httpTx\", count(distinct external_transaction_id)::int as \"httpDistinct\" from wager_transactions where external_transaction_id = any(?::text[])",
    [`{${httpExternalIds.join(",")}}`],
  );
  expect(httpDistinct).toBe(new Set(httpExternalIds).size);
  expect(httpTx).toBe(httpDistinct);

  // 2. cada mensagem SQS processada exatamente uma vez
  const { inbox } = await one<{ inbox: number }>("select count(*)::int as inbox from inbox_messages where message_id = any(?::text[])", [`{${sqsMessageIds.join(",")}}`]);
  expect(inbox).toBe(sqsMessageIds.length);
  expect(await dlq.receiveAll()).toHaveLength(0);

  // 3. nenhuma reversão duplicada e nada fora de PROCESSED (nenhuma aposta excede o saldo)
  const { notProcessed } = await one<{ notProcessed: number }>(
    "select count(*)::int as \"notProcessed\" from wager_transactions where wallet_id = any(?::uuid[]) and status <> 'PROCESSED'",
    [`{${wallets.map((w) => w.walletId).join(",")}}`],
  );
  expect(notProcessed).toBe(0);

  // 4. conta fechada por wallet: 200 - 15x2 - 3x1 (BET 5 e REFUND 5 se anulam) = 167
  const queries = new WalletQueries(orm);
  for (const w of wallets) {
    expect(await queries.reconcile(w.walletId)).toMatchObject({
      consistent: true,
      chainBreaks: 0,
      storedBalance: { amount: "167.00" },
    });
  }
}, 240_000);
