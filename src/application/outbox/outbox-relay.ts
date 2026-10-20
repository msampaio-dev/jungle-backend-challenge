import { Logger } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { databaseNow } from "../../infrastructure/database/clock";
import { OutboxRepository } from "../../infrastructure/database/outbox.repository";
import { describeError } from "../../infrastructure/observability/json-logger";
import { metrics } from "../../infrastructure/observability/metrics";
import { DEFAULT_FAILURE_BACKOFF, FailureBackoff, type FailureBackoffOptions } from "../shared/failure-backoff";
import type { EventPublisher } from "./event-publisher";

export interface OutboxRelayOptions {
  batchSize: number;
  /** espera entre rodadas quando não há nada para publicar */
  idleDelayMs: number;
  /** espera crescente entre rodadas que falham (padrão: 1s, 2s, 4s... até 10s) */
  failureBackoff?: FailureBackoffOptions;
}

export interface BatchResult {
  published: number;
  failed: number;
}

/**
 * Worker que publica a outbox. Roda em todas as instâncias ao mesmo tempo:
 * cada uma trava um lote com SKIP LOCKED, então ninguém publica o mesmo
 * lote em paralelo. Entrega é at-least-once: se o processo morrer depois
 * de publicar e antes do commit, o lote volta e é publicado de novo — o
 * consumidor deduplica pelo eventId.
 */
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly orm: MikroORM,
    private readonly publisher: EventPublisher,
    private readonly options: OutboxRelayOptions = { batchSize: 50, idleDelayMs: 500 },
    private readonly outbox = new OutboxRepository(),
  ) {}

  /** Uma rodada: trava um lote, publica um por um e grava o resultado de cada. */
  async publishBatch(): Promise<BatchResult> {
    // métricas só valem se a transação confirmar: ficam aqui até o commit
    const afterCommit: Array<() => void> = [];
    const batch = await this.orm.em.fork().transactional(async (em) => {
      const messages = await this.outbox.claimDue(em, this.options.batchSize);
      // backoff calculado no relógio do banco, o mesmo que o claimDue compara
      const now = await databaseNow(em);
      const result = { published: 0, failed: 0 };

      for (const message of messages) {
        try {
          await this.publisher.publish(message);
          message.markPublished(now);
          await this.outbox.save(em, message);
          // occurred_at e now vêm do relógio do banco: o atraso é confiável
          const delaySeconds = Math.max(0, (now.getTime() - message.occurredAt.getTime()) / 1000);
          afterCommit.push(() => metrics.outboxPublishDelay.observe(delaySeconds));
          result.published++;
        } catch (error) {
          // conta a partir da falha: a publicação pode ter levado o timeout inteiro
          message.scheduleRetry(await databaseNow(em));
          await this.outbox.save(em, message, (error as Error).message);
          afterCommit.push(() => metrics.retries.inc({ component: "outbox_publish" }));
          result.failed++;
          this.logger.warn({
            msg: "outbox publish failed",
            eventId: message.id,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt,
          });
          // Provavelmente o SQS está fora: insistir no resto do lote só manteria
          // a transação e os locks abertos (até lote x timeout). O resto fica
          // pendente, sem gastar tentativa, e sai na próxima rodada.
          break;
        }
      }
      return result;
    });
    for (const apply of afterCommit) apply();
    return batch;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Para de buscar lotes novos e espera o lote em andamento terminar. */
  async stop(): Promise<void> {
    if (!this.running) return;
    const startedAt = performance.now();
    this.running = false;
    this.wake?.();
    await this.loop;
    this.logger.log({ msg: "outbox relay stopped", durationMs: Math.round(performance.now() - startedAt) });
  }

  private async run(): Promise<void> {
    const backoff = new FailureBackoff(this.options.failureBackoff ?? DEFAULT_FAILURE_BACKOFF);
    while (this.running) {
      let delayMs = this.options.idleDelayMs;
      try {
        const { published, failed } = await this.publishBatch();
        const failedRounds = backoff.succeeded();
        if (failedRounds > 0) this.logger.log({ msg: "outbox relay recovered", failedRounds });
        // lote cheio: provavelmente tem mais, não espera
        if (published + failed === this.options.batchSize) delayMs = 0;
      } catch (error) {
        // banco fora do ar, por exemplo: espera cada vez mais e loga só de vez em quando
        delayMs = backoff.failed();
        if (backoff.shouldLog()) {
          this.logger.error({
            msg: "outbox relay round failed",
            error: describeError(error),
            consecutiveFailures: backoff.consecutiveFailures,
            retryInMs: delayMs,
          });
        }
      }
      if (delayMs > 0 && this.running) await this.sleep(delayMs);
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
