import { Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { OutboxRelay } from "../../application/outbox/outbox-relay";
import { createSqsClient, SqsEventPublisher } from "./sqs";

@Module({
  providers: [
    {
      provide: OutboxRelay,
      useFactory: (orm: MikroORM) => {
        const queueUrl = process.env.SQS_EVENTS_QUEUE_URL;
        if (!queueUrl) throw new Error("SQS_EVENTS_QUEUE_URL is not set");
        return new OutboxRelay(orm, new SqsEventPublisher(createSqsClient(), queueUrl));
      },
      inject: [MikroORM],
    },
  ],
})
export class OutboxModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(OutboxRelay) private readonly relay: OutboxRelay) {}

  onApplicationBootstrap(): void {
    if (process.env.OUTBOX_RELAY_ENABLED !== "false") this.relay.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.relay.stop();
  }
}
