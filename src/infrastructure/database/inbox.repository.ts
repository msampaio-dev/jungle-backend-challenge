import type { EntityManager } from "@mikro-orm/postgresql";
import { InboxMessage } from "../../domain/messaging/inbox-message";

export class InboxRepository {
  async find(em: EntityManager, consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const [row] = await em.execute(
      "select message_id, consumer_name, payload_hash, received_at, processed_at from inbox_messages where consumer_name = ? and message_id = ?",
      [consumerName, messageId],
    );
    if (!row) return null;
    return InboxMessage.rehydrate({
      messageId: String(row.message_id),
      consumerName: String(row.consumer_name),
      payloadHash: String(row.payload_hash),
      receivedAt: new Date(row.received_at),
      processedAt: new Date(row.processed_at),
    });
  }

  /** Dentro da transação da operação. A PK barra o segundo processamento concorrente. */
  async insert(em: EntityManager, message: InboxMessage): Promise<void> {
    await em.execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt],
    );
  }
}
