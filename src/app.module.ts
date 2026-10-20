import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { HttpModule } from "./interfaces/http/http.module";

@Module({
  imports: [DatabaseModule, HealthModule, HttpModule],
})
export class AppModule {}
