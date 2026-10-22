import { afterAll, beforeAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "../../src/infrastructure/database/mikro-orm.config";

/**
 * Seção 4: migrations versionadas e REVERSÍVEIS. Banco próprio, para subir,
 * descer tudo e subir de novo sem mexer no banco dos outros testes.
 */
let orm: MikroORM;
let migrationsUrl: string;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_TEST_URL!);
  const name = "wagering_migrations_test";
  const admin = await MikroORM.init(createOrmConfig(Object.assign(new URL(url), { pathname: "/postgres" }).toString()));
  const exists = await admin.em.getConnection().execute("select 1 from pg_database where datname = ?", [name]);
  if (exists.length === 0) await admin.em.getConnection().execute(`create database "${name}"`);
  await admin.close();

  url.pathname = `/${name}`;
  migrationsUrl = url.toString();
  orm = await MikroORM.init(createOrmConfig(migrationsUrl));
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

/** Roda o script do container migrate e devolve as linhas de stdout e stderr. */
async function runMigrateCli(...args: string[]) {
  const child = Bun.spawn(["bun", "run", "src/infrastructure/database/migrate.ts", ...args], {
    env: { ...process.env, DATABASE_URL: migrationsUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, lines: `${out}\n${err}`.split("\n").filter((l) => l.trim() !== "") };
}

const parsesAsJson = (line: string) => {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
};

test("o script do container migrate também loga em JSON, como a app", async () => {
  const down = await runMigrateCli("down"); // desce a última e sobe de novo: o migrator loga de verdade
  const up = await runMigrateCli("up");
  const usage = await runMigrateCli("sideways");

  expect([down.code, up.code, usage.code]).toEqual([0, 0, 1]);
  const lines = [...down.lines, ...up.lines, ...usage.lines];
  expect(lines.length).toBeGreaterThan(3);
  expect(lines.filter((l) => !parsesAsJson(l))).toEqual([]);
});

test("a moeda do saldo observado é preenchida a partir de dados gravados antes da migration", async () => {
  const migrator = orm.getMigrator();
  const sql = (q: string, p: unknown[] = []) => orm.em.getConnection().execute(q, p);
  // schema de antes da coluna result_currency, sem depender do que outro teste deixou
  await sql("drop schema public cascade");
  await sql("create schema public");
  await migrator.up({ to: "Migration20261021010000OutboxByAggregateIndex" });
  expect((await sql("select 1 from information_schema.columns where table_name = 'wager_transactions' and column_name = 'result_currency'")).length).toBe(0);

  // dados no formato antigo: wallet em BRL, uma rejeição em USD, uma aposta processada e uma pendente
  const wallet = crypto.randomUUID(), player = crypto.randomUUID();
  await sql("insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, 'BRL', 100, 1, now(), now())", [wallet, player]);
  const insertTx = (id: string, ext: string, extra: string, values: string) =>
    sql(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, created_at, updated_at${extra})
       values (?, 'p', ?, ?, repeat('a', 64), ?, ?, 'r', 'g', ${values})`,
      [id, ext, `p:${ext}`, wallet, player],
    );
  const rejectedUsd = crypto.randomUUID(), processed = crypto.randomUUID(), pending = crypto.randomUUID();
  await insertTx(rejectedUsd, "usd-1", ", status, failure_code, result_balance", "'BET', 10, 'USD', now(), now(), 'REJECTED', 'CURRENCY_MISMATCH', 100");
  await insertTx(processed, "bet-1", ", status, result_balance, processed_at", "'LOSS', 0, 'BRL', now(), now(), 'PROCESSED', 100, now()");
  await insertTx(pending, "win-1", ", status, reference_external_transaction_id, attempts, next_attempt_at", "'WIN', 5, 'BRL', now(), now(), 'PENDING_REFERENCE', 'nao-chegou', 1, now()");

  await migrator.up();

  const rows = await sql("select id, result_currency from wager_transactions where wallet_id = ?", [wallet]);
  const currencyOf = Object.fromEntries(rows.map((r) => [r.id, r.result_currency]));
  expect(currencyOf).toEqual({ [rejectedUsd]: "BRL", [processed]: "BRL", [pending]: null });
  // o trigger de linha terminal voltou a valer depois do preenchimento
  await expect(sql("update wager_transactions set updated_at = now() where id = ?", [processed])).rejects.toThrow(/terminal/);
});
