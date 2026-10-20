import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { AddressInfo } from "node:net";
import { AppModule } from "../../../src/app.module";
import { createTestOrm } from "./database";

export interface TestApi {
  orm: MikroORM;
  app: INestApplication;
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers }>;
  close: () => Promise<void>;
}

/** App Nest real ouvindo numa porta livre, apontada para o banco de teste. */
export async function startTestApi(): Promise<TestApi> {
  const orm = await createTestOrm();
  process.env.DATABASE_URL = process.env.DATABASE_TEST_URL;

  const app = await NestFactory.create(AppModule, { logger: false });
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
      return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
    },
    async close() {
      await app.close();
      await orm.close();
    },
  };
}
