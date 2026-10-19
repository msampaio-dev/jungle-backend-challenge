import { Migration } from "@mikro-orm/migrations";

/**
 * Carteiras e extrato. As garantias ficam no schema (restrição 9 do
 * desafio): mesmo que o código tenha um bug, o banco recusa o estado inválido.
 */
export class Migration20261019230000WalletsAndLedger extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   uuid not null,
        currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(18, 2) not null check (balance >= 0),
        version     integer not null check (version >= 1),
        created_at  timestamptz not null,
        updated_at  timestamptz not null,

        -- no máximo uma carteira por jogador e moeda
        constraint wallets_player_currency_uq unique (player_id, currency),
        -- alvo da FK composta do ledger (garante moeda do lançamento = moeda da carteira)
        constraint wallets_id_currency_uq unique (id, currency)
      );
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        -- ordem estável para paginação por cursor
        seq             bigint generated always as identity unique,
        wallet_id       uuid not null,
        transaction_id  uuid not null,
        direction       text not null check (direction in ('DEBIT', 'CREDIT')),
        amount          numeric(18, 2) not null check (amount > 0),
        currency        char(3) not null,
        balance_before  numeric(18, 2) not null check (balance_before >= 0),
        balance_after   numeric(18, 2) not null check (balance_after >= 0),
        created_at      timestamptz not null,

        constraint ledger_wallet_currency_fk
          foreign key (wallet_id, currency) references wallets (id, currency),

        -- uma transação gera no máximo um lançamento por carteira:
        -- mesmo se a idempotência falhar, o débito duplicado é recusado aqui
        constraint ledger_one_entry_per_transaction_uq unique (wallet_id, transaction_id),

        -- a conta do lançamento precisa fechar
        constraint ledger_arithmetic_ck check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );
    `);

    this.addSql(`create index ledger_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq);`);

    // Ledger só aceita INSERT. UPDATE, DELETE e TRUNCATE são barrados no banco.
    this.addSql(`
      create function forbid_ledger_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger ledger_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_ledger_mutation();
    `);
    this.addSql(`
      create trigger ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_ledger_mutation();
    `);
  }

  override down(): void {
    this.addSql(`drop table wallet_ledger_entries;`);
    this.addSql(`drop function forbid_ledger_mutation();`);
    this.addSql(`drop table wallets;`);
  }
}
