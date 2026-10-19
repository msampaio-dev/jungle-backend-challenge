import type { MikroORM } from "@mikro-orm/postgresql";
import { CreateWalletUseCase } from "../../../src/application/wallet/create-wallet.use-case";
import {
  ProcessWagerTransactionUseCase,
  type SubmitWagerCommand,
} from "../../../src/application/wagering/process-wager-transaction.use-case";

export interface TestWallet {
  walletId: string;
  playerId: string;
}

export async function createWallet(orm: MikroORM, initial: string, currency = "BRL"): Promise<TestWallet> {
  const wallet = await new CreateWalletUseCase(orm).execute({
    playerId: Bun.randomUUIDv7(),
    initialBalance: { amount: initial, currency },
  });
  return { walletId: wallet.id, playerId: wallet.playerId };
}

/** Monta um comando válido; cada chamada usa um id externo novo. */
export function command(
  wallet: TestWallet,
  overrides: Partial<SubmitWagerCommand> & { amount?: string } = {},
): SubmitWagerCommand {
  const { amount = "25.00", ...rest } = overrides;
  const externalTransactionId = rest.externalTransactionId ?? `ext-${Bun.randomUUIDv7()}`;
  const providerId = rest.providerId ?? "provider-a";
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount, currency: "BRL" },
    ...rest,
  };
}

export const processor = (orm: MikroORM) => new ProcessWagerTransactionUseCase(orm);

/** Estado da carteira lido direto do banco, com o saldo reconstruído pelo ledger. */
export async function snapshot(orm: MikroORM, walletId: string) {
  const conn = orm.em.getConnection();
  const [wallet] = await conn.execute("select balance::text as balance, version from wallets where id = ?", [walletId]);
  const [ledger] = await conn.execute(
    `select
       coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(18,2)::text as rebuilt,
       count(*) filter (where direction = 'DEBIT')::int as debits,
       count(*) filter (where direction = 'CREDIT')::int as credits
     from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
  if (!wallet || !ledger) throw new Error(`wallet ${walletId} not found`);
  return {
    balance: String(wallet.balance),
    version: Number(wallet.version),
    rebuilt: String(ledger.rebuilt),
    debits: Number(ledger.debits),
    credits: Number(ledger.credits),
  };
}
