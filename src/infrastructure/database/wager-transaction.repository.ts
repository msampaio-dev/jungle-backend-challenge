import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../domain/shared/money";
import { FailureCode } from "../../domain/wagering/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import { WagerTransactionRecord } from "./records";

export class WagerTransactionRepository {
  async findById(em: EntityManager, id: string): Promise<WagerTransaction | null> {
    return this.findOne(em, { id });
  }

  async findByIdempotencyKey(
    em: EntityManager,
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    return this.findOne(em, { providerId, idempotencyKey });
  }

  async findByExternalId(
    em: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return this.findOne(em, { providerId, externalTransactionId });
  }

  /** A referência já foi revertida (por REFUND ou ROLLBACK, tanto faz)? */
  async hasProcessedReversal(em: EntityManager, referenceTransactionId: string): Promise<boolean> {
    const count = await em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insert(em: EntityManager, tx: WagerTransaction, now: Date): Promise<void> {
    await em.insert(WagerTransactionRecord, {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId ?? null,
      gameId: tx.gameId ?? null,
      kind: tx.kind,
      amount: tx.money.toJSON().amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      attempts: 0,
      createdAt: tx.createdAt,
      ...this.mutableFields(tx, now),
    });
  }

  /** Grava só o que pode mudar; o banco recusa se a linha já for terminal. */
  async update(em: EntityManager, tx: WagerTransaction, now: Date): Promise<void> {
    await em.nativeUpdate(WagerTransactionRecord, { id: tx.id }, this.mutableFields(tx, now));
  }

  private mutableFields(tx: WagerTransaction, now: Date) {
    return {
      status: tx.status,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null,
      resultBalance: tx.resultBalance?.toJSON().amount ?? null,
      processedAt: tx.processedAt ?? null,
      updatedAt: now,
    };
  }

  private async findOne(em: EntityManager, where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | null> {
    const record = await em.findOne(WagerTransactionRecord, where, { refresh: true });
    return record ? toWagerTransaction(record) : null;
  }
}

function toWagerTransaction(r: WagerTransactionRecord): WagerTransaction {
  const money = (amount: string) => Money.from({ amount, currency: r.currency });
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId ?? undefined,
    gameId: r.gameId ?? undefined,
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: (r.failureCode as FailureCode | null) ?? undefined,
    resultBalance: r.resultBalance ? money(r.resultBalance) : undefined,
    processedAt: r.processedAt ?? undefined,
  });
}
