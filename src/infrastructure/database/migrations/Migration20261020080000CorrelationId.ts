import { Migration } from "@mikro-orm/migrations";

/**
 * correlationId da requisição que criou a transação. Sem ele, os eventos
 * publicados depois pelo worker (resolução de pendente) perdiam o rastro
 * da requisição original. Linhas antigas ficam nulas e usam o próprio id.
 */
export class Migration20261020080000CorrelationId extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add column correlation_id text check (char_length(correlation_id) <= 255);
    `);
  }

  override down(): void {
    this.addSql(`alter table wager_transactions drop column correlation_id;`);
  }
}
