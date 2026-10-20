import { Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { ProcessWagerTransactionUseCase } from "../../application/wagering/process-wager-transaction.use-case";
import { createSqsClient } from "./sqs";
import { DEFAULT_CONSUMER_OPTIONS, SqsWagerConsumer } from "./sqs-wager-consumer";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

@Module({
  providers: [
    {
      provide: SqsWagerConsumer,
      useFactory: (orm: MikroORM, useCase: ProcessWagerTransactionUseCase) =>
        new SqsWagerConsumer(
          // o long polling segura a chamada por até waitTimeSeconds: o timeout precisa passar disso
          createSqsClient({ requestTimeoutMs: (DEFAULT_CONSUMER_OPTIONS.waitTimeSeconds + 5) * 1_000 }),
          orm,
          useCase,
          {
            ...DEFAULT_CONSUMER_OPTIONS,
            queueUrl: required("SQS_QUEUE_URL"),
            dlqUrl: required("SQS_DLQ_URL"),
          },
        ),
      inject: [MikroORM, ProcessWagerTransactionUseCase],
    },
  ],
})
export class SqsConsumerModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(SqsWagerConsumer) private readonly consumer: SqsWagerConsumer) {}

  onApplicationBootstrap(): void {
    if (process.env.SQS_CONSUMER_ENABLED !== "false") this.consumer.start();
  }

  /** Chamado no SIGTERM (enableShutdownHooks no main.ts). */
  async onApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }
}
