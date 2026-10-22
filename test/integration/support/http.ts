import "reflect-metadata";
import type { INestApplication, LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { AddressInfo } from "node:net";
import { AppModule } from "../../../src/app.module";
import { configureHttp } from "../../../src/interfaces/http/configure-http";
import { createTestOrm } from "./database";

export interface TestApi {
  orm: MikroORM;
  app: INestApplication;
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers }>;
  close: () => Promise<void>;
}

/** App Nest real ouvindo numa porta livre, apontada para o banco de teste. */
export async function startTestApi(
  options: { pendingReferenceWorker?: boolean; logger?: LoggerService } = {},
): Promise<TestApi> {
  const orm = await createTestOrm();
  process.env.DATABASE_URL = process.env.DATABASE_TEST_URL;
  // a outbox tem testes próprios; aqui o relay só geraria ruído na fila
  process.env.OUTBOX_RELAY_ENABLED = "false";
  process.env.SQS_CONSUMER_ENABLED = "false";
  process.env.PENDING_REFERENCE_WORKER_ENABLED = options.pendingReferenceWorker ? "true" : "false";

  const app = await NestFactory.create(AppModule, { logger: false });
  if (options.logger) app.useLogger(options.logger);
  configureHttp(app); // o mesmo preparo do main.ts
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  return {
    orm,
    app,
    async call(method, path, body, headers = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await response.text();
      // /metrics responde texto no formato do Prometheus, não JSON
      const json = response.headers.get("content-type")?.includes("json");
      return { status: response.status, body: text && json ? JSON.parse(text) : text || undefined, headers: response.headers };
    },
    async close() {
      await app.close();
      await orm.close();
    },
  };
}
