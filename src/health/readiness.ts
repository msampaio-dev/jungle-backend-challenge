import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";

export type Probe = () => Promise<void>;

export interface ReadinessReport {
  status: "ok" | "unavailable";
  checks: { database: "up" | "down"; sqs: "up" | "down" | "disabled" };
}

export function databaseProbe(orm: MikroORM): Probe {
  return async () => {
    await orm.em.getConnection().execute("select 1");
  };
}

export function sqsProbe(client: SQSClient, queueUrl: string): Probe {
  return async () => {
    await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }));
  };
}

/**
 * Readiness: a instância consegue trabalhar agora? Checa o Postgres e as
 * filas dos componentes ligados, em paralelo e cada um com prazo curto:
 * dependência travada não pode travar o próprio health check (o
 * orquestrador o chama o tempo todo). Sem componente de fila ligado, o SQS
 * não é exigido.
 */
export class ReadinessChecker {
  constructor(
    private readonly database: Probe,
    private readonly queues: Probe[],
    private readonly timeoutMs = 2_000,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [database, ...queues] = await Promise.all([this.database, ...this.queues].map((probe) => this.up(probe)));
    const sqs = this.queues.length === 0 ? "disabled" : queues.every(Boolean) ? "up" : "down";
    const report: ReadinessReport["checks"] = { database: database ? "up" : "down", sqs };
    return { status: database && sqs !== "down" ? "ok" : "unavailable", checks: report };
  }

  private async up(probe: Probe): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.timeoutMs);
    });
    try {
      return await Promise.race([probe().then(() => true as const), deadline]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
