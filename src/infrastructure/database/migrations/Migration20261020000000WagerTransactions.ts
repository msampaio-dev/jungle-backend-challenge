import { Migration } from "@mikro-orm/migrations";

/**
 * Transações de aposta. A idempotência mora aqui: a chave é única por
 * provedor no banco, então nenhuma corrida entre instâncias grava duas vezes.
 */
export class Migration20261020000000WagerTransactions extends Migration {
  override up(): void {
    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        text not null,
        external_transaction_id            text not null,
        idempotency_key                    text not null,
        payload_hash                       char(64) not null,
        wallet_id                          uuid not null,
        player_id                          uuid not null,
        round_id                           text,
        game_id                            text,
        kind                               text not null
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(18, 2) not null check (amount >= 0),
        currency                           char(3) not null,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid references wager_transactions (id),
        status                             text not null
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       text,
        -- saldo observado quando a transação foi resolvida (devolvido no replay)
        result_balance                     numeric(18, 2) check (result_balance >= 0),
        -- usados pelo worker de PENDING_REFERENCE
        attempts                           integer not null default 0 check (attempts >= 0),
        next_attempt_at                    timestamptz,
        created_at                         timestamptz not null,
        processed_at                       timestamptz,
        updated_at                         timestamptz not null,

        -- FK só pelo id: uma transação REJECTED por CURRENCY_MISMATCH também é
        -- gravada para auditoria. A moeda certa é garantida no ledger.
        constraint wager_tx_wallet_fk foreign key (wallet_id) references wallets (id),

        -- idempotência persistente: a mesma chave nunca gera duas transações
        constraint wager_tx_idempotency_uq unique (provider_id, idempotency_key),
        -- resolução de referência e GET por id externo
        constraint wager_tx_external_id_uq unique (provider_id, external_transaction_id),

        constraint wager_tx_reference_required_ck
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_round_required_ck
          check (kind = 'OPENING' or (round_id is not null and game_id is not null)),
        -- REJECTED e FAILED sempre têm código; os outros estados nunca têm
        constraint wager_tx_failure_code_ck
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_tx_processed_at_ck
          check ((status = 'PROCESSED') = (processed_at is not null))
      );
    `);

    // uma referência só pode ser revertida uma vez por tipo de operação
    this.addSql(`
      create unique index wager_tx_one_reversal_per_reference_uq
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
    // fila do worker que reprocessa referências fora de ordem
    this.addSql(`
      create index wager_tx_pending_reference_idx
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);

    // Estado terminal não muda, e os dados de negócio nunca mudam.
    this.addSql(`
      create function guard_wager_transaction_update() returns trigger
      language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%)', old.id, old.status
            using errcode = 'restrict_violation';
        end if;
        if (new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount,
            new.currency, new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount,
            old.currency, old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager transaction % business fields are immutable', old.id
            using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_tx_guard_update
        before update on wager_transactions
        for each row execute function guard_wager_transaction_update();
    `);

    // trilha de auditoria: transações nunca são apagadas
    this.addSql(`
      create function forbid_delete() returns trigger
      language plpgsql as $$
      begin
        raise exception '% is append-only: % is not allowed', tg_table_name, tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_tx_no_delete
        before delete on wager_transactions
        for each row execute function forbid_delete();
    `);
    this.addSql(`
      create trigger wager_tx_no_truncate
        before truncate on wager_transactions
        for each statement execute function forbid_delete();
    `);

    // todo lançamento aponta para uma transação real
    this.addSql(`
      alter table wallet_ledger_entries
        add constraint ledger_transaction_fk
        foreign key (transaction_id) references wager_transactions (id);
    `);
  }

  override down(): void {
    this.addSql(`alter table wallet_ledger_entries drop constraint ledger_transaction_fk;`);
    this.addSql(`drop table wager_transactions;`);
    this.addSql(`drop function forbid_delete();`);
    this.addSql(`drop function guard_wager_transaction_update();`);
  }
}
