import { Logger } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { JsonLogger } from "../observability/json-logger";
import { createOrmConfig } from "./mikro-orm.config";

// Roda fora da app Nest (container migrate): sem isto, os logs do MikroORM
// saíam no formato colorido padrão do Nest, e não em JSON como o resto.
Logger.overrideLogger(new JsonLogger());
const logger = new Logger("Migrate");

// bun run migrate:up | migrate:down
const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  logger.error({ msg: "usage: migrate.ts <up|down>" });
  process.exit(1);
}

// sem os limites de sessão da app: uma migration longa não pode ser cortada no meio
const orm = await MikroORM.init(createOrmConfig(undefined, { sessionTimeouts: false }));
try {
  const migrator = orm.getMigrator();
  const executed = direction === "up" ? await migrator.up() : await migrator.down();
  logger.log({ msg: "migrations finished", direction, executed: executed.map((m) => m.name) });
} finally {
  await orm.close();
}
