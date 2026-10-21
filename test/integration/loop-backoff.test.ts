import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { wageringPorts } from "../../src/infrastructure/wiring";
import { ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { ConnectionException } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { ConsoleLogger, Logger } from "@nestjs/common";
import { OutboxRelay } from "../../src/application/outbox/outbox-relay";
import { PendingReferenceWorker } from "../../src/application/wagering/pending-reference-worker";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import { OutboxRepository } from "../../src/infrastructure/database/outbox.repository";
import { WagerTransactionRepository } from "../../src/infrastructure/database/wager-transaction.repository";
import { SqsWagerConsumer } from "../../src/infrastructure/messaging/sqs-wager-consumer";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";
import { createTestOrm } from "./support/database";
import { expectLedgerInvariant } from "./support/invariant";
import { createTestQueue } from "./support/sqs";

/**
 * Laços em segundo plano com a dependência fora do ar: a espera entre
 * rodadas que falham cresce (aqui 20, 40, 80, 160ms...), em vez de martelar
 * o banco e o log no ritmo normal.
 */
let orm: MikroORM;
let lines: Array<Record<string, any>>;
const fast = { baseMs: 20, maxMs: 160 };
const WINDOW_MS = 700;

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  // a limpeza roda mesmo se a invariante falhar (senão processos e conexões ficariam vivos)
  try {
    await expectLedgerInvariant(orm); // invariante final da seção 13, em toda wallet
  } finally {
    await orm.close();
  }
});

afterEach(() => {
  Logger.overrideLogger(new ConsoleLogger());
});

function captureLogs() {
  lines = [];
  Logger.overrideLogger(new JsonLogger((line) => lines.push(JSON.parse(line))));
}

const down = () => new ConnectionException(new Error("db down"));

describe("relay da outbox", () => {
  test("banco fora: tentativas espaçadas cada vez mais, não um laço quente", async () => {
    captureLogs();
    let claims = 0;
    class DownOutbox extends OutboxRepository {
      override async claimDue(): Promise<never> {
        claims++;
        throw down();
      }
    }
    const relay = new OutboxRelay(orm, { publish: async () => {} }, wageringPorts({ outbox: new DownOutbox() }), { batchSize: 50, idleDelayMs: 0, failureBackoff: fast });
    relay.start();
    await Bun.sleep(WINDOW_MS);
    await relay.stop();

    expect(claims).toBeGreaterThanOrEqual(3);
    expect(claims).toBeLessThanOrEqual(10);
    expect(lines.filter((l) => l.msg === "outbox relay round failed").length).toBeLessThanOrEqual(claims);
  });

  test("quando volta, registra uma linha com quantas rodadas falharam", async () => {
    captureLogs();
    let claims = 0;
    class FlakyOutbox extends OutboxRepository {
      override async claimDue(...args: Parameters<OutboxRepository["claimDue"]>) {
        if (++claims <= 3) throw down();
        return super.claimDue(...args);
      }
    }
    const relay = new OutboxRelay(orm, { publish: async () => {} }, wageringPorts({ outbox: new FlakyOutbox() }), { batchSize: 50, idleDelayMs: 10, failureBackoff: fast });
    relay.start();
    await Bun.sleep(WINDOW_MS);
    await relay.stop();

    expect(lines.filter((l) => l.msg === "outbox relay recovered")).toEqual([
      expect.objectContaining({ level: "info", failedRounds: 3 }),
    ]);
  });
});

describe("worker de pendentes", () => {
  test("banco fora: tentativas espaçadas cada vez mais", async () => {
    captureLogs();
    let leases = 0;
    class DownTransactions extends WagerTransactionRepository {
      override async leaseDuePendingReferences(): Promise<never> {
        leases++;
        throw down();
      }
    }
    const worker = new PendingReferenceWorker(
      orm,
      new ProcessWagerTransactionUseCase(orm, wageringPorts()),
      wageringPorts({ transactions: new DownTransactions() }),
      { batchSize: 50, idleDelayMs: 0, leaseMs: 30_000, maxResolutionFailures: 5, failureBackoff: fast },
    );
    worker.start();
    await Bun.sleep(WINDOW_MS);
    await worker.stop();

    expect(leases).toBeGreaterThanOrEqual(3);
    expect(leases).toBeLessThanOrEqual(10);
  });
});

describe("consumidor SQS", () => {
  test("SQS fora: tentativas de leitura espaçadas cada vez mais", async () => {
    captureLogs();
    const dlq = await createTestQueue("backoff-dlq");
    const main = await createTestQueue("backoff-main");
    let receives = 0;
    const downClient = {
      send: (cmd: unknown, opts?: unknown) => {
        if (cmd instanceof ReceiveMessageCommand) {
          receives++;
          return Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
        }
        return main.client.send(cmd as never, opts as never);
      },
    } as unknown as SQSClient;
    const consumer = new SqsWagerConsumer(downClient, orm, new ProcessWagerTransactionUseCase(orm, wageringPorts()), {
      queueUrl: main.queueUrl,
      dlqUrl: dlq.queueUrl,
      consumerName: "backoff",
      waitTimeSeconds: 1,
      maxAttempts: 5,
      backoffBaseSeconds: 0,
      backoffMaxSeconds: 0,
      pollFailureBackoff: fast,
      concurrency: 1, // espaçamento de um leitor só
    });
    consumer.start();
    await Bun.sleep(WINDOW_MS);
    await consumer.stop();

    expect(receives).toBeGreaterThanOrEqual(3);
    expect(receives).toBeLessThanOrEqual(10);
    await main.delete();
    await dlq.delete();
  });

  test("vários leitores com o SQS fora não multiplicam as linhas de log", async () => {
    captureLogs();
    const dlq = await createTestQueue("backoff5-dlq");
    const main = await createTestQueue("backoff5-main");
    let receives = 0;
    const downClient = {
      send: (cmd: unknown, opts?: unknown) => {
        if (!(cmd instanceof ReceiveMessageCommand)) return main.client.send(cmd as never, opts as never);
        receives++;
        return Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
      },
    } as unknown as SQSClient;
    const consumer = new SqsWagerConsumer(downClient, orm, new ProcessWagerTransactionUseCase(orm, wageringPorts()), {
      queueUrl: main.queueUrl, dlqUrl: dlq.queueUrl, consumerName: "backoff5", waitTimeSeconds: 1,
      maxAttempts: 5, backoffBaseSeconds: 0, backoffMaxSeconds: 0, pollFailureBackoff: fast, concurrency: 5,
    });
    consumer.start();
    await Bun.sleep(WINDOW_MS);
    await consumer.stop();

    // regra do FailureBackoff, compartilhado: uma linha por patamar (20, 40, 80, 160ms = 4)
    // e, no teto, uma a cada 10 falhas. Uma por leitor por falha daria ~receives linhas.
    const logged = lines.filter((l) => l.msg === "sqs poll failed").length;
    expect(receives).toBeGreaterThan(10);
    expect(logged).toBeLessThanOrEqual(4 + Math.ceil(receives / 10));
    await main.delete();
    await dlq.delete();
  });
});

test("SIGTERM durante uma espera longa: o consumidor para na hora, não depois dos 10s", async () => {
  const dlq = await createTestQueue("stop-dlq");
  const main = await createTestQueue("stop-main");
  const downClient = {
    send: (cmd: unknown, opts?: unknown) =>
      cmd instanceof ReceiveMessageCommand
        ? Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
        : main.client.send(cmd as never, opts as never),
  } as unknown as SQSClient;
  const consumer = new SqsWagerConsumer(downClient, orm, new ProcessWagerTransactionUseCase(orm, wageringPorts()), {
    queueUrl: main.queueUrl, dlqUrl: dlq.queueUrl, consumerName: "stop", waitTimeSeconds: 1,
    maxAttempts: 5, backoffBaseSeconds: 0, backoffMaxSeconds: 0,
    pollFailureBackoff: { baseMs: 10_000, maxMs: 10_000 },
  });
  consumer.start();
  await Bun.sleep(100); // primeira leitura falhou: está esperando 10s

  const started = performance.now();
  await consumer.stop();
  expect(performance.now() - started).toBeLessThan(1_000);
  await main.delete();
  await dlq.delete();
}, 20_000);

test("ao parar, cada componente registra que parou e quanto tempo levou", async () => {
  captureLogs();
  const dlq = await createTestQueue("stoplog-dlq");
  const main = await createTestQueue("stoplog-main");
  const useCase = new ProcessWagerTransactionUseCase(orm, wageringPorts());
  const relay = new OutboxRelay(orm, { publish: async () => {} }, wageringPorts(), { batchSize: 50, idleDelayMs: 100 });
  const worker = new PendingReferenceWorker(orm, useCase, wageringPorts(), { batchSize: 50, idleDelayMs: 100, leaseMs: 30_000, maxResolutionFailures: 5 });
  const consumer = new SqsWagerConsumer(main.client, orm, useCase, {
    queueUrl: main.queueUrl, dlqUrl: dlq.queueUrl, consumerName: "stoplog", waitTimeSeconds: 1,
    maxAttempts: 5, backoffBaseSeconds: 0, backoffMaxSeconds: 0, concurrency: 2,
  });
  relay.start();
  worker.start();
  consumer.start();
  await Bun.sleep(200);
  await Promise.all([relay.stop(), worker.stop(), consumer.stop()]);

  for (const msg of ["outbox relay stopped", "pending reference worker stopped", "sqs consumer stopped"]) {
    const line = lines.find((l) => l.msg === msg);
    expect(line).toMatchObject({ level: "info" });
    expect(typeof line!.durationMs).toBe("number");
  }
  await main.delete();
  await dlq.delete();
}, 20_000);
