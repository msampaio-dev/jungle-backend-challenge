import { Logger } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { eventsForTransaction } from "../../domain/messaging/wagering-events";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { OutboxRepository } from "../../infrastructure/database/outbox.repository";
import { WagerTransactionRepository } from "../../infrastructure/database/wager-transaction.repository";
import { WalletRepository } from "../../infrastructure/database/wallet.repository";
import type { ProcessWagerTransactionUseCase } from "./process-wager-transaction.use-case";

export interface PendingReferenceWorkerOptions {
  batchSize: number;
  /** espera entre rodadas quando não há nada devido */
  idleDelayMs: number;
  /** por quanto tempo uma pendente alugada fica invisível para os outros workers */
  leaseMs: number;
}

export const DEFAULT_PENDING_REFERENCE_WORKER_OPTIONS: PendingReferenceWorkerOptions = {
  batchSize: 50,
  idleDelayMs: 1_000,
  leaseMs: 30_000,
};

export type PendingOutcome = "resolved" | "rescheduled" | "skipped" | "failed";

interface Lease {
  id: string;
  walletId: string;
  attempts: number;
}

/**
 * Reprocessa transações em PENDING_REFERENCE quando chega a hora.
 *
 * Duas fases, para não haver deadlock entre workers:
 *  1. aluguel: um UPDATE ... SKIP LOCKED empurra next_attempt_at para frente
 *     (os outros workers deixam de ver essas linhas; se este morrer, o
 *     aluguel vence e outro assume);
 *  2. cada pendente é resolvida na sua própria transação SQL, travando a
 *     wallet primeiro — a mesma ordem de locks do use case da API.
 */
export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly orm: MikroORM,
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly options: PendingReferenceWorkerOptions = DEFAULT_PENDING_REFERENCE_WORKER_OPTIONS,
    private readonly wallets = new WalletRepository(),
    private readonly transactions = new WagerTransactionRepository(),
    private readonly outbox = new OutboxRepository(),
  ) {}

  /** Uma rodada: aluga o que está devido e resolve um por um. */
  async runOnce(): Promise<PendingOutcome[]> {
    const leases = await this.orm.em
      .fork()
      .transactional((em) => this.transactions.leaseDuePendingReferences(em, this.options.batchSize, this.options.leaseMs));

    const outcomes: PendingOutcome[] = [];
    for (const lease of leases) {
      try {
        outcomes.push(await this.resolveOne(lease));
      } catch (error) {
        // o aluguel vence e a pendente volta para a fila; nada fica pela metade
        this.logger.error({ msg: "pending reference resolution failed", transactionId: lease.id, error: (error as Error).message });
        outcomes.push("failed");
      }
    }
    return outcomes;
  }

  private resolveOne(lease: Lease): Promise<PendingOutcome> {
    return this.orm.em.fork().transactional(async (em) => {
      // wallet primeiro, como no use case: mesma ordem de locks em todo lugar
      const wallet = await this.wallets.lockById(em, lease.walletId);
      const tx = await this.transactions.findById(em, lease.id);

      // Outro worker chegou antes (o aluguel venceu enquanto este demorava):
      // a transação já mudou de estado ou de tentativa. Não mexe.
      if (
        !wallet ||
        !tx ||
        tx.status !== WagerTransactionStatus.PendingReference ||
        tx.referenceAttempts !== lease.attempts
      ) {
        return "skipped";
      }

      const now = new Date();
      const expectedVersion = wallet.version;
      const entry = await this.useCase.resolve(em, tx, wallet, now);

      await this.transactions.update(em, tx, now);
      if (entry) await this.wallets.saveMovement(em, wallet, expectedVersion, entry);

      if (!tx.isTerminal()) return "rescheduled"; // reagendamento não gera evento

      // A origem da requisição não é guardada: o próprio id vira correlationId.
      const ctx = { correlationId: tx.id, occurredAt: now };
      await this.outbox.insert(
        em,
        eventsForTransaction(tx, wallet, entry, ctx).map((e) => OutboxMessage.enqueue(e)),
      );
      this.logger.log({ msg: "pending reference resolved", transactionId: tx.id, status: tx.status, failureCode: tx.failureCode });
      return "resolved";
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Para de alugar e espera a rodada em andamento terminar. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let full = false;
      try {
        full = (await this.runOnce()).length === this.options.batchSize;
      } catch (error) {
        this.logger.error({ msg: "pending reference round failed", error: (error as Error).message });
      }
      if (!full && this.running) await this.sleep(this.options.idleDelayMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
