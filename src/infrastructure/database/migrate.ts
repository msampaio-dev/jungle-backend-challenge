import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "./mikro-orm.config";

// bun run migrate:up | migrate:down
const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  console.error("usage: migrate.ts <up|down>");
  process.exit(1);
}

const orm = await MikroORM.init(createOrmConfig());
try {
  const migrator = orm.getMigrator();
  const executed = direction === "up" ? await migrator.up() : await migrator.down();
  console.log(`${direction}: ${executed.map((m) => m.name).join(", ") || "nothing to do"}`);
} finally {
  await orm.close();
}
