import { Migration } from "@mikro-orm/migrations";

/**
 * Identificadores vindos dos provedores têm tamanho máximo. Sem isso, um
 * texto de alguns KB estourava o limite de linha do índice B-tree (~2,7 KB)
 * e virava erro 500 em vez de payload inválido.
 */
export class Migration20261020040000IdentifierLength extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions add constraint wager_tx_identifier_length_ck check (
        char_length(provider_id) <= 255 and
        char_length(external_transaction_id) <= 255 and
        char_length(idempotency_key) <= 255 and
        char_length(coalesce(round_id, '')) <= 255 and
        char_length(coalesce(game_id, '')) <= 255 and
        char_length(coalesce(reference_external_transaction_id, '')) <= 255
      );
    `);
    this.addSql(`
      alter table inbox_messages add constraint inbox_identifier_length_ck check (
        char_length(consumer_name) <= 255 and char_length(message_id) <= 255
      );
    `);
  }

  override down(): void {
    this.addSql(`alter table inbox_messages drop constraint inbox_identifier_length_ck;`);
    this.addSql(`alter table wager_transactions drop constraint wager_tx_identifier_length_ck;`);
  }
}
