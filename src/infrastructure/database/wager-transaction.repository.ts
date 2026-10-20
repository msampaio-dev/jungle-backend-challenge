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
      correlationId: tx.correlationId,
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
      attempts: tx.referenceAttempts,
      nextAttemptAt: tx.nextReferenceCheckAt ?? null,
      updatedAt: now,
    };
  }

  /**
   * Conta uma falha não transitória ao resolver a pendente e guarda a
   * mensagem para auditoria. Roda numa transação própria: a da resolução
   * já foi desfeita. Devolve o total de falhas (0 se não está mais pendente).
   */
  async recordResolutionFailure(em: EntityManager, id: string, message: string): Promise<number> {
    const [row] = await em.execute(
      `update wager_transactions
          set resolution_failures = resolution_failures + 1, last_error = left(?, 1000)
        where id = ? and status = 'PENDING_REFERENCE'
       returning resolution_failures`,
      [message, id],
    );
    return row ? Number(row.resolution_failures) : 0;
  }

  /**
   * Aluga pendentes devidas para um worker: empurra next_attempt_at para
   * daqui a leaseMs, então os outros workers não as veem. SKIP LOCKED evita
   * dois workers alugarem a mesma linha ao mesmo tempo. Se o worker morrer,
   * o aluguel vence e a transação volta a ficar devida. Não trava nada
   * além deste UPDATE: o processamento é feito depois, uma a uma.
   */
  async leaseDuePendingReferences(
    em: EntityManager,
    limit: number,
    leaseMs: number,
  ): Promise<Array<{ id: string; walletId: string; attempts: number }>> {
    const rows: Array<Record<string, unknown>> = await em.execute(
      `update wager_transactions
          set next_attempt_at = now() + make_interval(secs => ? / 1000.0)
        where id in (
          select id from wager_transactions
           where status = 'PENDING_REFERENCE' and next_attempt_at <= now()
           order by next_attempt_at
           limit ?
           for update skip locked)
       returning id, wallet_id, attempts`,
      [leaseMs, limit],
    );
    return rows.map((r) => ({ id: String(r.id), walletId: String(r.wallet_id), attempts: Number(r.attempts) }));
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
    referenceAttempts: r.attempts,
    nextReferenceCheckAt: r.nextAttemptAt ?? undefined,
    correlationId: r.correlationId ?? undefined,
  });
}
