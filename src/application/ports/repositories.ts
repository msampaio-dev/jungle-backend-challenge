import type { EntityManager } from "@mikro-orm/postgresql";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

/*
 * Portas de persistência: o que a aplicação precisa do banco, sem saber
 * como é feito. Implementadas em infrastructure/database com MikroORM.
 *
 * O EntityManager entra em todo método de propósito: ele É a transação
 * (EntityManager.transactional), e tudo que uma operação grava precisa
 * passar pela mesma. Esconder isso exigiria uma porta de Unit of Work só
 * para abstrair o ORM que o próprio desafio indica.
 */

export interface WalletRepositoryPort {
  findById(em: EntityManager, id: string): Promise<Wallet | null>;
  /** Id da wallet do jogador nessa moeda (há no máximo uma). */
  findIdByPlayer(em: EntityManager, playerId: string, currency: string): Promise<string | null>;
  /** Trava a linha da wallet até o fim da transação (SELECT ... FOR UPDATE). */
  lockById(em: EntityManager, id: string): Promise<Wallet | null>;
  insert(em: EntityManager, wallet: Wallet): Promise<void>;
  /** Grava o novo saldo só se a version ainda for a esperada, e o lançamento. */
  saveMovement(em: EntityManager, wallet: Wallet, expectedVersion: number, entry: WalletLedgerEntry): Promise<void>;
  insertEntry(em: EntityManager, entry: WalletLedgerEntry): Promise<void>;
}

export interface PendingReferenceLease {
  id: string;
  walletId: string;
  attempts: number;
}

export interface WagerTransactionRepositoryPort {
  findById(em: EntityManager, id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(em: EntityManager, providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(em: EntityManager, providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** A referência já foi revertida (por REFUND ou ROLLBACK)? */
  hasProcessedReversal(em: EntityManager, referenceTransactionId: string): Promise<boolean>;
  insert(em: EntityManager, tx: WagerTransaction, now: Date): Promise<void>;
  update(em: EntityManager, tx: WagerTransaction, now: Date): Promise<void>;
  /** Antecipa as pendentes que esperam por esta transação. Devolve quantas. */
  wakePendingDependents(em: EntityManager, providerId: string, externalTransactionId: string): Promise<number>;
  /** Conta uma falha não transitória da pendente. Devolve o total de falhas. */
  recordResolutionFailure(em: EntityManager, id: string, message: string): Promise<number>;
  /** Aluga pendentes devidas: some para os outros workers por leaseMs. */
  leaseDuePendingReferences(em: EntityManager, limit: number, leaseMs: number): Promise<PendingReferenceLease[]>;
}

export interface OutboxRepositoryPort {
  insert(em: EntityManager, messages: OutboxMessage[]): Promise<void>;
  /** Trava um lote de wallets e devolve os eventos pendentes delas, em ordem. */
  claimDue(em: EntityManager, limit: number): Promise<OutboxMessage[]>;
  save(em: EntityManager, message: OutboxMessage, lastError?: string): Promise<void>;
}
