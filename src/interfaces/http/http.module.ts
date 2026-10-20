import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { WalletQueries } from "../../application/queries/wallet-queries";
import { ProcessWagerTransactionUseCase } from "../../application/wagering/process-wager-transaction.use-case";
import { CreateWalletUseCase } from "../../application/wallet/create-wallet.use-case";
import { ErrorFilter } from "./error.filter";
import { ProviderAuthGuard } from "./provider-auth.guard";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

// Use cases são classes comuns, sem decorators do Nest: o módulo só os monta.
@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    ProviderAuthGuard,
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: CreateWalletUseCase, useFactory: (orm: MikroORM) => new CreateWalletUseCase(orm), inject: [MikroORM] },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (orm: MikroORM) => new ProcessWagerTransactionUseCase(orm),
      inject: [MikroORM],
    },
    { provide: WalletQueries, useFactory: (orm: MikroORM) => new WalletQueries(orm), inject: [MikroORM] },
  ],
})
export class HttpModule {}
