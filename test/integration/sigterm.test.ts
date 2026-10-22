import { afterAll, beforeAll, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createTestOrm } from "./support/database";
import { expectLedgerInvariant } from "./support/invariant";
import { createTestQueue } from "./support/sqs";

/**
 * SIGTERM de verdade num processo da app, como o orquestrador manda ao
 * parar uma réplica. No Windows não dá para mandar SIGTERM de um processo
 * para outro (vira encerramento forçado), então o teste roda no Linux: na
 * CI e em container.
 */
let orm: MikroORM;
let queues: Array<Awaited<ReturnType<typeof createTestQueue>>> = [];

beforeAll(async () => {
  orm = await createTestOrm();
  queues = await Promise.all(["sigterm-main", "sigterm-dlq", "sigterm-events"].map((name) => createTestQueue(name)));
});

afterAll(async () => {
  try {
    await expectLedgerInvariant(orm);
  } finally {
    await Promise.all(queues.map((q) => q.delete()));
    await orm.close();
  }
});

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  server.stop(true);
  return port!;
}

test.skipIf(process.platform === "win32")(
  "SIGTERM: consumidor, relay e worker param de forma ordenada e o processo termina sozinho",
  async () => {
    const [main, dlq, events] = queues;
    const port = await freePort();
    const app = Bun.spawn([process.execPath, "run", "src/main.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: process.env.DATABASE_TEST_URL,
        SQS_CONSUMER_ENABLED: "true",
        OUTBOX_RELAY_ENABLED: "true",
        PENDING_REFERENCE_WORKER_ENABLED: "true",
        SQS_QUEUE_URL: main!.queueUrl,
        SQS_DLQ_URL: dlq!.queueUrl,
        SQS_EVENTS_QUEUE_URL: events!.queueUrl,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new Response(app.stdout).text();

    const ready = Date.now() + 30_000;
    while (!(await fetch(`http://127.0.0.1:${port}/health/ready`).then((r) => r.ok, () => false))) {
      if (Date.now() > ready) throw new Error("app did not become ready");
      await Bun.sleep(100);
    }

    const signaledAt = performance.now();
    app.kill("SIGTERM");
    const ended = await Promise.race([app.exited.then(() => true), Bun.sleep(25_000).then(() => false)]);
    if (!ended) app.kill("SIGKILL");
    expect(ended).toBe(true); // terminou sozinho, sem precisar de SIGKILL
    expect(performance.now() - signaledAt).toBeLessThan(20_000); // cabe nos 30s do Compose

    // o que prova a parada ordenada: cada componente terminou o que fazia e registrou
    const stopped = (await output)
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line).msg as string)
      .filter((msg) => msg.endsWith("stopped"));
    expect(stopped.sort()).toEqual(["outbox relay stopped", "pending reference worker stopped", "sqs consumer stopped"]);
  },
  40_000,
);
