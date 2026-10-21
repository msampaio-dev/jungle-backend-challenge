import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import type { TCPSocketListener } from "bun";
import { MikroORM } from "@mikro-orm/postgresql";
import { databaseProbe, ReadinessChecker, sqsProbe } from "../../src/health/readiness";
import { createOrmConfig } from "../../src/infrastructure/database/mikro-orm.config";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs";
import { startTestApi, type TestApi } from "./support/http";
import { expectLedgerInvariant } from "./support/invariant";
import { createTestQueue } from "./support/sqs";

/** Aceita a conexão e nunca responde: dependência travada, o pior caso. */
let blackhole: TCPSocketListener;
let api: TestApi;
let queue: Awaited<ReturnType<typeof createTestQueue>>;

beforeAll(async () => {
  blackhole = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  api = await startTestApi();
  queue = await createTestQueue("ready");
});

afterAll(async () => {
  // a limpeza roda mesmo se a invariante falhar (senão processos e conexões ficariam vivos)
  try {
    await expectLedgerInvariant(api.orm); // invariante final da seção 13, em toda wallet
  } finally {
    await queue.delete();
    await api.close();
    blackhole.stop(true);
  }
});

const TIMEOUT_MS = 1_000;

describe("ReadinessChecker", () => {
  test("tudo no ar: ok", async () => {
    const checker = new ReadinessChecker(
      databaseProbe(api.orm),
      [sqsProbe(queue.client, queue.queueUrl)],
      TIMEOUT_MS,
    );
    expect(await checker.check()).toEqual({ status: "ok", checks: { database: "up", sqs: "up" } });
  });

  test("banco travado: unavailable, e responde rápido mesmo assim", async () => {
    const stuckOrm = await MikroORM.init({
      ...createOrmConfig(`postgres://x:y@127.0.0.1:${blackhole.port}/db`),
      connect: false,
    });
    const checker = new ReadinessChecker(databaseProbe(stuckOrm), [sqsProbe(queue.client, queue.queueUrl)], TIMEOUT_MS);

    const started = performance.now();
    expect(await checker.check()).toEqual({ status: "unavailable", checks: { database: "down", sqs: "up" } });
    expect(performance.now() - started).toBeLessThan(3_000);
    void stuckOrm.close(true).catch(() => {});
  });

  test("SQS travado: unavailable", async () => {
    const stuckSqs = createSqsClient({ endpoint: `http://127.0.0.1:${blackhole.port}`, requestTimeoutMs: 5_000 });
    const checker = new ReadinessChecker(
      databaseProbe(api.orm),
      [sqsProbe(stuckSqs, `http://127.0.0.1:${blackhole.port}/000000000000/q.fifo`)],
      TIMEOUT_MS,
    );
    const started = performance.now();
    expect(await checker.check()).toEqual({ status: "unavailable", checks: { database: "up", sqs: "down" } });
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test("sem componente de fila ligado, o SQS não é exigido", async () => {
    const checker = new ReadinessChecker(databaseProbe(api.orm), [], TIMEOUT_MS);
    expect(await checker.check()).toEqual({ status: "ok", checks: { database: "up", sqs: "disabled" } });
  });
});

describe("GET /health/ready", () => {
  test("responde pela API real, sem autenticação", async () => {
    const res = await api.call("GET", "/health/ready");
    expect(res.status).toBe(200);
    // na API de teste o relay e o consumidor estão desligados
    expect(res.body).toEqual({ status: "ok", checks: { database: "up", sqs: "disabled" } });
  });

  test("liveness continua sem consultar nada", async () => {
    const res = await api.call("GET", "/health/live");
    expect(res).toMatchObject({ status: 200, body: { status: "ok" } });
  });
});

describe("readiness com o consumidor ligado", () => {
  test("DLQ inalcançável deixa a instância fora: sem ela, mensagem que nunca vai funcionar não sai da fila", async () => {
    const main = await createTestQueue("ready-consumer");
    const saved = { ...process.env };
    Object.assign(process.env, {
      DATABASE_URL: process.env.DATABASE_TEST_URL,
      SQS_CONSUMER_ENABLED: "true",
      OUTBOX_RELAY_ENABLED: "false",
      PENDING_REFERENCE_WORKER_ENABLED: "false",
      SQS_QUEUE_URL: main.queueUrl,
      SQS_DLQ_URL: `${main.queueUrl.replace(/\.fifo$/, "")}-nao-existe.fifo`,
    });
    const app = await NestFactory.create(AppModule, { logger: false });
    try {
      await app.listen(0, "127.0.0.1");
      const { port } = app.getHttpServer().address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: "unavailable", checks: { database: "up", sqs: "down" } });
    } finally {
      await app.close();
      // devolve o ambiente como estava (atribuir undefined gravaria o texto "undefined")
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await main.delete();
    }
  });
});
