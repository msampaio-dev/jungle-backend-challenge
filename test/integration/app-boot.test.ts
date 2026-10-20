import "reflect-metadata";
import { afterEach, expect, test } from "bun:test";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

test("a app sobe sem variáveis de fila quando relay e consumidor estão desligados", async () => {
  process.env.DATABASE_URL = process.env.DATABASE_TEST_URL;
  process.env.OUTBOX_RELAY_ENABLED = "false";
  process.env.SQS_CONSUMER_ENABLED = "false";
  delete process.env.SQS_EVENTS_QUEUE_URL;
  delete process.env.SQS_QUEUE_URL;
  delete process.env.SQS_DLQ_URL;

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  await app.close();
});

test("com o relay ligado, a variável da fila de eventos continua obrigatória", async () => {
  process.env.DATABASE_URL = process.env.DATABASE_TEST_URL;
  process.env.SQS_CONSUMER_ENABLED = "false";
  delete process.env.OUTBOX_RELAY_ENABLED;
  delete process.env.SQS_EVENTS_QUEUE_URL;

  await expect(NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false })).rejects.toThrow(
    /SQS_EVENTS_QUEUE_URL is not set/,
  );
});
