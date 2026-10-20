import { Migration } from "@mikro-orm/migrations";

/** Inbox: deduplicação persistente das mensagens recebidas, por consumidor. */
export class Migration20261020020000Inbox extends Migration {
  override up(): void {
    this.addSql(`
      create table inbox_messages (
        consumer_name  text not null,
        message_id     text not null,
        payload_hash   char(64) not null,
        received_at    timestamptz not null,
        processed_at   timestamptz not null,

        -- a mesma mensagem só produz efeito uma vez por consumidor
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      );
    `);
  }

  override down(): void {
    this.addSql(`drop table inbox_messages;`);
  }
}
