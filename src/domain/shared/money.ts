import { CurrencyMismatchError, InvalidMoneyError } from "./domain-error";

/** Formato dos contratos (HTTP, SQS, eventos): sempre string decimal. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

// Inteiro sem zero à esquerda + até 2 casas. Recusa sinal, espaço,
// notação científica, NaN e Infinity só por não casar com o padrão.
// 16 dígitos inteiros cabem em NUMERIC(18,2) no Postgres.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,15})(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 100n;
/** 9999999999999999.99: o maior valor que cabe em NUMERIC(18,2). */
const MAX_MINOR = 10n ** 18n - 1n;

/**
 * Valor monetário imutável. Guarda o valor em centavos como bigint:
 * o desafio só soma, subtrai e compara, então nunca há arredondamento.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Valida a entrada de contrato. Valores negativos não são aceitos aqui. */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`invalid currency: ${String(currency)}`);
    }
    if (typeof amount !== "string") {
      throw new InvalidMoneyError("amount must be a decimal string");
    }

    const match = AMOUNT_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(`invalid amount: "${amount}"`);
    }

    const integerPart = BigInt(match[1]!);
    const fractionPart = BigInt((match[2] ?? "").padEnd(2, "0"));
    return new Money(integerPart * SCALE + fractionPart, currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  /** Passa do maior valor armazenável? Soma de valores válidos pode passar. */
  exceedsMaximum(): boolean {
    return this.minor > MAX_MINOR || this.minor < -MAX_MINOR;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const sign = this.minor < 0n ? "-" : "";
    const abs = this.minor < 0n ? -this.minor : this.minor;
    const cents = (abs % SCALE).toString().padStart(2, "0");
    return `${sign}${abs / SCALE}.${cents}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
