import type { EntityManager } from "@mikro-orm/postgresql";
import { OutboxMessage } from "../../domain/messaging/outbox-message";

type Row = Record<string, unknown>;

/** Primeira chave dos advisory locks da outbox, para não colidir com outros usos. */
const OUTBOX_LOCK_NAMESPACE = 7001;

export class OutboxRepository {
  /**
   * Chamado dentro da transação da operação de negócio. Evento novo nasce
   * devido AGORA no relógio do banco (o mesmo que o claimDue compara), não
   * no relógio da máquina que o criou: senão uma app adiantada atrasaria a
   * publicação pelo tamanho da diferença.
   */
  async insert(em: EntityManager, messages: OutboxMessage[]): Promise<void> {
    for (const m of messages) {
      await em.execute(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         values (?, ?, ?, ?::jsonb, ?, ?, clock_timestamp())`,
        [m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), m.occurredAt, m.attempts],
      );
    }
  }

  /**
   * Trava um lote de wallets e devolve as mensagens pendentes delas, na
   * ordem em que aconteceram. A unidade é a wallet, não a mensagem: travar
   * mensagens soltas deixava um evento passar na frente de outro da mesma
   * wallet (o anterior travado por outro relay, ou em backoff).
   *
   *  - só entra wallet cuja mensagem pendente mais antiga (a cabeça) está
   *    devida: cabeça em backoff segura a wallet inteira;
   *  - pg_try_advisory_xact_lock por wallet: se outro relay já está com ela,
   *    pula para a próxima em vez de esperar (o SKIP LOCKED, por wallet).
   *    Vale até o fim da transação; se o processo morrer, o Postgres solta.
   *
   * O lock é tentado na ordem das cabeças e só até completar o limite (CTE
   * materializada, LIMIT por fora). Colisão de hash entre duas wallets só
   * faz as duas esperarem uma pela outra.
   */
  async claimDue(em: EntityManager, limit: number): Promise<OutboxMessage[]> {
    const wallets: Row[] = await em.execute(
      `with heads as materialized (
         select aggregate_id, next_attempt_at
           from (select distinct on (aggregate_id) aggregate_id, occurred_at, id, next_attempt_at
                   from outbox_messages
                  where published_at is null
                  order by aggregate_id, occurred_at, id) h
          where next_attempt_at <= now()
          order by occurred_at, id
       )
       select aggregate_id from heads
        where pg_try_advisory_xact_lock(${OUTBOX_LOCK_NAMESPACE}, hashtext(aggregate_id::text))
        limit ?`,
      [limit],
    );
    if (wallets.length === 0) return [];

    // instrução nova, foto nova: o que outro relay publicou e confirmou
    // antes de soltarmos o lock já não aparece aqui
    const rows: Row[] = await em.execute(
      `select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
         from outbox_messages
        where published_at is null and aggregate_id in (${wallets.map(() => "?").join(", ")})
        order by occurred_at, id
        limit ?`,
      [...wallets.map((w) => w.aggregate_id), limit],
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
    // sem nova data agendada, mantém a que está no banco (nada de relógio da máquina)
    await em.execute(
      `update outbox_messages
          set attempts = ?, next_attempt_at = coalesce(?, next_attempt_at), published_at = ?, last_error = ?
        where id = ?`,
      [message.attempts, message.nextAttemptAt ?? null, message.publishedAt ?? null, lastError ?? null, message.id],
    );
  }
}
