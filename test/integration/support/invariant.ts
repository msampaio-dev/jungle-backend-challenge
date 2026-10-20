import { expect } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";

/** Wallets que um teste corrompe DE PROPÓSITO (para provar que a reconciliação acusa). */
export const intentionallyCorrupted = new Set<string>();

/**
 * Invariante final da seção 13, conferida ao fim de cada arquivo de teste,
 * em TODA wallet do banco: saldo gravado == saldo reconstruído pelo ledger,
 * cada lançamento começa onde o anterior terminou e nenhum saldo é negativo.
 */
export async function expectLedgerInvariant(orm: MikroORM): Promise<void> {
  const rows = await orm.em.getConnection().execute(`
    with ledger as (
      select wallet_id, direction, amount, balance_before,
             lag(balance_after) over (partition by wallet_id order by seq) as previous_after
        from wallet_ledger_entries
    )
    select w.id,
           w.balance::text as stored,
           coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(18,2)::text as rebuilt,
           count(*) filter (where l.balance_before <> coalesce(l.previous_after, 0))::int as breaks
      from wallets w
      left join ledger l on l.wallet_id = w.id
     group by w.id
  `);
  const broken = rows
    .filter((r) => !intentionallyCorrupted.has(String(r.id)))
    .filter((r) => r.stored !== r.rebuilt || Number(r.breaks) > 0 || String(r.stored).startsWith("-"))
    .map((r) => ({ walletId: r.id, stored: r.stored, rebuilt: r.rebuilt, chainBreaks: r.breaks }));
  expect(broken).toEqual([]);
}
