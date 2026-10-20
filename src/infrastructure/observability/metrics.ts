import { DeadlockException, LockWaitTimeoutException } from "@mikro-orm/core";
import { Counter, Histogram, Registry } from "prom-client";

/**
 * Métricas da seção 12 do desafio, em formato Prometheus (GET /metrics).
 * Registro próprio (não o global do prom-client) para não misturar com
 * métricas de bibliotecas.
 */
export const registry = new Registry();

export const metrics = {
  /** cada vez que uma transação chega a um status (a pendente conta de novo ao ser resolvida) */
  transactions: new Counter({
    name: "wagering_transactions_total",
    help: "Transações que chegaram a um status, por canal, tipo e status",
    labelNames: ["channel", "kind", "status"] as const,
    registers: [registry],
  }),
  duplicates: new Counter({
    name: "wagering_duplicates_total",
    help: "Duplicatas detectadas: replay de idempotência, reentrega reconhecida pela inbox, messageId reaproveitado",
    labelNames: ["type"] as const,
    registers: [registry],
  }),
  retries: new Counter({
    name: "wagering_retries_total",
    help: "Novas tentativas agendadas, por componente",
    labelNames: ["component"] as const,
    registers: [registry],
  }),
  deadLettered: new Counter({
    name: "sqs_dead_lettered_total",
    help: "Mensagens enviadas à DLQ pelo consumidor, por motivo",
    labelNames: ["reason"] as const,
    registers: [registry],
  }),
  lockWait: new Histogram({
    name: "wallet_lock_wait_seconds",
    help: "Tempo esperando o lock de uma wallet (SELECT ... FOR UPDATE)",
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  lockConflicts: new Counter({
    name: "wallet_lock_conflicts_total",
    help: "Conflitos de concorrência: lock_timeout, deadlock, serialização, versão desatualizada",
    labelNames: ["type"] as const,
    registers: [registry],
  }),
  processing: new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "Latência do processamento de uma operação, medida no processo (relógio monotônico)",
    labelNames: ["channel", "outcome"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  }),
  outboxPublishDelay: new Histogram({
    name: "outbox_publish_delay_seconds",
    help: "Atraso entre o evento acontecer e ser publicado (relógio do banco)",
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300],
    registers: [registry],
  }),
  reconciliationDivergences: new Counter({
    name: "wallet_reconciliation_divergences_total",
    help: "Reconciliações que encontraram saldo diferente do ledger",
    registers: [registry],
  }),
};

/** Conta o erro como conflito de lock, se for um. Devolve se contou. */
export function countLockConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const type =
    error instanceof LockWaitTimeoutException || code === "55P03"
      ? "lock_timeout"
      : error instanceof DeadlockException || code === "40P01"
        ? "deadlock"
        : code === "40001"
          ? "serialization"
          : (error as Error | null)?.name === "StaleWalletVersionError"
            ? "stale_version"
            : undefined;
  if (type) metrics.lockConflicts.inc({ type });
  return type !== undefined;
}
