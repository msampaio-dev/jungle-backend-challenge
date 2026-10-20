import { Migration } from "@mikro-orm/migrations";

/**
 * Toda transação em PENDING_REFERENCE precisa de next_attempt_at: é por
 * ele que o worker encontra o que reprocessar. Sem a data, ela ficaria
 * pendente para sempre sem ninguém olhar.
 */
export class Migration20261020060000PendingReferenceSchedule extends Migration {
  override up(): void {
    // pendentes gravadas antes desta versão: entram na fila imediatamente
    this.addSql(`
      update wager_transactions
         set next_attempt_at = now(), attempts = greatest(attempts, 1)
       where status = 'PENDING_REFERENCE' and next_attempt_at is null;
    `);
    this.addSql(`
      alter table wager_transactions add constraint wager_tx_pending_reference_schedule_ck
        check (status <> 'PENDING_REFERENCE' or next_attempt_at is not null);
    `);
  }

  override down(): void {
    this.addSql(`alter table wager_transactions drop constraint wager_tx_pending_reference_schedule_ck;`);
  }
}
