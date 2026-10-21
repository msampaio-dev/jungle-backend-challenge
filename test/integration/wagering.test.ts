import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { wageringPorts } from "../../src/infrastructure/wiring";
import type { MikroORM } from "@mikro-orm/postgresql";
import { IdempotencyConflictError, WalletAlreadyExistsError, WalletNotFoundError } from "../../src/application/errors";
import { CreateWalletUseCase } from "../../src/application/wallet/create-wallet.use-case";
import { InvalidMoneyError, InvalidWagerTransactionError } from "../../src/domain/shared/domain-error";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction";
import { createTestOrm } from "./support/database";
import { expectLedgerInvariant } from "./support/invariant";
import { command, createWallet, processor, snapshot, type TestWallet } from "./support/fixtures";

let orm: MikroORM;
const touched: string[] = [];

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

// invariante final do desafio, conferida depois de cada teste
afterEach(async () => {
  for (const walletId of touched.splice(0)) {
    const state = await snapshot(orm, walletId);
    expect(state.rebuilt).toBe(state.balance);
  }
});

async function wallet(initial = "100.00"): Promise<TestWallet> {
  const w = await createWallet(orm, initial);
  touched.push(w.walletId);
  return w;
}

const run = (cmd: Parameters<ReturnType<typeof processor>["execute"]>[0]) => processor(orm).execute(cmd);

describe("criação de wallet", () => {
  test("gera transação OPENING e crédito no ledger na mesma transação", async () => {
    const w = await wallet("1000.00");
    const [opening] = await orm.em
      .getConnection()
      .execute("select kind, status, amount::text as amount from wager_transactions where wallet_id = ?", [w.walletId]);
    expect(opening).toEqual({ kind: "OPENING", status: "PROCESSED", amount: "1000.00" });
    const state = await snapshot(orm, w.walletId);
    expect(state).toMatchObject({ balance: "1000.00", version: 1, credits: 1 });
  });

  test("saldo inicial zero não gera transação nem lançamento", async () => {
    const w = await wallet("0.00");
    const rows = await orm.em.getConnection().execute("select 1 from wager_transactions where wallet_id = ?", [w.walletId]);
    expect(rows).toHaveLength(0);
  });

  test("segunda wallet do mesmo jogador e moeda é conflito", async () => {
    const w = await wallet();
    await expect(
      new CreateWalletUseCase(orm, wageringPorts()).execute({ playerId: w.playerId, initialBalance: { amount: "1.00", currency: "BRL" } }),
    ).rejects.toThrow(WalletAlreadyExistsError);
  });
});

describe("idempotência", () => {
  test("requisição idêntica devolve o resultado original com idempotentReplay", async () => {
    const w = await wallet();
    const bet = command(w, { amount: "25.00" });

    const first = await run(bet);
    await run(command(w, { amount: "10.00" })); // saldo muda depois
    const replay = await run(bet);

    expect(first).toMatchObject({ status: "PROCESSED", balance: { amount: "75.00" }, idempotentReplay: false });
    expect(replay).toEqual({ ...first, idempotentReplay: true }); // saldo do momento, não o atual
    expect((await snapshot(orm, w.walletId)).debits).toBe(2);
  });

  test("replay de rejeição devolve a mesma rejeição", async () => {
    const w = await wallet("10.00");
    const bet = command(w, { amount: "25.00" });
    const first = await run(bet);
    const replay = await run(bet);
    expect(first).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
    expect(replay).toEqual({ ...first, idempotentReplay: true });
  });

  test("valor equivalente (25 e 25.00) é o mesmo payload", async () => {
    const w = await wallet();
    const bet = command(w, { amount: "25.00" });
    await run(bet);
    const replay = await run({ ...bet, money: { amount: "25", currency: "BRL" } });
    expect(replay.idempotentReplay).toBe(true);
  });

  test("mesma chave com payload diferente é conflito e não muda nada", async () => {
    const w = await wallet();
    const bet = command(w, { amount: "25.00" });
    await run(bet);

    await expect(run({ ...bet, money: { amount: "26.00", currency: "BRL" } })).rejects.toThrow(IdempotencyConflictError);
    expect((await snapshot(orm, w.walletId)).balance).toBe("75.00");
  });

  test("mesmo id externo com outra chave é conflito", async () => {
    const w = await wallet();
    const bet = command(w);
    await run(bet);
    await expect(run({ ...bet, idempotencyKey: "outra-chave" })).rejects.toThrow(IdempotencyConflictError);
  });

  test("a mesma aposta enviada 50 vezes em paralelo gera um único débito", async () => {
    const w = await wallet();
    const bet = command(w, { amount: "25.00" });

    const results = await Promise.all(Array.from({ length: 50 }, () => run(bet)));

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.balance.amount === "75.00")).toBe(true);
    const state = await snapshot(orm, w.walletId);
    expect(state).toMatchObject({ balance: "75.00", debits: 1, version: 2 });
  });
});

describe("validação de entrada (nada é gravado)", () => {
  test.each([
    ["dinheiro inválido", { money: { amount: "10.005", currency: "BRL" } }, InvalidMoneyError],
    ["OPENING externo", { kind: "OPENING" }, InvalidWagerTransactionError],
    ["tipo desconhecido", { kind: "JACKPOT" }, InvalidWagerTransactionError],
    ["walletId que não é UUID", { walletId: "abc" }, InvalidWagerTransactionError],
    ["REFUND sem referência", { kind: "REFUND" }, InvalidWagerTransactionError],
  ])("%s", async (_name, override, error) => {
    const w = await wallet();
    await expect(run({ ...command(w), ...override })).rejects.toThrow(error);
  });

  test("wallet inexistente", async () => {
    const w = await wallet();
    await expect(run(command({ ...w, walletId: Bun.randomUUIDv7() }))).rejects.toThrow(WalletNotFoundError);
  });
});

describe("regras de negócio", () => {
  test("WIN credita", async () => {
    const w = await wallet();
    const result = await run(command(w, { kind: "WIN", amount: "40.00" }));
    expect(result).toMatchObject({ status: "PROCESSED", balance: { amount: "140.00" } });
  });

  test("WIN que passaria do maior saldo armazenável é rejeitado, não vira erro 500", async () => {
    const w = await wallet("9999999999999999.99");
    const result = await run(command(w, { kind: "WIN", amount: "0.01" }));
    expect(result).toMatchObject({ status: "REJECTED", failureCode: "BALANCE_LIMIT_EXCEEDED" });
    expect((await snapshot(orm, w.walletId)).balance).toBe("9999999999999999.99");
  });

  test("LOSS é processado sem mexer no saldo nem no ledger", async () => {
    const w = await wallet();
    const result = await run(command(w, { kind: "LOSS", amount: "0.00" }));
    expect(result).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    const state = await snapshot(orm, w.walletId);
    expect(state).toMatchObject({ version: 1, debits: 0, credits: 1 });
  });

  test("jogador diferente do dono da wallet é rejeitado", async () => {
    const w = await wallet();
    const result = await run(command({ ...w, playerId: Bun.randomUUIDv7() }));
    expect(result).toMatchObject({ status: "REJECTED", failureCode: "PLAYER_WALLET_MISMATCH" });
  });

  test("moeda diferente da wallet é rejeitada", async () => {
    const w = await wallet();
    const result = await run({ ...command(w), money: { amount: "10.00", currency: "USD" } });
    expect(result).toMatchObject({ status: "REJECTED", failureCode: "CURRENCY_MISMATCH" });
  });

  test("REFUND devolve a BET uma única vez", async () => {
    const w = await wallet();
    const bet = command(w, { amount: "30.00" });
    await run(bet);

    const refund = await run(
      command(w, { kind: "REFUND", amount: "30.00", referenceExternalTransactionId: bet.externalTransactionId }),
    );
    const again = await run(
      command(w, { kind: "REFUND", amount: "30.00", referenceExternalTransactionId: bet.externalTransactionId }),
    );

    expect(refund).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    expect(again).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_ALREADY_REVERSED" });
  });

  test.each([
    ["REFUND", "ROLLBACK"],
    ["ROLLBACK", "REFUND"],
  ])("%s e depois %s da mesma BET: só a primeira reversão vale", async (firstKind, secondKind) => {
    const w = await wallet();
    const bet = command(w, { amount: "30.00" });
    await run(bet);
    const ref = { amount: "30.00", referenceExternalTransactionId: bet.externalTransactionId };

    const first = await run(command(w, { kind: firstKind, ...ref }));
    const second = await run(command(w, { kind: secondKind, ...ref }));

    expect(first).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
    expect(second).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_ALREADY_REVERSED" });
    expect((await snapshot(orm, w.walletId)).balance).toBe("100.00");
  });

  test.each(["REFUND", "ROLLBACK"])("WIN de uma BET já desfeita por %s é rejeitado: não há prêmio de aposta devolvida", async (reversal) => {
    const w = await wallet();
    const bet = command(w, { amount: "10.00" });
    await run(bet);
    await run(command(w, { kind: reversal, amount: "10.00", referenceExternalTransactionId: bet.externalTransactionId }));

    const win = await run(command(w, { kind: "WIN", amount: "50.00", referenceExternalTransactionId: bet.externalTransactionId }));

    expect(win).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_ALREADY_REVERSED", balance: { amount: "100.00" } });
    expect(await snapshot(orm, w.walletId)).toMatchObject({ balance: "100.00", credits: 2 }); // abertura e a devolução
  });

  test("vários WINs da mesma BET continuam valendo (rodada com mais de um prêmio)", async () => {
    const w = await wallet();
    const bet = command(w, { amount: "10.00" });
    await run(bet);
    const ref = { kind: "WIN", amount: "30.00", referenceExternalTransactionId: bet.externalTransactionId };

    const first = await run(command(w, ref));
    const second = await run(command(w, ref));

    expect([first.status, second.status]).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Processed]);
    expect(second.balance).toEqual({ amount: "150.00", currency: "BRL" });
  });

  test("REFUND com valor diferente da BET é rejeitado", async () => {
    const w = await wallet();
    const bet = command(w, { amount: "30.00" });
    await run(bet);
    const refund = await run(
      command(w, { kind: "REFUND", amount: "10.00", referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(refund).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_AMOUNT_MISMATCH" });
  });

  test("ROLLBACK de WIN debita; se o prêmio já foi gasto, rejeita com código próprio", async () => {
    const w = await wallet("0.00");
    const win = command(w, { kind: "WIN", amount: "50.00" });
    await run(win);
    await run(command(w, { amount: "40.00" })); // gasta o prêmio

    const rollback = await run(
      command(w, { kind: "ROLLBACK", amount: "50.00", referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(rollback).toMatchObject({ status: "REJECTED", failureCode: "REVERSAL_INSUFFICIENT_FUNDS" });
    expect((await snapshot(orm, w.walletId)).balance).toBe("10.00");
  });

  test("ROLLBACK de BET credita de volta", async () => {
    const w = await wallet();
    const bet = command(w, { amount: "20.00" });
    await run(bet);
    const rollback = await run(
      command(w, { kind: "ROLLBACK", amount: "20.00", referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(rollback).toMatchObject({ status: "PROCESSED", balance: { amount: "100.00" } });
  });

  test("REFUND antes da BET fica PENDING_REFERENCE sem mexer no saldo", async () => {
    const w = await wallet();
    const result = await run(
      command(w, { kind: "REFUND", amount: "30.00", referenceExternalTransactionId: "ainda-nao-chegou" }),
    );
    expect(result).toMatchObject({ status: "PENDING_REFERENCE", balance: { amount: "100.00" } });
    expect((await snapshot(orm, w.walletId)).version).toBe(1);

    // a chegada conta como tentativa 1; a próxima checagem fica para ~2s depois
    const [row] = await orm.em.getConnection().execute(
      "select attempts, extract(epoch from (next_attempt_at - updated_at)) as wait from wager_transactions where id = ?",
      [result.transactionId],
    );
    expect(row?.attempts).toBe(1);
    expect(Number(row?.wait)).toBeCloseTo(2, 0);
  });
});
