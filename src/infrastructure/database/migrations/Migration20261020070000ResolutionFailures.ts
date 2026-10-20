import { Migration } from "@mikro-orm/migrations";

/**
 * Falhas não transitórias ao resolver uma pendente (erro de programação,
 * dado inesperado). Passado o limite, a transação vira FAILED em vez de
 * ser tentada para sempre; last_error fica para auditoria.
 */
export class Migration20261020070000ResolutionFailures extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add column resolution_failures integer not null default 0 check (resolution_failures >= 0),
        add column last_error text;
    `);
  }

  override down(): void {
    this.addSql(`alter table wager_transactions drop column last_error, drop column resolution_failures;`);
  }
}
