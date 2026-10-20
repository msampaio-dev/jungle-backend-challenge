import { Migration } from "@mikro-orm/migrations";

/**
 * Busca das pendentes que apontam para uma transação recém-resolvida, para
 * antecipar a próxima checagem delas. Índice parcial: só as pendentes.
 */
export class Migration20261021000000PendingByReferenceIndex extends Migration {
  override up(): void {
    this.addSql(`
      create index wager_tx_pending_by_reference_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';
    `);
  }

  override down(): void {
    this.addSql(`drop index wager_tx_pending_by_reference_idx;`);
  }
}
