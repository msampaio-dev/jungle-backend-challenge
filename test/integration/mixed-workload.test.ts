import { afterAll, beforeAll, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { WalletQueries } from "../../src/application/queries/wallet-queries";
import { PendingReferenceWorker } from "../../src/application/wagering/pending-reference-worker";
import {
  ProcessWagerTransactionUseCase,
  type SubmitWagerCommand,
} from "../../src/application/wagering/process-wager-transaction.use-case";
import { createTestOrm } from "./support/database";
import { command, createWallet } from "./support/fixtures";

/**
 * Carga mista em paralelo e fora de ordem: apostas, prêmios, devoluções e
 * rollbacks (parte deles chegando ANTES da aposta), repetições da mesma
 * requisição e o worker resolvendo pendentes. No fim, as invariantes do
 * desafio têm que valer em todas as wallets.
 */
let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  await orm.close();
});

// gerador determinístico: a mesma semente reproduz a mesma carga
function random(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

test("invariantes valem depois de uma carga mista, concorrente e fora de ordem", async () => {
  const rnd = random(42);
  const useCase = new ProcessWagerTransactionUseCase(orm);
  const commands: SubmitWagerCommand[] = [];

  const wallets = await Promise.all(Array.from({ length: 8 }, () => createWallet(orm, "200.00")));
  for (const w of wallets) {
    for (let i = 0; i < 6; i++) {
      const amount = `${10 + Math.floor(rnd() * 40)}.00`;
      const bet = command(w, { amount, roundId: `round-${i}` });
      commands.push(bet);
      if (rnd() < 0.5) commands.push(command(w, { kind: "WIN", amount: "15.00", roundId: `round-${i}`, referenceExternalTransactionId: bet.externalTransactionId }));
      const reversal = rnd();
      const ref = { amount, roundId: `round-${i}`, referenceExternalTransactionId: bet.externalTransactionId };
      if (reversal < 0.3) commands.push(command(w, { kind: "REFUND", ...ref }));
      else if (reversal < 0.5) commands.push(command(w, { kind: "ROLLBACK", ...ref }));
      else if (reversal < 0.7) {
        // as duas: só uma pode valer
        commands.push(command(w, { kind: "REFUND", ...ref }));
        commands.push(command(w, { kind: "ROLLBACK", ...ref }));
      }
    }
  }
  // repetições da mesma requisição (idempotência no meio da bagunça)
  const duplicates = commands.filter(() => rnd() < 0.25);
  const all = [...commands, ...duplicates];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }

  await Promise.all(all.map((c) => useCase.execute(c)));

  // tudo que ficou esperando referência agora tem a referência: o worker resolve
  const worker = new PendingReferenceWorker(orm, useCase, { batchSize: 100, idleDelayMs: 0, leaseMs: 30_000, maxResolutionFailures: 5 });
  for (let round = 0; round < 5; round++) {
    await orm.em.getConnection().execute("update wager_transactions set next_attempt_at = now() where status = 'PENDING_REFERENCE'");
    if ((await worker.runOnce()).length === 0) break;
  }

  const sql = (q: string, p: unknown[] = []) => orm.em.getConnection().execute(q, p);
  const queries = new WalletQueries(orm);

  // 1. nada ficou pendente
  expect(await sql("select id from wager_transactions where status = 'PENDING_REFERENCE'")).toHaveLength(0);
  // 2. cada requisição gerou exatamente uma transação (repetições viraram replay)
  const [{ n }] = (await sql("select count(*)::int as n from wager_transactions where kind <> 'OPENING'")) as [{ n: number }];
  expect(n).toBe(commands.length);
  // 3. nenhuma aposta revertida duas vezes
  expect(
    await sql(`select reference_transaction_id from wager_transactions
                where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK') and reference_transaction_id is not null
                group by reference_transaction_id having count(*) > 1`),
  ).toHaveLength(0);
  // 4. saldo = ledger, encadeamento íntegro e nunca negativo, em todas as wallets
  for (const w of wallets) {
    const result = await queries.reconcile(w.walletId);
    expect(result).toMatchObject({ consistent: true, chainBreaks: 0 });
    expect(result.storedBalance.amount.startsWith("-")).toBe(false);
  }
}, 60_000);
