import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { WalletRepositoryPort } from "../../application/ports";
import { Money } from "../../domain/shared/money";
import { metrics } from "../observability/metrics";
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

/** Quanto uma transação espera pelo lock de uma wallet antes de desistir. */
const DEFAULT_LOCK_TIMEOUT_MS = Number(process.env.WALLET_LOCK_TIMEOUT_MS ?? 5_000);

export class WalletRepository implements WalletRepositoryPort {
  constructor(private readonly lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
    // vai direto num SET (que não aceita parâmetro): só inteiro positivo passa
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
      throw new Error(`invalid wallet lock timeout: ${lockTimeoutMs}`);
    }
  }

  async findById(em: EntityManager, id: string): Promise<Wallet | null> {
    const record = await em.findOne(WalletRecord, { id });
    return record ? toWallet(record) : null;
  }

  async findIdByPlayer(em: EntityManager, playerId: string, currency: string): Promise<string | null> {
    const record = await em.findOne(WalletRecord, { playerId, currency }, { fields: ["id"] });
    return record?.id ?? null;
  }

  /**
   * SELECT ... FOR UPDATE na linha da carteira. Precisa rodar dentro de
   * uma transação: o lock vale até o commit/rollback e só trava esta
   * carteira, então carteiras diferentes seguem em paralelo.
   *
   * lock_timeout: sem ele, uma requisição podia esperar o lock para sempre
   * atrás de uma transação travada. Passado o limite, o Postgres desiste
   * (55P03), o que vira erro transitório: 503 na API, retry no SQS.
   * SET LOCAL vale só até o fim desta transação.
   */
  async lockById(em: EntityManager, id: string): Promise<Wallet | null> {
    await em.execute(`set local lock_timeout = ${this.lockTimeoutMs}`);
    const stopTimer = metrics.lockWait.startTimer();
    try {
      const record = await em.findOne(
        WalletRecord,
        { id },
        { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
      );
      return record ? toWallet(record) : null;
    } finally {
      stopTimer(); // inclusive quando desiste por lock_timeout: a espera aconteceu
    }
  }

  async insert(em: EntityManager, wallet: Wallet): Promise<void> {
    await em.insert(WalletRecord, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
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

  async insertEntry(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
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
