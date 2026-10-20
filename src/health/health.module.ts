import { Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { isEnabled } from "../infrastructure/config";
import { createSqsClient } from "../infrastructure/messaging/sqs";
import { HealthController } from "./health.controller";
import { databaseProbe, type Probe, ReadinessChecker, sqsProbe } from "./readiness";

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: ReadinessChecker,
      useFactory: (orm: MikroORM) => {
        // só exige a fila de quem está ligado: consumidor lê uma, relay publica em outra
        const queueUrls = [
          isEnabled("SQS_CONSUMER_ENABLED") ? process.env.SQS_QUEUE_URL : undefined,
          isEnabled("OUTBOX_RELAY_ENABLED") ? process.env.SQS_EVENTS_QUEUE_URL : undefined,
        ].filter((url): url is string => Boolean(url));
        const sqs = createSqsClient({ requestTimeoutMs: 2_000 });
        const queues: Probe[] = queueUrls.map((url) => sqsProbe(sqs, url));
        return new ReadinessChecker(databaseProbe(orm), queues);
      },
      inject: [MikroORM],
    },
  ],
})
export class HealthModule {}
