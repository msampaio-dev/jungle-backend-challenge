import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { Controller, Get, Inject, Module, type OnModuleInit, Res } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Response } from "express";
import { Gauge } from "prom-client";
import { createSqsClient } from "../messaging/sqs";
import { registry } from "./metrics";

/** Formato Prometheus. Aberto como os health checks (fica atrás da rede interna). */
@Controller("metrics")
export class MetricsController {
  @Get()
  async scrape(@Res() response: Response): Promise<void> {
    response.setHeader("Content-Type", registry.contentType);
    response.send(await registry.metrics());
  }
}

/**
 * Gauges de estado, calculados a cada coleta. Consultam o banco (relógio do
 * banco, o mesmo de occurred_at) e a DLQ; se a fonte estiver fora, o valor
 * vira NaN em vez de derrubar o /metrics inteiro.
 */
class StateGauges implements OnModuleInit {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  onModuleInit(): void {
    const sql = (query: string) => this.orm.em.getConnection().execute(query);
    const dlqUrl = process.env.SQS_DLQ_URL;
    const sqs = dlqUrl ? createSqsClient({ requestTimeoutMs: 2_000 }) : undefined;

    gauge("outbox_pending_messages", "Eventos na outbox ainda não publicados", async () => {
      const [row] = await sql("select count(*)::int as n from outbox_messages where published_at is null");
      return Number(row!.n);
    });
    gauge("outbox_oldest_pending_age_seconds", "Idade do evento pendente mais antigo da outbox (outbox lag)", async () => {
      const [row] = await sql(
        "select coalesce(extract(epoch from clock_timestamp() - min(occurred_at)), 0) as age from outbox_messages where published_at is null",
      );
      return Number(row!.age);
    });
    gauge("wagering_pending_references", "Transações esperando a referência (PENDING_REFERENCE)", async () => {
      const [row] = await sql("select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'");
      return Number(row!.n);
    });
    gauge("sqs_dlq_messages", "Mensagens na DLQ agora (aproximado, segundo o SQS)", async () => {
      if (!sqs || !dlqUrl) return Number.NaN;
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["ApproximateNumberOfMessages"] }),
      );
      return Number(Attributes?.ApproximateNumberOfMessages ?? Number.NaN);
    });
  }
}

function gauge(name: string, help: string, read: () => Promise<number>): void {
  // uma app por processo em produção; nos testes várias sobem no mesmo processo
  registry.removeSingleMetric(name);
  new Gauge({
    name,
    help,
    registers: [registry],
    async collect() {
      try {
        this.set(await read());
      } catch {
        this.set(Number.NaN);
      }
    },
  });
}

@Module({
  controllers: [MetricsController],
  providers: [StateGauges],
})
export class MetricsModule {}
