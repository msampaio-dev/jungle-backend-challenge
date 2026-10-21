import { expect, test } from "bun:test";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs";
import { DEFAULT_CONSUMER_OPTIONS } from "../../src/infrastructure/messaging/sqs-wager-consumer";

/** Soma das esperas entre a primeira tentativa e a última antes da DLQ. */
function retryWindowSeconds(): number {
  const { maxAttempts, backoffBaseSeconds, backoffMaxSeconds } = DEFAULT_CONSUMER_OPTIONS;
  let total = 0;
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    total += Math.min(backoffBaseSeconds * 2 ** (attempt - 1), backoffMaxSeconds);
  }
  return total;
}

test("a janela de retry do consumidor cobre uma queda de alguns minutos (failover de banco)", () => {
  expect(retryWindowSeconds()).toBeGreaterThanOrEqual(180);
});

test("a política da fila real só age depois do limite da aplicação (rede de segurança)", async () => {
  const sqs = createSqsClient();
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: process.env.SQS_QUEUE_URL, AttributeNames: ["RedrivePolicy"] }),
  );
  const { maxReceiveCount } = JSON.parse(Attributes!.RedrivePolicy!) as { maxReceiveCount: string | number };
  expect(Number(maxReceiveCount)).toBeGreaterThan(DEFAULT_CONSUMER_OPTIONS.maxAttempts);
});

test("o LocalStack só fica saudável depois que todas as filas do script de init existem", async () => {
  const script = await Bun.file("docker/localstack/init-sqs.sh").text();
  const created = [...script.matchAll(/--queue-name\s+(\S+)/g)].map((m) => m[1]!);
  const compose = Bun.YAML.parse(await Bun.file("docker-compose.yml").text()) as {
    services: { localstack: { healthcheck: { test: string[] } } };
  };
  const healthcheck = compose.services.localstack.healthcheck.test.join(" ");

  expect(created).toEqual(["wager-transactions-dlq.fifo", "wager-transactions.fifo", "wagering-events.fifo"]);
  for (const queue of created) expect(healthcheck).toContain(`--queue-name ${queue}`);
});
