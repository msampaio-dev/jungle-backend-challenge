import type { MoneyProps } from "../shared/money";
import type { FailureCode } from "../wagering/failure-code";
import { type WagerTransaction, WagerTransactionStatus } from "../wagering/wager-transaction";
import type { Wallet } from "../wallet/wallet";
import type { LedgerDirection, WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { type EventContext, IntegrationEvent } from "./integration-event";

/*
 * Todos os eventos usam a walletId como aggregateId: é a chave de
 * ordenação (MessageGroupId da fila FIFO) e a unidade de concorrência.
 * O dinheiro vai como MoneyProps (string decimal), nunca como Money.
 */

const base = (walletId: string, ctx: EventContext) => ({
  eventId: Bun.randomUUIDv7(),
  aggregateId: walletId,
  correlationId: ctx.correlationId,
  causationId: ctx.causationId,
  occurredAt: ctx.occurredAt,
});

function transactionData(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

export interface WagerTransactionProcessedData extends ReturnType<typeof transactionData> {
  referenceTransactionId: string | null;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...base(tx.walletId, ctx),
      data: {
        ...transactionData(tx),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balance: tx.resultBalance!.toJSON(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends ReturnType<typeof transactionData> {
  failureCode: FailureCode;
  balance: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...base(tx.walletId, ctx),
      data: { ...transactionData(tx), failureCode: tx.failureCode!, balance: tx.resultBalance!.toJSON() },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends ReturnType<typeof transactionData> {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...base(tx.walletId, ctx),
      data: { ...transactionData(tx), referenceExternalTransactionId: tx.referenceExternalTransactionId! },
    });
  }
}

/**
 * Eventos que uma transação resolvida gera. WalletBalanceChanged só sai
 * quando houve lançamento, ou seja, quando o saldo mudou de fato.
 */
export function eventsForTransaction(
  tx: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  ctx: EventContext,
): IntegrationEvent<unknown>[] {
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      return entry
        ? [WagerTransactionProcessed.from(tx, ctx), WalletBalanceChanged.from(wallet, entry, ctx)]
        : [WagerTransactionProcessed.from(tx, ctx)];
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(tx, ctx)];
    case WagerTransactionStatus.PendingReference:
      return [WagerTransactionPendingReference.from(tx, ctx)];
    default:
      return [];
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  /** permite ao consumidor ordenar e descartar evento velho */
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...base(wallet.id, ctx),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
