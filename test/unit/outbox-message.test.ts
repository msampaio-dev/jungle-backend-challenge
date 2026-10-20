import { describe, expect, test } from "bun:test";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { WalletBalanceChanged } from "../../src/domain/messaging/wagering-events";
import { Money } from "../../src/domain/shared/money";
import { Wallet } from "../../src/domain/wallet/wallet";

const T0 = new Date("2026-10-19T12:00:00.000Z");
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

function balanceChanged(): WalletBalanceChanged {
  const { wallet } = Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl("100.00"),
    openingTransactionId: "tx-open",
    openingEntryId: "entry-open",
    at: T0,
  });
  const entry = wallet.debit(brl("25.00"), { transactionId: "tx-1", entryId: "entry-1", at: T0 });
  return WalletBalanceChanged.from(wallet, entry, { correlationId: "corr-1", causationId: "msg-1", occurredAt: T0 });
}

describe("IntegrationEvent", () => {
  test("envelope com tipo e versão vindos da classe e dinheiro como string", () => {
    const event = balanceChanged();
    expect(JSON.parse(JSON.stringify(event))).toEqual({
      eventId: event.eventId,
      eventType: "WalletBalanceChanged",
      aggregateId: "wallet-1",
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-10-19T12:00:00.000Z",
      version: 1,
      data: {
        walletId: "wallet-1",
        transactionId: "tx-1",
        direction: "DEBIT",
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
  });

  test("o envelope é JSON estável (ida e volta sem perda)", () => {
    const json = balanceChanged().toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe("OutboxMessage", () => {
  test("enqueue usa o eventId como id e nasce pendente e devido", () => {
    const event = balanceChanged();
    const message = OutboxMessage.enqueue(event);
    expect(message.id).toBe(event.eventId);
    expect(message.eventType).toBe("WalletBalanceChanged");
    expect(message.isPending()).toBe(true);
    expect(message.isDue(T0)).toBe(true);
    expect(message.attempts).toBe(0);
  });

  test("backoff exponencial limitado a 60s", () => {
    const message = OutboxMessage.enqueue(balanceChanged());
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      message.scheduleRetry(T0);
      delays.push(message.nextAttemptAt!.getTime() - T0.getTime());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(message.attempts).toBe(9);
    expect(message.isDue(T0)).toBe(false);
    expect(message.isDue(new Date(T0.getTime() + 60_000))).toBe(true);
  });

  test("publicada deixa de estar pendente e não pode ser publicada de novo", () => {
    const message = OutboxMessage.enqueue(balanceChanged());
    message.markPublished(T0);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(T0)).toBe(false);
    expect(() => message.markPublished(T0)).toThrow(/already published/);
  });
});
