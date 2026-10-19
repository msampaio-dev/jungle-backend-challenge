import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/shared/money";
import { CurrencyMismatchError, UnbalancedLedgerEntryError } from "../../src/domain/shared/domain-error";
import { LedgerDirection, WalletLedgerEntry, type CreateLedgerEntryProps } from "../../src/domain/wallet/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

const base = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: "entry-1",
  walletId: "wallet-1",
  transactionId: "tx-1",
  direction: LedgerDirection.Debit,
  money: brl("25.00"),
  balanceBefore: brl("100.00"),
  balanceAfter: brl("75.00"),
  createdAt: new Date("2026-10-19T12:00:00.000Z"),
  ...overrides,
});

describe("WalletLedgerEntry.create", () => {
  test("aceita débito que fecha a conta", () => {
    expect(WalletLedgerEntry.create(base()).isBalanced()).toBe(true);
  });

  test("aceita crédito que fecha a conta", () => {
    const entry = WalletLedgerEntry.create(
      base({ direction: LedgerDirection.Credit, balanceAfter: brl("125.00") }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  test("recusa lançamento cuja conta não fecha", () => {
    expect(() => WalletLedgerEntry.create(base({ balanceAfter: brl("76.00") }))).toThrow(
      UnbalancedLedgerEntryError,
    );
  });

  test("recusa direção trocada", () => {
    expect(() => WalletLedgerEntry.create(base({ direction: LedgerDirection.Credit }))).toThrow(
      UnbalancedLedgerEntryError,
    );
  });

  test("recusa valor zero", () => {
    expect(() =>
      WalletLedgerEntry.create(base({ money: brl("0.00"), balanceAfter: brl("100.00") })),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("recusa saldo final negativo", () => {
    expect(() =>
      WalletLedgerEntry.create(
        base({ money: brl("150.00"), balanceAfter: brl("50.00").negate() }),
      ),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("recusa moedas misturadas", () => {
    expect(() =>
      WalletLedgerEntry.create(base({ money: Money.from({ amount: "25.00", currency: "USD" }) })),
    ).toThrow(CurrencyMismatchError);
  });
});

describe("WalletLedgerEntry.rehydrate", () => {
  test("reconstrói sem revalidar a aritmética", () => {
    const entry = WalletLedgerEntry.rehydrate(base({ balanceAfter: brl("1.00") }));
    expect(entry.isBalanced()).toBe(false);
  });
});
