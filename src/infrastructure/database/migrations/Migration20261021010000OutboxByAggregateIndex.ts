import { Migration } from "@mikro-orm/migrations";

/**
 * O relay escolhe wallets pela mensagem pendente mais antiga de cada uma
 * (distinct on aggregate_id). Índice parcial: só as pendentes, como o
 * outbox_pending_idx.
 */
export class Migration20261021010000OutboxByAggregateIndex extends Migration {
  override up(): void {
    this.addSql(`
      create index outbox_pending_by_aggregate_idx
        on outbox_messages (aggregate_id, occurred_at, id)
        where published_at is null;
    `);
  }

  override down(): void {
    this.addSql(`drop index outbox_pending_by_aggregate_idx;`);
  }
}
