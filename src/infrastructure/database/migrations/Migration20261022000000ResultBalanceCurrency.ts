import { Migration } from "@mikro-orm/migrations";

/**
 * Moeda do saldo observado. O result_balance é o saldo da WALLET quando a
 * transação foi resolvida, e a moeda dela pode não ser a da transação (uma
 * operação em USD rejeitada numa wallet BRL). Sem a coluna, a leitura
 * remontava o saldo com a moeda da transação e o replay devolvia BRL como USD.
 */
export class Migration20261022000000ResultBalanceCurrency extends Migration {
  override up(): void {
    this.addSql(`alter table wager_transactions add column result_currency char(3);`);

    // Linhas já gravadas: a moeda é a da wallet. O trigger recusa alterar
    // transação terminal, então fica desligado só durante este preenchimento.
    this.addSql(`alter table wager_transactions disable trigger wager_tx_guard_update;`);
    this.addSql(`
      update wager_transactions t
         set result_currency = w.currency
        from wallets w
       where w.id = t.wallet_id and t.result_balance is not null;
    `);
    this.addSql(`alter table wager_transactions enable trigger wager_tx_guard_update;`);

    // saldo observado e a moeda dele andam juntos
    this.addSql(`
      alter table wager_transactions add constraint wager_tx_result_currency_ck
        check ((result_balance is null) = (result_currency is null));
    `);
  }

  override down(): void {
    this.addSql(`alter table wager_transactions drop constraint wager_tx_result_currency_ck;`);
    this.addSql(`alter table wager_transactions drop column result_currency;`);
  }
}
