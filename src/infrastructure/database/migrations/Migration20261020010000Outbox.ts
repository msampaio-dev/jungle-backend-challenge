import { Migration } from "@mikro-orm/migrations";

/** Transactional outbox: eventos gravados na mesma transação da operação. */
export class Migration20261020010000Outbox extends Migration {
  override up(): void {
    this.addSql(`
      create table outbox_messages (
        id               uuid primary key, -- = eventId
        aggregate_id     uuid not null,
        event_type       text not null,
        payload          jsonb not null,
        occurred_at      timestamptz not null,
        attempts         integer not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz not null,
        published_at     timestamptz,
        last_error       text
      );
    `);

    // só as pendentes entram no índice: a tabela cresce, o índice não
    this.addSql(`
      create index outbox_pending_idx
        on outbox_messages (next_attempt_at, occurred_at)
        where published_at is null;
    `);

    // conteúdo do evento é imutável; depois de publicado, nada muda
    this.addSql(`
      create function guard_outbox_update() returns trigger
      language plpgsql as $$
      begin
        if old.published_at is not null then
          raise exception 'outbox message % already published', old.id using errcode = 'restrict_violation';
        end if;
        if (new.aggregate_id, new.event_type, new.payload, new.occurred_at)
           is distinct from (old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
          raise exception 'outbox message % content is immutable', old.id using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger outbox_guard_update
        before update on outbox_messages
        for each row execute function guard_outbox_update();
    `);
  }

  override down(): void {
    this.addSql(`drop table outbox_messages;`);
    this.addSql(`drop function guard_outbox_update();`);
  }
}
