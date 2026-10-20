import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { CorrelationMiddleware } from "./correlation.middleware";
import { ErrorFilter } from "./error.filter";
import { ProviderAuthGuard } from "./provider-auth.guard";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

@Module({
  controllers: [WalletsController, WageringController],
  providers: [ProviderAuthGuard, { provide: APP_FILTER, useClass: ErrorFilter }],
})
export class HttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
