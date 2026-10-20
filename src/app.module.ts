import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { OutboxModule } from "./infrastructure/messaging/outbox.module";
import { HttpModule } from "./interfaces/http/http.module";

@Module({
  imports: [DatabaseModule, HealthModule, HttpModule, OutboxModule],
})
export class AppModule {}
