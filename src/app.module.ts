import { Module } from "@nestjs/common";
import { ApplicationModule } from "./application/application.module";
import { HealthModule } from "./health/health.module";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { OutboxModule } from "./infrastructure/messaging/outbox.module";
import { SqsConsumerModule } from "./infrastructure/messaging/sqs-consumer.module";
import { MetricsModule } from "./infrastructure/observability/metrics.module";
import { PendingReferenceModule } from "./infrastructure/workers/pending-reference.module";
import { HttpModule } from "./interfaces/http/http.module";

@Module({
  imports: [DatabaseModule, ApplicationModule, HealthModule, HttpModule, OutboxModule, SqsConsumerModule, PendingReferenceModule, MetricsModule],
})
export class AppModule {}
