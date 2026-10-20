import { Logger } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OutboxRepository } from "../../infrastructure/database/outbox.repository";
import type { EventPublisher } from "./event-publisher";

export interface OutboxRelayOptions {
  batchSize: number;
  /** espera entre rodadas quando não há nada para publicar */
  idleDelayMs: number;
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
    return this.orm.em.fork().transactional(async (em) => {
      const messages = await this.outbox.claimDue(em, this.options.batchSize);
      const result = { published: 0, failed: 0 };

      for (const message of messages) {
        try {
          await this.publisher.publish(message);
          message.markPublished(new Date());
          await this.outbox.save(em, message);
          result.published++;
        } catch (error) {
          message.scheduleRetry(new Date());
          await this.outbox.save(em, message, (error as Error).message);
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
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Para de buscar lotes novos e espera o lote em andamento terminar. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let full = false;
      try {
        const { published, failed } = await this.publishBatch();
        full = published + failed === this.options.batchSize;
      } catch (error) {
        // banco fora do ar, por exemplo: tenta de novo na próxima rodada
        this.logger.error({ msg: "outbox relay round failed", error: (error as Error).message });
      }
      // lote cheio: provavelmente tem mais, não espera
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
