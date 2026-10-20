import { Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { OutboxRelay } from "../../application/outbox/outbox-relay";
import { isEnabled, requiredEnv } from "../config";
import { createSqsClient, SqsEventPublisher } from "./sqs";

@Module({
  providers: [
    {
      provide: OutboxRelay,
      // desligado: nem monta o relay, então a fila de eventos não precisa estar configurada
      useFactory: (orm: MikroORM) =>
        isEnabled("OUTBOX_RELAY_ENABLED")
          ? new OutboxRelay(orm, new SqsEventPublisher(createSqsClient(), requiredEnv("SQS_EVENTS_QUEUE_URL")))
          : null,
      inject: [MikroORM],
    },
  ],
})
export class OutboxModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(OutboxRelay) private readonly relay: OutboxRelay | null) {}

  onApplicationBootstrap(): void {
    this.relay?.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.relay?.stop();
  }
}
