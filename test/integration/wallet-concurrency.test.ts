import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/domain/shared/money";
import { InsufficientFundsError } from "../../src/domain/shared/domain-error";
import { Wallet } from "../../src/domain/wallet/wallet";
import { WalletRepository } from "../../src/infrastructure/database/wallet.repository";
import { createTestOrm } from "./support/database";

/**
 * Concorrência com Postgres real e transações realmente simultâneas
 * (cada uma em sua própria conexão do pool), sem mocks.
 */
let orm: MikroORM;
const repo = new WalletRepository();
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  await orm.close();
});

async function openWallet(initial: string): Promise<string> {
  const { wallet, openingEntry } = Wallet.open({
    id: Bun.randomUUIDv7(),
    playerId: Bun.randomUUIDv7(),
    initialBalance: brl(initial),
    openingTransactionId: Bun.randomUUIDv7(),
    openingEntryId: Bun.randomUUIDv7(),
    at: new Date(),
  });
  await orm.em.fork().transactional((em) => repo.insert(em, wallet, openingEntry));
  return wallet.id;
}

/** Fluxo de débito: trava a carteira, aplica no domínio, grava saldo + lançamento. */
async function debit(walletId: string, amount: string): Promise<"processed" | "insufficient"> {
  try {
    await orm.em.fork().transactional(async (em) => {
      const wallet = await repo.lockById(em, walletId);
      if (!wallet) throw new Error("wallet not found");
      const expectedVersion = wallet.version;
      const entry = wallet.debit(brl(amount), {
        transactionId: Bun.randomUUIDv7(),
        entryId: Bun.randomUUIDv7(),
        at: new Date(),
      });
      await repo.saveMovement(em, wallet, expectedVersion, entry);
    });
    return "processed";
  } catch (error) {
    if (error instanceof InsufficientFundsError) return "insufficient";
    throw error;
  }
}

async function snapshot(walletId: string) {
  const conn = orm.em.getConnection();
  const [wallet] = await conn.execute("select balance, version from wallets where id = ?", [walletId]);
  const [ledger] = await conn.execute(
    `select
       coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(18,2)::text as rebuilt,
       count(*) filter (where direction = 'DEBIT')::int as debits
     from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
  if (!wallet || !ledger) throw new Error(`wallet ${walletId} not found`);
  return {
    balance: String(wallet.balance),
    version: Number(wallet.version),
    rebuilt: String(ledger.rebuilt),
    debits: Number(ledger.debits),
  };
}

describe("concorrência na mesma carteira", () => {
  test("cenário obrigatório: 100.00 com duas apostas simultâneas de 80.00", async () => {
    const walletId = await openWallet("100.00");

    const results = await Promise.all([debit(walletId, "80.00"), debit(walletId, "80.00")]);

    expect(results.sort()).toEqual(["insufficient", "processed"]);
    const state = await snapshot(walletId);
    expect(state.balance).toBe("20.00");
    expect(state.debits).toBe(1);
    expect(state.version).toBe(2);
    expect(state.rebuilt).toBe(state.balance);
  });

  test("50 débitos simultâneos de 5.00 sobre 100.00: exatamente 20 passam", async () => {
    const walletId = await openWallet("100.00");

    const results = await Promise.all(Array.from({ length: 50 }, () => debit(walletId, "5.00")));

    expect(results.filter((r) => r === "processed")).toHaveLength(20);
    expect(results.filter((r) => r === "insufficient")).toHaveLength(30);
    const state = await snapshot(walletId);
    expect(state.balance).toBe("0.00");
    expect(state.debits).toBe(20);
    expect(state.version).toBe(21);
    expect(state.rebuilt).toBe(state.balance);
  });
});

describe("concorrência entre carteiras", () => {
  test("carteiras diferentes processadas em paralelo não interferem", async () => {
    const walletIds = await Promise.all(Array.from({ length: 10 }, () => openWallet("50.00")));

    const results = await Promise.all(
      walletIds.flatMap((id) => [debit(id, "10.00"), debit(id, "10.00"), debit(id, "10.00")]),
    );

    expect(results.every((r) => r === "processed")).toBe(true);
    for (const id of walletIds) {
      const state = await snapshot(id);
      expect(state.balance).toBe("20.00");
      expect(state.rebuilt).toBe(state.balance);
    }
  });
});

describe("proteção extra da version", () => {
  test("gravar com version desatualizada aborta em vez de sobrescrever", async () => {
    const walletId = await openWallet("100.00");

    const attempt = orm.em.fork().transactional(async (em) => {
      const wallet = (await repo.lockById(em, walletId))!;
      const entry = wallet.debit(brl("10.00"), {
        transactionId: Bun.randomUUIDv7(),
        entryId: Bun.randomUUIDv7(),
        at: new Date(),
      });
      await repo.saveMovement(em, wallet, wallet.version - 2, entry); // version errada de propósito
    });

    await expect(attempt).rejects.toThrow(/is not at version/);
    const state = await snapshot(walletId);
    expect(state.balance).toBe("100.00");
    expect(state.debits).toBe(0);
  });
});
