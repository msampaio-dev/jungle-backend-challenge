import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/domain/shared/money";
import { WagerTransaction, WagerTransactionKind } from "../../src/domain/wagering/wager-transaction";
import { WagerTransactionRepository } from "../../src/infrastructure/database/wager-transaction.repository";
import { WalletRepository } from "../../src/infrastructure/database/wallet.repository";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import { classifyError, ErrorKind } from "../../src/application/error-kind";
import { createTestOrm } from "./support/database";
import { expectLedgerInvariant } from "./support/invariant";
import { command, createWallet, processor, snapshot } from "./support/fixtures";

/**
 * Concorrência com Postgres real e transações realmente simultâneas
 * (cada uma em sua própria conexão do pool), sem mocks.
 */
let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  // a limpeza roda mesmo se a invariante falhar (senão processos e conexões ficariam vivos)
  try {
    await expectLedgerInvariant(orm); // invariante final da seção 13, em toda wallet
  } finally {
    await orm.close();
  }
});

describe("concorrência na mesma carteira", () => {
  test("cenário obrigatório: 100.00 com duas apostas simultâneas de 80.00", async () => {
    const wallet = await createWallet(orm, "100.00");

    const results = await Promise.all([
      processor(orm).execute(command(wallet, { amount: "80.00" })),
      processor(orm).execute(command(wallet, { amount: "80.00" })),
    ]);

    const statuses = results.map((r) => `${r.status}:${r.failureCode ?? "-"}`).sort();
    expect(statuses).toEqual(["PROCESSED:-", "REJECTED:INSUFFICIENT_FUNDS"]);
    const state = await snapshot(orm, wallet.walletId);
    expect(state.balance).toBe("20.00");
    expect(state.debits).toBe(1);
    expect(state.version).toBe(2);
    expect(state.rebuilt).toBe(state.balance);
  });

  test("50 apostas diferentes de 5.00 sobre 100.00: exatamente 20 passam", async () => {
    const wallet = await createWallet(orm, "100.00");

    const results = await Promise.all(
      Array.from({ length: 50 }, () => processor(orm).execute(command(wallet, { amount: "5.00" }))),
    );

    expect(results.filter((r) => r.status === "PROCESSED")).toHaveLength(20);
    expect(results.filter((r) => r.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(30);
    const state = await snapshot(orm, wallet.walletId);
    expect(state.balance).toBe("0.00");
    expect(state.debits).toBe(20);
    expect(state.version).toBe(21);
    expect(state.rebuilt).toBe(state.balance);
  });
});

describe("concorrência entre carteiras", () => {
  test("carteiras diferentes processadas em paralelo não interferem", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(orm, "50.00")));

    const results = await Promise.all(
      wallets.flatMap((w) => [1, 2, 3].map(() => processor(orm).execute(command(w, { amount: "10.00" })))),
    );

    expect(results.every((r) => r.status === "PROCESSED")).toBe(true);
    for (const w of wallets) {
      const state = await snapshot(orm, w.walletId);
      expect(state.balance).toBe("20.00");
      expect(state.rebuilt).toBe(state.balance);
    }
  });
});

describe("proteção extra da version", () => {
  test("gravar com version desatualizada aborta em vez de sobrescrever", async () => {
    const wallet = await createWallet(orm, "100.00");
    const wallets = new WalletRepository();
    const transactions = new WagerTransactionRepository();

    const attempt = orm.em.fork().transactional(async (em) => {
      const locked = (await wallets.lockById(em, wallet.walletId))!;
      const bet = WagerTransaction.create({
        id: Bun.randomUUIDv7(),
        providerId: "provider-a",
        externalTransactionId: "stale",
        idempotencyKey: "provider-a:stale",
        payloadHash: "0".repeat(64),
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        createdAt: new Date(),
      });
      const entry = locked.debit(bet.money, { transactionId: bet.id, entryId: Bun.randomUUIDv7(), at: new Date() });
      bet.markProcessed(undefined, new Date(), locked.balance);
      await transactions.insert(em, bet, new Date());
      await wallets.saveMovement(em, locked, locked.version - 2, entry); // version errada de propósito
    });

    await expect(attempt).rejects.toThrow(/is not at version/);
    const state = await snapshot(orm, wallet.walletId);
    expect(state.balance).toBe("100.00");
    expect(state.debits).toBe(0);
  });
});

describe("espera pelo lock da wallet", () => {
  test("espera longa desiste com erro transitório (503 / retry) em vez de pendurar", async () => {
    const wallet = await createWallet(orm, "100.00");
    const impatient = new ProcessWagerTransactionUseCase(orm, new WalletRepository(300));

    // outra transação segura o lock da wallet por 1,5s
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = orm.em.fork().transactional(async (em) => {
      await new WalletRepository().lockById(em, wallet.walletId);
      locked();
      await held;
    });
    await isLocked;
    setTimeout(release, 1_500);

    const started = performance.now();
    const error = await impatient.execute(command(wallet, { amount: "10.00", externalTransactionId: "lock-1" })).catch((e) => e);
    const waitedMs = performance.now() - started;

    expect(classifyError(error)).toBe(ErrorKind.Transient);
    expect(waitedMs).toBeLessThan(1_200);
    await holder;

    // liberado o lock, a mesma requisição passa (nada ficou gravado pela metade)
    const retry = await impatient.execute(command(wallet, { amount: "10.00", externalTransactionId: "lock-1" }));
    expect(retry).toMatchObject({ status: "PROCESSED", idempotentReplay: false });
    expect((await snapshot(orm, wallet.walletId)).debits).toBe(1);
  });

  test("limite de espera inválido é recusado na configuração", () => {
    expect(() => new WalletRepository(0)).toThrow();
    expect(() => new WalletRepository(1.5)).toThrow();
  });
});
