import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { wageringPorts } from "../../src/infrastructure/wiring";
import { PendingReferenceWorker } from "../../src/application/wagering/pending-reference-worker";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import { startTestApi, type TestApi } from "./support/http";
import { expectLedgerInvariant, intentionallyCorrupted } from "./support/invariant";

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  // a limpeza roda mesmo se a invariante falhar (senão processos e conexões ficariam vivos)
  try {
    await expectLedgerInvariant(api.orm); // invariante final da seção 13, em toda wallet
  } finally {
    await api.close();
  }
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

  test("playerId em maiúsculas é normalizado: POST e GET devolvem o mesmo", async () => {
    const playerId = crypto.randomUUID().toUpperCase();
    const created = await api.call("POST", "/wallets", { playerId, initialBalance: { amount: "1.00", currency: "BRL" } });
    const fetched = await api.call("GET", `/wallets/${created.body.id}`);
    expect(created.body.playerId).toBe(playerId.toLowerCase());
    expect(fetched.body.playerId).toBe(created.body.playerId);
  });

  test("resposta do POST perdida: o retry recebe 409 com o id da wallet existente", async () => {
    const body = { playerId: crypto.randomUUID(), initialBalance: { amount: "1.00", currency: "BRL" } };
    const first = await api.call("POST", "/wallets", body);
    const retry = await api.call("POST", "/wallets", body);
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ code: "WALLET_ALREADY_EXISTS", walletId: first.body.id });
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

  test("422 no replay de transação FAILED: é terminal, reenviar não muda nada", async () => {
    const w = await newWallet();
    const refund = wager(w, { kind: "REFUND", referenceExternalTransactionId: "nunca-chega" });
    const pending = await refund.send();
    expect(pending.status).toBe(202);

    // worker com bug no resolve e limite de 1 falha: a pendente vira FAILED de verdade
    class BuggyUseCase extends ProcessWagerTransactionUseCase {
      override async resolve(): Promise<never> {
        throw new Error("bug no resolve");
      }
    }
    const worker = new PendingReferenceWorker(api.orm, new BuggyUseCase(api.orm, wageringPorts()), wageringPorts(), {
      batchSize: 50, idleDelayMs: 0, leaseMs: 30_000, maxResolutionFailures: 1,
    });
    await api.orm.em
      .getConnection()
      .execute("update wager_transactions set next_attempt_at = now() where id = ?", [pending.body.transactionId]);
    await worker.runOnce();

    const replay = await refund.send();
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ status: "FAILED", failureCode: "PROCESSING_FAILED", idempotentReplay: true });
    expect(replay.headers.get("retry-after")).toBeNull();
  });

  test("202 quando a referência ainda não chegou, dizendo quando consultar de novo", async () => {
    const w = await newWallet();
    const refund = wager(w, { kind: "REFUND", referenceExternalTransactionId: "nao-chegou" });
    const res = await refund.send();
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("PENDING_REFERENCE");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(2);
    expect(Date.parse(res.body.nextReferenceCheckAt)).toBeGreaterThan(Date.now());

    const replay = await refund.send();
    expect(replay.status).toBe(202);
    expect(replay.headers.get("retry-after")).not.toBeNull();
    expect(replay.body.nextReferenceCheckAt).toBe(res.body.nextReferenceCheckAt);

    const view = await api.call("GET", `/wagering/transactions/${res.body.transactionId}`);
    expect(view.body).toMatchObject({ referenceAttempts: 1, nextReferenceCheckAt: res.body.nextReferenceCheckAt });
  });

  test("Retry-After usa o relógio do banco: app atrasada 1h não manda esperar 1h", async () => {
    const w = await newWallet();
    setSystemTime(new Date(Date.now() - 60 * 60 * 1000));
    try {
      const res = await wager(w, { kind: "REFUND", referenceExternalTransactionId: "nao-chegou-skew" }).send();
      expect(res.status).toBe(202);
      expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(2);
    } finally {
      setSystemTime();
    }
  });

  test("transação resolvida não anuncia próxima checagem", async () => {
    const w = await newWallet();
    const res = await wager(w).send();
    expect(res.headers.get("retry-after")).toBeNull();
    expect(res.body.nextReferenceCheckAt).toBeUndefined();
    const view = await api.call("GET", `/wagering/transactions/${res.body.transactionId}`);
    expect(view.body).toMatchObject({ referenceAttempts: 0, nextReferenceCheckAt: null });
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

  test("identificadores longos são 400, não 500", async () => {
    const w = await newWallet();
    const rnd = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
    const bet = wager(w, { externalTransactionId: rnd(3000) });
    expect((await bet.send()).status).toBe(400);
    const res = await api.call("POST", "/wagering/transactions", wager(w).body, { "Idempotency-Key": rnd(3000) });
    expect(res.status).toBe(400);
  });

  test("caractere NUL num identificador é 400, não 500", async () => {
    const w = await newWallet();
    const bet = wager(w, { providerId: "provider" + String.fromCharCode(0) + "a" });
    const res = await bet.send();
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_TRANSACTION", message: "providerId must not contain control characters" });
  });

  test.each(["/wagering/transactions", "/wallets"])("body grande demais em %s é 413, não 500: reenviar nunca vai caber", async (path) => {
    const w = await newWallet();
    const huge = JSON.stringify({ ...wager(w).body, padding: "x".repeat(200_000) });
    const res = await api.call("POST", path, huge, { "Idempotency-Key": `p:huge-${Bun.randomUUIDv7()}` });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  test("404 com wallet inexistente", async () => {
    const res = await wager({ walletId: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() }).send();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("WALLET_NOT_FOUND");
  });

  test("moeda diferente: o saldo observado é o da wallet, na moeda dela, também no replay e no GET", async () => {
    const w = await newWallet("100.00"); // wallet em BRL
    const usd = wager(w, { money: { amount: "10.00", currency: "USD" } });
    const first = await usd.send();
    const replay = await usd.send();
    const view = await api.call("GET", `/wagering/transactions/${first.body.transactionId}`);

    const brl = { amount: "100.00", currency: "BRL" };
    expect(first.body).toMatchObject({ status: "REJECTED", failureCode: "CURRENCY_MISMATCH", balance: brl });
    expect(replay.body.balance).toEqual(brl);
    expect(view.body.resultBalance).toEqual(brl);
    expect(view.body.money).toEqual({ amount: "10.00", currency: "USD" }); // a operação continua em USD
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

  test("caractere NUL no id externo da consulta é 400, não 500", async () => {
    const res = await api.call("GET", "/providers/provider-a/wagering/transactions/ext%00x");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUEST");
  });

  test("cursor com posição fora do bigint do Postgres é 400, não 500", async () => {
    const w = await newWallet();
    const cursorAt = (seq: string) => Buffer.from(JSON.stringify({ seq }), "utf8").toString("base64url");
    // o maior bigint ainda é válido (só não há nada depois dele); um a mais não cabe
    expect((await api.call("GET", `/wallets/${w.walletId}/ledger?cursor=${cursorAt("9223372036854775807")}`)).status).toBe(200);
    const tooBig = await api.call("GET", `/wallets/${w.walletId}/ledger?cursor=${cursorAt("9223372036854775808")}`);
    expect(tooBig.status).toBe(400);
    expect(tooBig.body).toMatchObject({ code: "INVALID_REQUEST", message: "invalid cursor" });
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
      chainBreaks: 0,
    });
  });

  test("reconciliação pega lançamento que não começa onde o anterior terminou", async () => {
    const w = await newWallet(); // OPENING: 0.00 -> 100.00
    intentionallyCorrupted.add(w.walletId);
    const sql = (q: string, p: unknown[]) => api.orm.em.getConnection().execute(q, p);
    const txId = crypto.randomUUID();
    await sql(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, created_at, updated_at)
       values (?, 'p', ?, ?, ?, ?, ?, 'r', 'g', 'BET', 10, 'BRL', 'PROCESSED', now(), now(), now())`,
      [txId, txId, txId, "0".repeat(64), w.walletId, w.playerId],
    );
    // conta certa (50 - 10 = 40), mas começa em 50 e não em 100: elo quebrado
    await sql(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, 'DEBIT', 10, 'BRL', 50, 40, now())`,
      [crypto.randomUUID(), w.walletId, txId],
    );
    await sql("update wallets set balance = 90 where id = ?", [w.walletId]); // soma do ledger = 90: a soma não acusa

    const res = await api.call("POST", `/wallets/${w.walletId}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: false, chainBreaks: 1, difference: { amount: "0.00" } });
  });

  test("reconciliação aponta divergência sem corrigir", async () => {
    const w = await newWallet();
    intentionallyCorrupted.add(w.walletId);
    // simula corrupção: mexe no saldo por fora (o ledger é imutável, a wallet não)
    await api.orm.em.getConnection().execute("update wallets set balance = balance + 5 where id = ?", [w.walletId]);

    const res = await api.call("POST", `/wallets/${w.walletId}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: false, difference: { amount: "5.00" } });
    const after = await api.call("GET", `/wallets/${w.walletId}`);
    expect(after.body.balance.amount).toBe("105.00");
  });
});
