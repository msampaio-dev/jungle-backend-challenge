import { Global, Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { metrics } from "../infrastructure/observability/metrics";
import { WalletQueries } from "./queries/wallet-queries";
import { ProcessWagerTransactionUseCase } from "./wagering/process-wager-transaction.use-case";
import { CreateWalletUseCase } from "./wallet/create-wallet.use-case";

/**
 * Use cases são classes comuns, sem decorators do Nest: este módulo só os
 * monta. HTTP e SQS recebem a mesma instância de ProcessWagerTransactionUseCase.
 */
@Global()
@Module({
  providers: [
    { provide: CreateWalletUseCase, useFactory: (orm: MikroORM) => new CreateWalletUseCase(orm), inject: [MikroORM] },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (orm: MikroORM) => new ProcessWagerTransactionUseCase(orm),
      inject: [MikroORM],
    },
    {
      provide: WalletQueries,
      useFactory: (orm: MikroORM) => new WalletQueries(orm, () => metrics.reconciliationDivergences.inc()),
      inject: [MikroORM],
    },
  ],
  exports: [CreateWalletUseCase, ProcessWagerTransactionUseCase, WalletQueries],
})
export class ApplicationModule {}
