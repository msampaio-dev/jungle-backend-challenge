import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TCPSocketListener } from "bun";
import { MikroORM } from "@mikro-orm/postgresql";
import { databaseProbe, ReadinessChecker, sqsProbe } from "../../src/health/readiness";
import { createOrmConfig } from "../../src/infrastructure/database/mikro-orm.config";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs";
import { startTestApi, type TestApi } from "./support/http";
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
  await queue.delete();
  await api.close();
  blackhole.stop(true);
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
