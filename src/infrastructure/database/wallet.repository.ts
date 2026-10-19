import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Money } from "../../domain/shared/money";
import { Wallet } from "../../domain/wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { LedgerEntryRecord, WalletRecord } from "./records";

/**
 * O UPDATE da carteira não encontrou a version esperada. Com o lock
 * pessimista isso não acontece; se acontecer, é bug, e a transação aborta
 * em vez de sobrescrever o saldo.
 */
export class StaleWalletVersionError extends Error {
  constructor(walletId: string, expectedVersion: number) {
    super(`wallet ${walletId} is not at version ${expectedVersion}`);
    this.name = "StaleWalletVersionError";
  }
}

export class WalletRepository {
  async findById(em: EntityManager, id: string): Promise<Wallet | null> {
    const record = await em.findOne(WalletRecord, { id });
    return record ? toWallet(record) : null;
  }

  /**
   * SELECT ... FOR UPDATE na linha da carteira. Precisa rodar dentro de
   * uma transação: o lock vale até o commit/rollback e só trava esta
   * carteira, então carteiras diferentes seguem em paralelo.
   */
  async lockById(em: EntityManager, id: string): Promise<Wallet | null> {
    const record = await em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? toWallet(record) : null;
  }

  async insert(em: EntityManager, wallet: Wallet, openingEntry?: WalletLedgerEntry): Promise<void> {
    await em.insert(WalletRecord, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
    if (openingEntry) await this.insertEntry(em, openingEntry);
  }

  /**
   * Grava o novo saldo e o lançamento. O WHERE version = expectedVersion é
   * uma segunda proteção além do lock: se a linha mudou, 0 linhas são
   * afetadas e a transação é abortada.
   */
  async saveMovement(
    em: EntityManager,
    wallet: Wallet,
    expectedVersion: number,
    entry: WalletLedgerEntry,
  ): Promise<void> {
    const affected = await em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      {
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (affected !== 1) throw new StaleWalletVersionError(wallet.id, expectedVersion);

    await this.insertEntry(em, entry);
  }

  private async insertEntry(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    await em.insert(LedgerEntryRecord, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    });
  }
}

function toWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function toLedgerEntry(record: LedgerEntryRecord): WalletLedgerEntry {
  const money = (amount: string) => Money.from({ amount, currency: record.currency });
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: money(record.amount),
    balanceBefore: money(record.balanceBefore),
    balanceAfter: money(record.balanceAfter),
    createdAt: record.createdAt,
  });
}
