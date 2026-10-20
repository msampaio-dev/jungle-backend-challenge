import { Migration } from "@mikro-orm/migrations";

/**
 * Uma transação só pode ser revertida UMA vez, qualquer que seja o tipo.
 * O índice anterior era por (referência, tipo) e deixava REFUND + ROLLBACK
 * da mesma BET devolverem o valor duas vezes (crédito duplicado).
 */
export class Migration20261020030000SingleReversal extends Migration {
  override up(): void {
    this.addSql(`drop index wager_tx_one_reversal_per_reference_uq;`);
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
  }

  override down(): void {
    this.addSql(`drop index wager_tx_single_reversal_uq;`);
    this.addSql(`
      create unique index wager_tx_one_reversal_per_reference_uq
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
  }
}
