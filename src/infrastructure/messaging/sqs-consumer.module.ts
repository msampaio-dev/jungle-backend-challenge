import { Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { ProcessWagerTransactionUseCase } from "../../application/wagering/process-wager-transaction.use-case";
import { isEnabled, requiredEnv } from "../config";
import { createSqsClient } from "./sqs";
import { DEFAULT_CONSUMER_OPTIONS, SqsWagerConsumer } from "./sqs-wager-consumer";

@Module({
  providers: [
    {
      provide: SqsWagerConsumer,
      // desligado: nem monta o consumidor, então as filas não precisam estar configuradas
      useFactory: (orm: MikroORM, useCase: ProcessWagerTransactionUseCase) =>
        isEnabled("SQS_CONSUMER_ENABLED")
          ? new SqsWagerConsumer(
              // o long polling segura a chamada por até waitTimeSeconds: o timeout precisa passar disso
              createSqsClient({ requestTimeoutMs: (DEFAULT_CONSUMER_OPTIONS.waitTimeSeconds + 5) * 1_000 }),
              orm,
              useCase,
              {
                ...DEFAULT_CONSUMER_OPTIONS,
                queueUrl: requiredEnv("SQS_QUEUE_URL"),
                dlqUrl: requiredEnv("SQS_DLQ_URL"),
              },
            )
          : null,
      inject: [MikroORM, ProcessWagerTransactionUseCase],
    },
  ],
})
export class SqsConsumerModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(SqsWagerConsumer) private readonly consumer: SqsWagerConsumer | null) {}

  onApplicationBootstrap(): void {
    this.consumer?.start();
  }

  /** Chamado no SIGTERM (enableShutdownHooks no main.ts). */
  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
  }
}
