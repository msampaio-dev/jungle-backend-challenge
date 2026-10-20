import { afterEach, expect, test } from "bun:test";
import { ConsoleLogger, Logger } from "@nestjs/common";
import { createOrmConfig } from "../../src/infrastructure/database/mikro-orm.config";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";

afterEach(() => {
  Logger.overrideLogger(new ConsoleLogger());
});

test("avisos do knex (ex.: conexão caindo) saem pelo logger JSON, sem cores", () => {
  const lines: Array<Record<string, unknown>> = [];
  Logger.overrideLogger(new JsonLogger((line) => lines.push(JSON.parse(line))));

  const log = (createOrmConfig("postgres://x:y@localhost:1/db").driverOptions as { log?: Record<string, (m: unknown) => void> })?.log;
  expect(log).toBeDefined();
  log!.warn!("\u001b[33mConnection Error: Connection ended unexpectedly\u001b[39m");
  log!.error!("pool error");

  expect(lines).toEqual([
    expect.objectContaining({ level: "warn", context: "Knex", msg: "Connection Error: Connection ended unexpectedly" }),
    expect.objectContaining({ level: "error", context: "Knex", msg: "pool error" }),
  ]);
});

test("mensagens do próprio MikroORM também saem pelo logger JSON", () => {
  const lines: Array<Record<string, unknown>> = [];
  Logger.overrideLogger(new JsonLogger((line) => lines.push(JSON.parse(line))));

  const logger = createOrmConfig("postgres://x:y@localhost:1/db").logger as ((m: string) => void) | undefined;
  expect(logger).toBeDefined();
  logger!("[info] MikroORM failed to connect");
  expect(lines[0]).toMatchObject({ context: "MikroORM", msg: "[info] MikroORM failed to connect" });
});
