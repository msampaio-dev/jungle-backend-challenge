import type { ClockPort } from "./clock";
import type { MetricsPort } from "./metrics";
import type { OutboxRepositoryPort, WagerTransactionRepositoryPort, WalletRepositoryPort } from "./repositories";

export type { ClockPort } from "./clock";
export type { MetricsPort } from "./metrics";
export type {
  OutboxRepositoryPort,
  PendingReferenceLease,
  WagerTransactionRepositoryPort,
  WalletRepositoryPort,
} from "./repositories";

/** Tudo que os use cases e workers recebem de fora. Montado em infrastructure/wiring.ts. */
export interface WageringPorts {
  wallets: WalletRepositoryPort;
  transactions: WagerTransactionRepositoryPort;
  outbox: OutboxRepositoryPort;
  clock: ClockPort;
  metrics: MetricsPort;
}
