import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createTestOrm } from "./support/database";

/**
 * As garantias do schema, testadas com SQL direto: provam que o banco
 * barra o estado inválido mesmo que o código da aplicação tenha um bug.
 */
let orm: MikroORM;
const sql = (query: string, params: unknown[] = []) => orm.em.getConnection().execute(query, params);

const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";
const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
const TX = "0192f298-345e-7e38-af88-e43f851a819d";

async function insertWallet(id: string, player: string, balance = "100.00", currency = "BRL") {
  await sql(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, 1, now(), now())`,
    [id, player, currency, balance],
  );
}

async function insertEntry(overrides: Partial<Record<string, string>> = {}) {
  const e = {
    id: crypto.randomUUID(),
    walletId: WALLET,
    transactionId: TX,
    direction: "DEBIT",
    amount: "25.00",
    currency: "BRL",
    before: "100.00",
    after: "75.00",
    ...overrides,
  };
  await sql(
    `insert into wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [e.id, e.walletId, e.transactionId, e.direction, e.amount, e.currency, e.before, e.after],
  );
}

beforeAll(async () => {
  orm = await createTestOrm();
  await insertWallet(WALLET, PLAYER);
  await insertEntry();
});

afterAll(async () => {
  await orm.close();
});

describe("wallets", () => {
  test("saldo negativo é recusado pelo CHECK", async () => {
    await expect(insertWallet(crypto.randomUUID(), crypto.randomUUID(), "-0.01")).rejects.toThrow(/balance_check/);
  });

  test("segunda carteira para o mesmo jogador e moeda é recusada", async () => {
    await expect(insertWallet(crypto.randomUUID(), PLAYER)).rejects.toThrow(/wallets_player_currency_uq/);
  });

  test("mesmo jogador pode ter carteira em outra moeda", async () => {
    await insertWallet(crypto.randomUUID(), PLAYER, "10.00", "USD");
  });

  test("UPDATE que deixaria saldo negativo é recusado", async () => {
    await expect(sql("update wallets set balance = balance - 1000 where id = ?", [WALLET])).rejects.toThrow(
      /balance_check/,
    );
  });
});

describe("wallet_ledger_entries", () => {
  test("segundo lançamento da mesma transação na mesma carteira é recusado", async () => {
    await expect(insertEntry({ before: "75.00", after: "50.00" })).rejects.toThrow(
      /ledger_one_entry_per_transaction_uq/,
    );
  });

  test("lançamento cuja conta não fecha é recusado", async () => {
    await expect(insertEntry({ transactionId: crypto.randomUUID(), after: "80.00" })).rejects.toThrow(
      /ledger_arithmetic_ck/,
    );
  });

  test("valor zero é recusado", async () => {
    await expect(
      insertEntry({ transactionId: crypto.randomUUID(), amount: "0.00", after: "100.00" }),
    ).rejects.toThrow(/amount_check/);
  });

  test("moeda diferente da carteira é recusada pela FK composta", async () => {
    await expect(insertEntry({ transactionId: crypto.randomUUID(), currency: "USD" })).rejects.toThrow(
      /ledger_wallet_currency_fk/,
    );
  });

  test.each([
    ["UPDATE", "update wallet_ledger_entries set amount = 1"],
    ["DELETE", "delete from wallet_ledger_entries"],
    ["TRUNCATE", "truncate wallet_ledger_entries"],
  ])("%s é barrado pela trigger", async (_op, query) => {
    await expect(sql(query)).rejects.toThrow(/append-only/);
  });
});
