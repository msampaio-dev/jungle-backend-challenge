import { afterAll, beforeAll, expect, test } from "bun:test";
import { startTestApi, type TestApi } from "./support/http";

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi({ pendingReferenceWorker: true });
});

afterAll(async () => {
  await api.close();
});

test("a app resolve sozinha o REFUND que chegou antes da BET", async () => {
  const playerId = crypto.randomUUID();
  const wallet = await api.call("POST", "/wallets", { playerId, initialBalance: { amount: "100.00", currency: "BRL" } });
  const walletId = wallet.body.id as string;
  const send = (body: Record<string, unknown>) =>
    api.call(
      "POST",
      "/wagering/transactions",
      { providerId: "provider-a", playerId, walletId, roundId: "r-1", gameId: "g", money: { amount: "30.00", currency: "BRL" }, ...body },
      { "Idempotency-Key": `provider-a:${body.externalTransactionId}` },
    );

  const refund = await send({ externalTransactionId: "refund-1", kind: "REFUND", referenceExternalTransactionId: "bet-1" });
  expect(refund.status).toBe(202);
  expect((await send({ externalTransactionId: "bet-1", kind: "BET" })).status).toBe(201);

  // ninguém chama o worker à mão: a app tem que fazer isso (primeira espera: 2s)
  const deadline = Date.now() + 10_000;
  let status = "PENDING_REFERENCE";
  while (status === "PENDING_REFERENCE" && Date.now() < deadline) {
    await Bun.sleep(250);
    status = (await api.call("GET", `/wagering/transactions/${refund.body.transactionId}`)).body.status;
  }

  expect(status).toBe("PROCESSED");
  expect((await api.call("GET", `/wallets/${walletId}`)).body.balance.amount).toBe("100.00");
}, 20_000);
