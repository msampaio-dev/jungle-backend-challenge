import type { WageringPorts } from "../application/ports";
import { databaseClock } from "./database/clock";
import { OutboxRepository } from "./database/outbox.repository";
import { WagerTransactionRepository } from "./database/wager-transaction.repository";
import { WalletRepository } from "./database/wallet.repository";
import { prometheusMetrics } from "./observability/metrics";

/**
 * Raiz de composição: liga cada porta da aplicação à implementação real
 * (MikroORM, relógio do banco, Prometheus). Os testes trocam uma peça só
 * passando `overrides`, como uma outbox que falha de propósito.
 */
export function wageringPorts(overrides: Partial<WageringPorts> = {}): WageringPorts {
  return {
    wallets: new WalletRepository(),
    transactions: new WagerTransactionRepository(),
    outbox: new OutboxRepository(),
    clock: databaseClock,
    metrics: prometheusMetrics,
    ...overrides,
  };
}
