import { Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { PendingReferenceWorker } from "../../application/wagering/pending-reference-worker";
import { ProcessWagerTransactionUseCase } from "../../application/wagering/process-wager-transaction.use-case";
import { isEnabled } from "../config";

@Module({
  providers: [
    {
      provide: PendingReferenceWorker,
      useFactory: (orm: MikroORM, useCase: ProcessWagerTransactionUseCase) =>
        isEnabled("PENDING_REFERENCE_WORKER_ENABLED") ? new PendingReferenceWorker(orm, useCase) : null,
      inject: [MikroORM, ProcessWagerTransactionUseCase],
    },
  ],
})
export class PendingReferenceModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(PendingReferenceWorker) private readonly worker: PendingReferenceWorker | null) {}

  onApplicationBootstrap(): void {
    this.worker?.start();
  }

  /** Termina a rodada em andamento antes de o banco fechar (o DatabaseModule fecha por último). */
  async onApplicationShutdown(): Promise<void> {
    await this.worker?.stop();
  }
}
