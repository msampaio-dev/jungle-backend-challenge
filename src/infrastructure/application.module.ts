import { Global, Module } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { WalletQueries } from "../application/queries/wallet-queries";
import { ProcessWagerTransactionUseCase } from "../application/wagering/process-wager-transaction.use-case";
import { CreateWalletUseCase } from "../application/wallet/create-wallet.use-case";
import { metrics } from "./observability/metrics";
import { wageringPorts } from "./wiring";

/**
 * Use cases são classes comuns, sem decorators do Nest: este módulo só os
 * monta com as implementações reais das portas. HTTP e SQS recebem a mesma
 * instância de ProcessWagerTransactionUseCase.
 */
@Global()
@Module({
  providers: [
    {
      provide: CreateWalletUseCase,
      useFactory: (orm: MikroORM) => new CreateWalletUseCase(orm, wageringPorts()),
      inject: [MikroORM],
    },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (orm: MikroORM) => new ProcessWagerTransactionUseCase(orm, wageringPorts()),
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
