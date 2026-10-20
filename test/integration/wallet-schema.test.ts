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

/** Transação mínima válida. `fields` sobrescreve colunas. */
async function insertTransaction(id: string, fields: Partial<Record<string, string | null>> = {}) {
  const row: Record<string, string | null> = {
    id,
    provider_id: "provider-a",
    external_transaction_id: id,
    idempotency_key: id,
    payload_hash: "0".repeat(64),
    wallet_id: WALLET,
    player_id: PLAYER,
    round_id: "round-1",
    game_id: "fortune-chimp",
    kind: "BET",
    amount: "25.00",
    currency: "BRL",
    status: "PENDING",
    ...fields,
  };
  const columns = Object.keys(row);
  await sql(
    `insert into wager_transactions (${columns.join(", ")}, created_at, updated_at)
     values (${columns.map(() => "?").join(", ")}, now(), now())
     on conflict (id) do nothing`,
    Object.values(row),
  );
}

async function insertEntry(overrides: Partial<Record<string, string>> = {}) {
  await insertTransaction(overrides.transactionId ?? TX);
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

  test("lançamento não pode apontar para transação de outra carteira", async () => {
    const otherWallet = crypto.randomUUID();
    const otherPlayer = crypto.randomUUID();
    await insertWallet(otherWallet, otherPlayer);
    const foreignTx = crypto.randomUUID();
    await insertTransaction(foreignTx, { wallet_id: otherWallet, player_id: otherPlayer });

    await expect(insertEntry({ transactionId: foreignTx })).rejects.toThrow(/ledger_transaction_wallet_fk/);
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

describe("wager_transactions", () => {
  test.each(["provider_id", "external_transaction_id", "idempotency_key", "round_id", "game_id", "reference_external_transaction_id"])(
    "%s acima de 255 caracteres é recusado pelo CHECK",
    async (column) => {
      const fields: Record<string, string> = { [column]: "x".repeat(256) };
      if (column === "reference_external_transaction_id") fields.kind = "WIN";
      await expect(insertTransaction(crypto.randomUUID(), fields)).rejects.toThrow(/wager_tx_identifier_length_ck/);
    },
  );

  test("mesma chave de idempotência no mesmo provedor é recusada", async () => {
    const first = crypto.randomUUID();
    await insertTransaction(first, { idempotency_key: "provider-a:dup" });
    await expect(
      insertTransaction(crypto.randomUUID(), { idempotency_key: "provider-a:dup" }),
    ).rejects.toThrow(/wager_tx_idempotency_uq/);
  });

  test("mesmo id externo no mesmo provedor é recusado", async () => {
    await insertTransaction(crypto.randomUUID(), { external_transaction_id: "ext-dup" });
    await expect(insertTransaction(crypto.randomUUID(), { external_transaction_id: "ext-dup" })).rejects.toThrow(
      /wager_tx_external_id_uq/,
    );
  });

  test("REFUND sem referência é recusado", async () => {
    await expect(insertTransaction(crypto.randomUUID(), { kind: "REFUND" })).rejects.toThrow(
      /wager_tx_reference_required_ck/,
    );
  });

  test("REJECTED sem failure_code é recusado", async () => {
    await expect(insertTransaction(crypto.randomUUID(), { status: "REJECTED" })).rejects.toThrow(
      /wager_tx_failure_code_ck/,
    );
  });

  test("transação terminal não pode mudar de estado", async () => {
    const id = crypto.randomUUID();
    await insertTransaction(id, { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    await expect(sql("update wager_transactions set status = 'PENDING', failure_code = null where id = ?", [id]))
      .rejects.toThrow(/is terminal/);
  });

  test("dados de negócio não mudam nem em estado pendente", async () => {
    const id = crypto.randomUUID();
    await insertTransaction(id);
    await expect(sql("update wager_transactions set amount = 1 where id = ?", [id])).rejects.toThrow(
      /business fields are immutable/,
    );
  });

  test("transação pendente pode ser resolvida", async () => {
    const id = crypto.randomUUID();
    await insertTransaction(id);
    await sql("update wager_transactions set status = 'PROCESSED', processed_at = now() where id = ?", [id]);
  });

  test("DELETE é barrado", async () => {
    await expect(sql("delete from wager_transactions")).rejects.toThrow(/append-only/);
  });

  test.each([
    ["REFUND", "REFUND"],
    ["REFUND", "ROLLBACK"],
  ])("a mesma referência só pode ser revertida uma vez (%s e depois %s)", async (firstKind, secondKind) => {
    const now = new Date().toISOString();
    const bet = crypto.randomUUID();
    await insertTransaction(bet, { status: "PROCESSED", processed_at: now });
    const reversal = (kind: string) =>
      insertTransaction(crypto.randomUUID(), {
        kind,
        reference_external_transaction_id: bet,
        reference_transaction_id: bet,
        status: "PROCESSED",
        processed_at: now,
      });

    await reversal(firstKind);
    await expect(reversal(secondKind)).rejects.toThrow(/wager_tx_single_reversal_uq/);
  });
});
