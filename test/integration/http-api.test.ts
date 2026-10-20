import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestApi, type TestApi } from "./support/http";

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await api.close();
});

async function newWallet(amount = "100.00") {
  const playerId = Bun.randomUUIDv7();
  const res = await api.call("POST", "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

function wager(w: { walletId: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
  const body = {
    providerId: "provider-a",
    externalTransactionId,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
  const key = `provider-a:${body.externalTransactionId}`;
  return { body, key, send: (b: unknown = body) => api.call("POST", "/wagering/transactions", b, { "Idempotency-Key": key }) };
}

describe("wallets", () => {
  test("POST /wallets cria com version 1", async () => {
    const playerId = Bun.randomUUIDv7();
    const res = await api.call("POST", "/wallets", { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
  });

  test("wallet duplicada é 409", async () => {
    const w = await newWallet();
    const res = await api.call("POST", "/wallets", { playerId: w.playerId, initialBalance: { amount: "1.00", currency: "BRL" } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test.each([
    ["playerId inválido", { playerId: "x", initialBalance: { amount: "1.00", currency: "BRL" } }],
    ["valor com 3 casas", { playerId: crypto.randomUUID(), initialBalance: { amount: "1.005", currency: "BRL" } }],
    ["valor como number", { playerId: crypto.randomUUID(), initialBalance: { amount: 10, currency: "BRL" } }],
    ["sem initialBalance", { playerId: crypto.randomUUID() }],
  ])("%s é 400", async (_name, body) => {
    expect((await api.call("POST", "/wallets", body)).status).toBe(400);
  });

  test("GET /wallets/:id e 404", async () => {
    const w = await newWallet();
    expect((await api.call("GET", `/wallets/${w.walletId}`)).body.balance.amount).toBe("100.00");
    expect((await api.call("GET", `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await api.call("GET", "/wallets/nao-e-uuid")).status).toBe(400);
  });
});

describe("POST /wagering/transactions — status", () => {
  test("201 na primeira vez, 200 no replay", async () => {
    const w = await newWallet();
    const bet = wager(w);
    const first = await bet.send();
    const replay = await bet.send();

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: "PROCESSED", balance: { amount: "75.00", currency: "BRL" }, idempotentReplay: false });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test("422 em rejeição de negócio, inclusive no replay", async () => {
    const w = await newWallet("10.00");
    const bet = wager(w);
    const first = await bet.send();
    const replay = await bet.send();
    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: { amount: "10.00" } });
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test("202 quando a referência ainda não chegou", async () => {
    const w = await newWallet();
    const res = await wager(w, { kind: "REFUND", referenceExternalTransactionId: "nao-chegou" }).send();
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("PENDING_REFERENCE");
  });

  test("409 com a mesma chave e payload diferente", async () => {
    const w = await newWallet();
    const bet = wager(w);
    await bet.send();
    const res = await bet.send({ ...bet.body, money: { amount: "26.00", currency: "BRL" } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("400 sem Idempotency-Key", async () => {
    const w = await newWallet();
    const res = await api.call("POST", "/wagering/transactions", wager(w).body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUEST");
  });

  test.each([
    ["JSON mal formado", "{ isto não é json"],
    ["dinheiro como number", { money: { amount: 25, currency: "BRL" } }],
    ["notação científica", { money: { amount: "1e2", currency: "BRL" } }],
    ["OPENING externo", { kind: "OPENING" }],
    ["sem money", { money: undefined }],
  ])("400 com %s", async (_name, override) => {
    const w = await newWallet();
    const bet = wager(w);
    const body = typeof override === "string" ? override : { ...bet.body, ...override };
    const res = await bet.send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBeString();
  });

  test("404 com wallet inexistente", async () => {
    const res = await wager({ walletId: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() }).send();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("WALLET_NOT_FOUND");
  });
});

describe("consultas", () => {
  test("transação por id interno e por id externo", async () => {
    const w = await newWallet();
    const bet = wager(w);
    const { body } = await bet.send();

    const byId = await api.call("GET", `/wagering/transactions/${body.transactionId}`);
    const byExternal = await api.call("GET", `/providers/provider-a/wagering/transactions/${bet.body.externalTransactionId}`);

    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ kind: "BET", status: "PROCESSED", money: { amount: "25.00", currency: "BRL" } });
    expect(byExternal.body).toEqual(byId.body);
    expect((await api.call("GET", `/wagering/transactions/${Bun.randomUUIDv7()}`)).status).toBe(404);
  });

  test("extrato paginado por cursor, sem repetir nem pular", async () => {
    const w = await newWallet();
    for (let i = 0; i < 5; i++) await wager(w, { money: { amount: "1.00", currency: "BRL" } }).send();

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
      const page = await api.call("GET", `/wallets/${w.walletId}/ledger${query}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((i: { id: string }) => i.id));
      cursor = page.body.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(6); // OPENING + 5 apostas
    expect(new Set(seen).size).toBe(6);
  });

  test("cursor inválido e limit fora da faixa são 400", async () => {
    const w = await newWallet();
    expect((await api.call("GET", `/wallets/${w.walletId}/ledger?cursor=lixo`)).status).toBe(400);
    expect((await api.call("GET", `/wallets/${w.walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await api.call("GET", `/wallets/${w.walletId}/ledger?limit=1000`)).status).toBe(400);
  });

  test("reconciliação consistente", async () => {
    const w = await newWallet();
    await wager(w).send();
    await wager(w, { kind: "WIN", money: { amount: "10.00", currency: "BRL" } }).send();

    const res = await api.call("POST", `/wallets/${w.walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: w.walletId,
      storedBalance: { amount: "85.00", currency: "BRL" },
      calculatedBalance: { amount: "85.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 3,
    });
  });

  test("reconciliação aponta divergência sem corrigir", async () => {
    const w = await newWallet();
    // simula corrupção: mexe no saldo por fora (o ledger é imutável, a wallet não)
    await api.orm.em.getConnection().execute("update wallets set balance = balance + 5 where id = ?", [w.walletId]);

    const res = await api.call("POST", `/wallets/${w.walletId}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: false, difference: { amount: "5.00" } });
    const after = await api.call("GET", `/wallets/${w.walletId}`);
    expect(after.body.balance.amount).toBe("105.00");
  });
});
