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
