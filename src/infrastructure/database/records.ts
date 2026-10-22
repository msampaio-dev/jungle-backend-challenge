import { EntitySchema } from "@mikro-orm/core";

/*
 * Formato das linhas no banco. Ficam separados das classes de domínio
 * para o domínio não depender do ORM: o repositório converte de um para
 * o outro. Mapeados com EntitySchema, sem decorators.
 *
 * Valores monetários chegam do Postgres (NUMERIC) como string e viram
 * Money no repositório, sem passar por number em nenhum momento.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletRecordSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: { type: "string", length: 3 },
    balance: { type: "decimal", precision: 18, scale: 2 },
    version: { type: "integer" },
    createdAt: { type: "Date" },
    updatedAt: { type: "Date" },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId?: string | null;
  gameId?: string | null;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  resultBalance?: string | null;
  /** moeda do saldo observado: a da wallet, que pode não ser a da transação */
  resultCurrency?: string | null;
  attempts!: number;
  nextAttemptAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
  updatedAt!: Date;
  correlationId?: string | null;
}

export const WagerTransactionRecordSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string" },
    externalTransactionId: { type: "string" },
    idempotencyKey: { type: "string" },
    payloadHash: { type: "string", length: 64 },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    roundId: { type: "string", nullable: true },
    gameId: { type: "string", nullable: true },
    kind: { type: "string" },
    amount: { type: "decimal", precision: 18, scale: 2 },
    currency: { type: "string", length: 3 },
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", nullable: true },
    resultBalance: { type: "decimal", precision: 18, scale: 2, nullable: true },
    resultCurrency: { type: "string", length: 3, nullable: true },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "Date", nullable: true },
    createdAt: { type: "Date" },
    processedAt: { type: "Date", nullable: true },
    updatedAt: { type: "Date" },
    correlationId: { type: "string", nullable: true },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntryRecordSchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "string" },
    amount: { type: "decimal", precision: 18, scale: 2 },
    currency: { type: "string", length: 3 },
    balanceBefore: { type: "decimal", precision: 18, scale: 2 },
    balanceAfter: { type: "decimal", precision: 18, scale: 2 },
    createdAt: { type: "Date" },
  },
});
