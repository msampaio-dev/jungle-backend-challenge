import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../../../src/infrastructure/database/mikro-orm.config";

/**
 * Postgres real do docker compose, num banco separado (wagering_test).
 * Cada arquivo de teste recria o schema do zero e roda as migrations,
 * então os testes também provam que as migrations sobem num banco vazio.
 */
export async function createTestOrm(): Promise<MikroORM> {
  const testUrl = process.env.DATABASE_TEST_URL;
  if (!testUrl) throw new Error("DATABASE_TEST_URL is not set (copy .env.example to .env)");

  await ensureTestDatabase(testUrl);

  const orm = await MikroORM.init(createOrmConfig(testUrl));
  const connection = orm.em.getConnection();
  await connection.execute("drop schema public cascade");
  await connection.execute("create schema public");
  await orm.getMigrator().up();
  return orm;
}

async function ensureTestDatabase(testUrl: string): Promise<void> {
  const url = new URL(testUrl);
  const name = url.pathname.slice(1);
  url.pathname = "/postgres";

  const admin = await MikroORM.init(createOrmConfig(url.toString()));
  try {
    const rows = await admin.em.getConnection().execute("select 1 from pg_database where datname = ?", [name]);
    if (rows.length === 0) await admin.em.getConnection().execute(`create database "${name}"`);
  } finally {
    await admin.close();
  }
}
