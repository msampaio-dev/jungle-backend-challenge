import { describe, expect, test } from "bun:test";
import { canonicalJson, payloadHash } from "../../src/application/wagering/payload-hash";

const base = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("payload hash (idempotência)", () => {
  test("JSON canônico: a ordem das chaves não muda o resultado, em nenhum nível", () => {
    const shuffled = {
      money: { currency: "BRL", amount: "25.00" },
      kind: "BET",
      gameId: "fortune-chimp",
      roundId: "round-987",
      walletId: base.walletId,
      playerId: base.playerId,
      externalTransactionId: "transaction-123",
      providerId: "provider-a",
    };
    expect(canonicalJson(shuffled)).toBe(canonicalJson(base));
    expect(payloadHash(shuffled)).toBe(payloadHash(base));
  });

  test("campo ausente e campo undefined são o mesmo payload", () => {
    expect(payloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(payloadHash(base));
  });

  test("SHA-256 em hex: 64 caracteres", () => {
    expect(payloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ["valor", { money: { amount: "26.00", currency: "BRL" } }],
    ["moeda", { money: { amount: "25.00", currency: "USD" } }],
    ["tipo", { kind: "WIN" }],
    ["wallet", { walletId: "0192f291-27dd-7d3f-8071-5f8685deef38" }],
    ["rodada", { roundId: "round-988" }],
    ["referência", { referenceExternalTransactionId: "transaction-100" }],
  ])("payload divergente (%s) gera outro hash: mesma chave vira conflito, não replay", (_name, change) => {
    expect(payloadHash({ ...base, ...change })).not.toBe(payloadHash(base));
  });
});
