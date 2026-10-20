import type { EntityManager } from "@mikro-orm/postgresql";
import { OutboxMessage } from "../../domain/messaging/outbox-message";

type Row = Record<string, unknown>;

export class OutboxRepository {
  /** Chamado dentro da transação da operação de negócio. */
  async insert(em: EntityManager, messages: OutboxMessage[]): Promise<void> {
    for (const m of messages) {
      await em.execute(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         values (?, ?, ?, ?::jsonb, ?, ?, ?)`,
        [m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), m.occurredAt, m.attempts, m.nextAttemptAt ?? m.occurredAt],
      );
    }
  }

  /**
   * Trava um lote de mensagens devidas. SKIP LOCKED faz outra instância
   * pular as que já estão travadas e pegar as próximas, em vez de esperar.
   * O lock vale até o fim da transação; se o processo morrer, o Postgres
   * desfaz e as mensagens voltam a ficar disponíveis.
   */
  async claimDue(em: EntityManager, limit: number): Promise<OutboxMessage[]> {
    const rows: Row[] = await em.execute(
      `select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
         from outbox_messages
        where published_at is null and next_attempt_at <= now()
        order by occurred_at, id
        limit ?
        for update skip locked`,
      [limit],
    );
    return rows.map((r) =>
      OutboxMessage.rehydrate({
        id: String(r.id),
        aggregateId: String(r.aggregate_id),
        eventType: String(r.event_type),
        payload: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>,
        occurredAt: new Date(r.occurred_at as string),
        attempts: Number(r.attempts),
        nextAttemptAt: new Date(r.next_attempt_at as string),
        publishedAt: undefined,
      }),
    );
  }

  async save(em: EntityManager, message: OutboxMessage, lastError?: string): Promise<void> {
    await em.execute(
      `update outbox_messages
          set attempts = ?, next_attempt_at = ?, published_at = ?, last_error = ?
        where id = ?`,
      [message.attempts, message.nextAttemptAt ?? new Date(), message.publishedAt ?? null, lastError ?? null, message.id],
    );
  }
}
