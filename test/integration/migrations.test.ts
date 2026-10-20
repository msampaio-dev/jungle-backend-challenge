import { afterAll, beforeAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../../src/infrastructure/database/mikro-orm.config";

/**
 * Seção 4: migrations versionadas e REVERSÍVEIS. Banco próprio, para subir,
 * descer tudo e subir de novo sem mexer no banco dos outros testes.
 */
let orm: MikroORM;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_TEST_URL!);
  const name = "wagering_migrations_test";
  const admin = await MikroORM.init(createOrmConfig(Object.assign(new URL(url), { pathname: "/postgres" }).toString()));
  const exists = await admin.em.getConnection().execute("select 1 from pg_database where datname = ?", [name]);
  if (exists.length === 0) await admin.em.getConnection().execute(`create database "${name}"`);
  await admin.close();

  url.pathname = `/${name}`;
  orm = await MikroORM.init(createOrmConfig(url.toString()));
  await orm.em.getConnection().execute("drop schema public cascade");
  await orm.em.getConnection().execute("create schema public");
});

afterAll(async () => {
  await orm.close();
});

const tables = async () =>
  (await orm.em.getConnection().execute(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by 1",
  )).map((r) => r.table_name as string);

test("sobem num banco vazio, descem por inteiro e sobem de novo", async () => {
  const migrator = orm.getMigrator();
  const total = (await migrator.getPendingMigrations()).length;
  expect(total).toBeGreaterThan(0);

  expect(await migrator.up()).toHaveLength(total);
  expect(await tables()).toEqual(["inbox_messages", "outbox_messages", "wager_transactions", "wallet_ledger_entries", "wallets"]);

  expect(await migrator.down({ to: 0 })).toHaveLength(total);
  expect(await tables()).toEqual([]);
  // funções e triggers também saem: nada sobra para atrapalhar o próximo up
  const functions = await orm.em.getConnection().execute(
    "select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'",
  );
  expect(functions).toEqual([]);

  expect(await migrator.up()).toHaveLength(total);
  expect(await tables()).toHaveLength(5);
});
