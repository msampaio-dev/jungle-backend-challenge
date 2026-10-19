import { Money } from "../shared/money";
import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from "../shared/domain-error";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Transação OPENING e lançamento usados quando o saldo inicial é > 0. */
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

/** Quem pede a movimentação: ids gerados fora para o domínio ficar determinístico. */
export interface MovementContext {
  transactionId: string;
  entryId: string;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a carteira já com o saldo inicial e version 1. Se o saldo inicial
   * for positivo, devolve também o lançamento CREDIT da transação OPENING.
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError("initial balance cannot be negative");
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );

    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: wallet.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: props.initialBalance,
          createdAt: props.at,
        })
      : undefined;

    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lança InsufficientFundsError se o saldo não cobre o débito. */
  debit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovable(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError(`balance ${this._balance} is less than ${money}`);
    }
    return this.apply(LedgerDirection.Debit, money, ctx);
  }

  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovable(money);
    return this.apply(LedgerDirection.Credit, money, ctx);
  }

  /** Único ponto que muda o saldo: sempre junto com o lançamento e a version. */
  private apply(direction: LedgerDirection, money: Money, ctx: MovementContext): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);

    const entry = WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: ctx.at,
    });

    this._balance = after;
    this._version += 1;
    this._updatedAt = ctx.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidMoneyError("movement amount must be positive");
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
