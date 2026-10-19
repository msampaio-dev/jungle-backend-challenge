import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/shared/money";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
} from "../../src/domain/shared/domain-error";
import { Wallet } from "../../src/domain/wallet/wallet";
import { LedgerDirection } from "../../src/domain/wallet/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-10-19T12:00:00.000Z");
const T1 = new Date("2026-10-19T12:00:01.000Z");

let seq = 0;
const ctx = (at = T1) => ({ transactionId: `tx-${++seq}`, entryId: `entry-${seq}`, at });

function openWallet(initial = "100.00"): Wallet {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(initial),
    openingTransactionId: "tx-opening",
    openingEntryId: "entry-opening",
    at: T0,
  }).wallet;
}

describe("Wallet.open", () => {
  test("nasce com o saldo inicial, version 1 e lançamento OPENING", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("1000.00"),
      openingTransactionId: "tx-opening",
      openingEntryId: "entry-opening",
      at: T0,
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.currency).toBe("BRL");
    expect(wallet.version).toBe(1);
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe("tx-opening");
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe("1000.00");
  });

  test("saldo inicial zero não gera lançamento", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("0.00"),
      openingTransactionId: "tx-opening",
      openingEntryId: "entry-opening",
      at: T0,
    });

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test("recusa saldo inicial negativo", () => {
    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: brl("10.00").negate(),
        openingTransactionId: "tx-opening",
        openingEntryId: "entry-opening",
        at: T0,
      }),
    ).toThrow(InvalidMoneyError);
  });
});

describe("Wallet.debit", () => {
  test("debita, gera lançamento DEBIT e incrementa version", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit(brl("25.00"), ctx());

    expect(wallet.balance.toJSON().amount).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("75.00");
    expect(entry.isBalanced()).toBe(true);
  });

  test("pode zerar o saldo exatamente", () => {
    const wallet = openWallet("80.00");
    wallet.debit(brl("80.00"), ctx());
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("saldo insuficiente lança erro e não altera nada", () => {
    const wallet = openWallet("20.00");

    expect(() => wallet.debit(brl("80.00"), ctx())).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(T0);
  });

  test("cenário da seção 8 em sequência: 100 - 80 - 80 deixa 20 e só um débito", () => {
    const wallet = openWallet("100.00");
    const entries = [];

    for (const _ of [1, 2]) {
      try {
        entries.push(wallet.debit(brl("80.00"), ctx()));
      } catch (error) {
        expect(error).toBeInstanceOf(InsufficientFundsError);
      }
    }

    expect(entries).toHaveLength(1);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
  });
});

describe("Wallet.credit", () => {
  test("credita, gera lançamento CREDIT e incrementa version", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.credit(brl("50.00"), ctx());

    expect(wallet.balance.toJSON().amount).toBe("150.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);
  });
});

describe("Wallet — invariantes", () => {
  test.each([
    ["debit", (w: Wallet) => w.debit(brl("0.00"), ctx())],
    ["credit", (w: Wallet) => w.credit(brl("0.00"), ctx())],
  ])("%s de valor zero é recusado e version não muda", (_name, operation) => {
    const wallet = openWallet();
    expect(() => operation(wallet)).toThrow(InvalidMoneyError);
    expect(wallet.version).toBe(1);
  });

  test.each([
    ["debit", (w: Wallet) => w.debit(Money.from({ amount: "1.00", currency: "USD" }), ctx())],
    ["credit", (w: Wallet) => w.credit(Money.from({ amount: "1.00", currency: "USD" }), ctx())],
  ])("%s em outra moeda lança CurrencyMismatchError", (_name, operation) => {
    const wallet = openWallet();
    expect(() => operation(wallet)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
  });

  test("saldo reconstruído pelo ledger é igual ao saldo da wallet", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("100.00"),
      openingTransactionId: "tx-opening",
      openingEntryId: "entry-opening",
      at: T0,
    });
    const entries = [openingEntry!];
    entries.push(wallet.debit(brl("30.00"), ctx()));
    entries.push(wallet.credit(brl("12.50"), ctx()));
    entries.push(wallet.debit(brl("0.01"), ctx()));

    const fromLedger = entries.reduce(
      (sum, e) => (e.direction === LedgerDirection.Credit ? sum.add(e.money) : sum.subtract(e.money)),
      Money.zero("BRL"),
    );

    expect(fromLedger.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.toJSON().amount).toBe("82.49");
    expect(wallet.version).toBe(4);
  });

  test("rehydrate reconstrói o estado sem revalidar", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-1",
      playerId: "player-1",
      currency: "BRL",
      balance: brl("42.00"),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });

    expect(wallet.balance.toJSON().amount).toBe("42.00");
    expect(wallet.version).toBe(7);
  });
});
