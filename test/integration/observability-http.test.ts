import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";
import { startTestApi, type TestApi } from "./support/http";
import { expectLedgerInvariant } from "./support/invariant";

let api: TestApi;
const lines: Array<Record<string, any>> = [];

beforeAll(async () => {
  api = await startTestApi({ logger: new JsonLogger((line) => lines.push(JSON.parse(line))) });
});

afterAll(async () => {
  // a limpeza roda mesmo se a invariante falhar (senão processos e conexões ficariam vivos)
  try {
    await expectLedgerInvariant(api.orm); // invariante final da seção 13, em toda wallet
  } finally {
    await api.close();
  }
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function newWallet(headers: Record<string, string> = {}) {
  const playerId = crypto.randomUUID();
  const res = await api.call("POST", "/wallets", { playerId, initialBalance: { amount: "100.00", currency: "BRL" } }, headers);
  return { walletId: res.body.id as string, playerId, res };
}

function bet(w: { walletId: string; playerId: string }, headers: Record<string, string> = {}) {
  const externalTransactionId = `ext-${crypto.randomUUID()}`;
  return api.call(
    "POST",
    "/wagering/transactions",
    {
      providerId: "provider-a",
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    },
    { "Idempotency-Key": `provider-a:${externalTransactionId}`, ...headers },
  );
}

const sql = (q: string, p: unknown[] = []) => api.orm.em.getConnection().execute(q, p);

describe("X-Correlation-Id", () => {
  test("o id recebido volta na resposta, fica na transação e vai para os eventos", async () => {
    const w = await newWallet();
    const res = await bet(w, { "X-Correlation-Id": "prov-req-42" });

    expect(res.headers.get("x-correlation-id")).toBe("prov-req-42");
    const [tx] = await sql("select correlation_id from wager_transactions where id = ?", [res.body.transactionId]);
    expect(tx!.correlation_id).toBe("prov-req-42");
    const events = await sql(
      "select distinct payload->>'correlationId' as c from outbox_messages where payload->'data'->>'transactionId' = ?",
      [res.body.transactionId],
    );
    expect(events).toEqual([{ c: "prov-req-42" }]);
  });

  test("sem o header, um id é gerado e devolvido", async () => {
    const w = await newWallet();
    const res = await bet(w);
    const generated = res.headers.get("x-correlation-id");
    expect(generated).toMatch(UUID);
    const [tx] = await sql("select correlation_id from wager_transactions where id = ?", [res.body.transactionId]);
    expect(tx!.correlation_id).toBe(generated);
  });

  test.each([
    ["longo demais", "x".repeat(300)],
    ["com caracteres estranhos", "abc def<script>"],
  ])("header %s é substituído, sem recusar a aposta", async (_name, value) => {
    const w = await newWallet();
    const res = await bet(w, { "X-Correlation-Id": value });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-correlation-id")).toMatch(UUID);
  });

  test("criação de wallet também usa o id recebido nos eventos de abertura", async () => {
    const w = await newWallet({ "X-Correlation-Id": "prov-wallet-7" });
    expect(w.res.headers.get("x-correlation-id")).toBe("prov-wallet-7");
    const events = await sql("select distinct payload->>'correlationId' as c from outbox_messages where aggregate_id = ?", [w.walletId]);
    expect(events).toEqual([{ c: "prov-wallet-7" }]);
  });
});

describe("X-Instance", () => {
  test("toda resposta diz qual instância atendeu (máquina e processo)", async () => {
    const res = await api.call("GET", "/health/live");
    expect(res.headers.get("x-instance")).toBe(`${require("node:os").hostname()}:${process.pid}`);
  });
});

describe("logs da requisição", () => {
  test("a linha da aposta processada traz todos os ids pedidos e nenhum valor", async () => {
    const w = await newWallet();
    const res = await bet(w, { "X-Correlation-Id": "prov-log-1" });

    const line = lines.find((l) => l.msg === "wager transaction processed" && l.transactionId === res.body.transactionId);
    expect(line).toMatchObject({
      level: "info",
      correlationId: "prov-log-1",
      transactionId: res.body.transactionId,
      walletId: w.walletId,
      providerId: "provider-a",
      status: "PROCESSED",
      kind: "BET",
      channel: "http",
    });
    expect(typeof line!.durationMs).toBe("number");
    expect(JSON.stringify(line)).not.toContain("10.00");
  });

  test("toda requisição gera uma linha de acesso com o correlationId", async () => {
    const res = await api.call("GET", "/wallets/nao-e-uuid", undefined, { "X-Correlation-Id": "prov-access-1" });
    expect(res.status).toBe(400);
    expect(lines.find((l) => l.msg === "http request" && l.correlationId === "prov-access-1")).toMatchObject({
      method: "GET",
      path: "/wallets/nao-e-uuid",
      status: 400,
    });
  });

  test("JSON quebrado também sai com correlação, instância e linha de acesso (o parser roda depois da correlação)", async () => {
    const res = await api.call("POST", "/wagering/transactions", "{ isto não é json", {
      "Idempotency-Key": "k-bad-json",
      "X-Correlation-Id": "prov-bad-json",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("x-correlation-id")).toBe("prov-bad-json");
    expect(res.headers.get("x-instance")).toBeString();
    expect(lines.find((l) => l.msg === "http request" && l.correlationId === "prov-bad-json")).toMatchObject({
      method: "POST",
      path: "/wagering/transactions",
      status: 400,
    });
  });

  test("health e métricas que respondem bem não geram linha de acesso (o healthcheck chama a cada 3s)", async () => {
    for (const path of ["/health/ready", "/health/live", "/metrics"]) {
      const res = await api.call("GET", path, undefined, { "X-Correlation-Id": `probe-${path.replaceAll("/", "-")}` });
      expect(res.status).toBe(200);
    }
    // marco: quando a linha desta requisição aparece, as anteriores já teriam aparecido
    await api.call("GET", "/wallets/nao-e-uuid", undefined, { "X-Correlation-Id": "fence-1" });
    while (!lines.some((l) => l.correlationId === "fence-1")) await Bun.sleep(5);

    const noisy = lines.filter((l) => l.msg === "http request" && /^\/(health|metrics)/.test(l.path));
    expect(noisy).toEqual([]);
  });

  test("health que responde erro continua gerando linha de acesso: aí é sinal, não ruído", async () => {
    const res = await api.call("GET", "/health/nao-existe", undefined, { "X-Correlation-Id": "health-404" });
    expect(res.status).toBe(404);
    expect(lines.find((l) => l.msg === "http request" && l.correlationId === "health-404")).toMatchObject({
      path: "/health/nao-existe",
      status: 404,
    });
  });
});
