import { Migration } from "@mikro-orm/migrations";

/**
 * O lançamento precisa ser da mesma carteira da transação que o gerou.
 * A FK antiga só exigia que a transação existisse; agora a FK composta
 * (transaction_id, wallet_id) exige que ela seja desta carteira.
 */
export class Migration20261020050000LedgerTransactionWallet extends Migration {
  override up(): void {
    this.addSql(`alter table wager_transactions add constraint wager_tx_id_wallet_uq unique (id, wallet_id);`);
    this.addSql(`alter table wallet_ledger_entries drop constraint ledger_transaction_fk;`);
    this.addSql(`
      alter table wallet_ledger_entries
        add constraint ledger_transaction_wallet_fk
        foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id);
    `);
  }

  override down(): void {
    this.addSql(`alter table wallet_ledger_entries drop constraint ledger_transaction_wallet_fk;`);
    this.addSql(`
      alter table wallet_ledger_entries
        add constraint ledger_transaction_fk foreign key (transaction_id) references wager_transactions (id);
    `);
    this.addSql(`alter table wager_transactions drop constraint wager_tx_id_wallet_uq;`);
  }
}
