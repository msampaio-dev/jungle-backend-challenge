import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/shared/money";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../../src/domain/shared/domain-error";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import {
  type CreateWagerTransactionProps,
  OPENING_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wagering/wager-transaction";
import { LedgerDirection } from "../../src/domain/wallet/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const AT = new Date("2026-10-19T12:00:00.000Z");

let seq = 0;
function tx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const n = ++seq;
  return WagerTransaction.create({
    id: `tx-${n}`,
    providerId: "provider-a",
    externalTransactionId: `ext-${n}`,
    idempotencyKey: `provider-a:ext-${n}`,
    payloadHash: "hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: Kind.Bet,
    money: brl("25.00"),
    createdAt: AT,
    ...overrides,
  });
}

function processed(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const t = tx(overrides);
  t.markProcessed(undefined, AT, brl("100.00"));
  return t;
}

describe("WagerTransaction.create", () => {
  test("nasce em PENDING", () => {
    const t = tx();
    expect(t.status).toBe(Status.Pending);
    expect(t.isTerminal()).toBe(false);
  });

  test("OPENING não pode ser submetido de fora", () => {
    expect(() => tx({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
  });

  test("providerId reservado das transações internas não pode vir de fora", () => {
    expect(() => tx({ providerId: OPENING_PROVIDER_ID })).toThrow(/providerId internal is reserved/);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s exige referência", (kind) => {
    expect(() => tx({ kind })).toThrow(/requires referenceExternalTransactionId/);
  });

  // NUL e outros caracteres de controle: o Postgres recusa NUL em texto, e eles não têm lugar num id
  const NUL = String.fromCharCode(0);
  const LF = String.fromCharCode(10);
  test.each([
    ["providerId", { providerId: "p" + NUL + "x" }],
    ["externalTransactionId", { externalTransactionId: "e" + NUL }],
    ["idempotencyKey", { idempotencyKey: "k" + LF + "k" }],
    ["roundId", { roundId: "r" + NUL }],
    ["gameId", { gameId: NUL + "g" }],
    ["referenceExternalTransactionId", { kind: Kind.Refund, referenceExternalTransactionId: "ref" + NUL }],
  ] as const)("%s com caractere de controle é payload inválido", (field, overrides) => {
    expect(() => tx(overrides as Partial<CreateWagerTransactionProps>)).toThrow(new RegExp(`${field} must not contain control characters`));
  });

  test.each([Kind.Win, Kind.Refund, Kind.Rollback])("%s não pode referenciar a si mesmo: é payload inválido, não pendência", (kind) => {
    expect(() => tx({ kind, externalTransactionId: "same-1", referenceExternalTransactionId: "same-1" })).toThrow(
      /cannot reference itself/,
    );
  });

  test.each([Kind.Bet, Kind.Loss])("%s não aceita referência", (kind) => {
    expect(() => tx({ kind, referenceExternalTransactionId: "ext-0" })).toThrow(InvalidWagerTransactionError);
  });

  test("WIN aceita referência opcional", () => {
    expect(tx({ kind: Kind.Win }).referenceExternalTransactionId).toBeUndefined();
    expect(tx({ kind: Kind.Win, referenceExternalTransactionId: "ext-0" }).referenceExternalTransactionId).toBe("ext-0");
  });

  test("valor zero só é aceito em LOSS", () => {
    expect(tx({ kind: Kind.Loss, money: brl("0.00") }).money.isZero()).toBe(true);
    expect(() => tx({ kind: Kind.Bet, money: brl("0.00") })).toThrow(InvalidWagerTransactionError);
    expect(() => tx({ kind: Kind.Win, money: brl("0.00") })).toThrow(InvalidWagerTransactionError);
  });

  test("correlationId vem da requisição; sem ele, vale o próprio id", () => {
    expect(tx({ correlationId: "corr-1" }).correlationId).toBe("corr-1");
    const plain = tx();
    expect(plain.correlationId).toBe(plain.id);
  });

  test("validate recusa a entrada sem precisar de data (antes de abrir transação no banco)", () => {
    const props = {
      id: "tx-v",
      providerId: "provider-a",
      externalTransactionId: "ext-v",
      idempotencyKey: "provider-a:ext-v",
      payloadHash: "hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: Kind.Bet,
      money: brl("25.00"),
    };
    expect(() => WagerTransaction.validate(props)).not.toThrow();
    expect(() => WagerTransaction.validate({ ...props, kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransaction.validate({ ...props, kind: Kind.Refund })).toThrow(/requires referenceExternalTransactionId/);
  });

  test("campos obrigatórios vazios são recusados", () => {
    expect(() => tx({ roundId: " " })).toThrow(/roundId is required/);
    expect(() => tx({ providerId: "" })).toThrow(/providerId is required/);
  });

  test.each(["providerId", "externalTransactionId", "idempotencyKey", "roundId", "gameId", "referenceExternalTransactionId", "correlationId"])(
    "%s com mais de 255 caracteres é recusado",
    (field) => {
      // só REFUND aceita (e exige) referência; os outros campos são testados numa BET simples
      const base = field === "referenceExternalTransactionId" ? { kind: Kind.Refund } : { kind: Kind.Bet };
      expect(() => tx({ ...base, [field]: "x".repeat(256) })).toThrow(/at most 255/);
      expect(() => tx({ ...base, [field]: "x".repeat(255) })).not.toThrow();
    },
  );
});

describe("transições", () => {
  test("PENDING -> PROCESSED guarda referência, saldo observado e data", () => {
    const t = tx();
    t.markProcessed("ref-1", AT, brl("75.00"));
    expect(t.status).toBe(Status.Processed);
    expect(t.referenceTransactionId).toBe("ref-1");
    expect(t.resultBalance?.toJSON().amount).toBe("75.00");
    expect(t.processedAt).toEqual(AT);
  });

  test("PENDING -> REJECTED guarda código e saldo observado", () => {
    const t = tx();
    t.reject(FailureCode.InsufficientFunds, brl("20.00"));
    expect(t.status).toBe(Status.Rejected);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(t.resultBalance?.toJSON().amount).toBe("20.00");
  });

  test("PENDING_REFERENCE conta tentativas, guarda a próxima checagem e depois resolve", () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: "ext-0" });
    expect(t.referenceAttempts).toBe(0);

    const first = new Date(AT.getTime() + 2_000);
    t.markPendingReference(first);
    expect(t.status).toBe(Status.PendingReference);
    expect(t.referenceAttempts).toBe(1);
    expect(t.nextReferenceCheckAt).toEqual(first);

    const second = new Date(AT.getTime() + 6_000);
    t.markPendingReference(second);
    expect(t.referenceAttempts).toBe(2);
    expect(t.nextReferenceCheckAt).toEqual(second);

    t.markProcessed("ref-1", AT, brl("100.00"));
    expect(t.status).toBe(Status.Processed);
    expect(t.nextReferenceCheckAt).toBeUndefined(); // resolvida: sai da fila do worker
  });

  test("desistir da referência conta a última tentativa e rejeita", () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: "ext-0" });
    t.markPendingReference(AT);
    t.rejectAfterReferenceAttempts(FailureCode.ReferenceNotFound, brl("100.00"));
    expect(t.status).toBe(Status.Rejected);
    expect(t.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(t.referenceAttempts).toBe(2);
    expect(t.nextReferenceCheckAt).toBeUndefined();
  });

  test.each([
    ["PROCESSED", (t: WagerTransaction) => t.markProcessed(undefined, AT, brl("1.00"))],
    ["REJECTED", (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, brl("1.00"))],
    ["FAILED", (t: WagerTransaction) => t.fail(FailureCode.ProcessingFailed)],
  ])("estado terminal %s não aceita nenhuma transição", (_name, toTerminal) => {
    const t = tx();
    toTerminal(t);
    expect(t.isTerminal()).toBe(true);
    expect(() => t.markProcessed(undefined, AT, brl("1.00"))).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference(AT)).toThrow(InvalidTransactionStateError);
    expect(() => t.reject(FailureCode.InsufficientFunds, brl("1.00"))).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.ProcessingFailed)).toThrow(InvalidTransactionStateError);
  });
});

describe("regras por tipo", () => {
  test("direção no ledger", () => {
    expect(tx({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx({ kind: Kind.Refund, referenceExternalTransactionId: "x" }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  test("ROLLBACK inverte a direção da referência", () => {
    const rollback = tx({ kind: Kind.Rollback, referenceExternalTransactionId: "x" });
    expect(rollback.ledgerDirectionFor(processed({ kind: Kind.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processed({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test("LOSS não afeta saldo", () => {
    const loss = tx({ kind: Kind.Loss, money: brl("0.00") });
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test("matchesPayload compara o hash", () => {
    const t = tx({ payloadHash: "abc" });
    expect(t.matchesPayload("abc")).toBe(true);
    expect(t.matchesPayload("abd")).toBe(false);
  });
});

describe("checkReference", () => {
  const refund = () => tx({ kind: Kind.Refund, referenceExternalTransactionId: "x" });
  const rollback = () => tx({ kind: Kind.Rollback, referenceExternalTransactionId: "x" });

  test("REFUND de uma BET processada do mesmo contexto e valor é válido", () => {
    expect(refund().checkReference(processed({ kind: Kind.Bet }))).toBeUndefined();
  });

  test("REFUND só referencia BET", () => {
    expect(refund().checkReference(processed({ kind: Kind.Win }))).toBe(FailureCode.ReferenceInvalidKind);
  });

  test.each([Kind.Bet, Kind.Win])("ROLLBACK aceita %s", (kind) => {
    expect(rollback().checkReference(processed({ kind }))).toBeUndefined();
  });

  test("ROLLBACK aceita REFUND", () => {
    const ref = processed({ kind: Kind.Refund, referenceExternalTransactionId: "y" });
    expect(rollback().checkReference(ref)).toBeUndefined();
  });

  test.each([
    ["provider", { providerId: "provider-b" }],
    ["player", { playerId: "player-2" }],
    ["wallet", { walletId: "wallet-2" }],
    ["rodada", { roundId: "round-2" }],
  ])("referência de outro %s é recusada", (_name, override) => {
    expect(refund().checkReference(processed({ kind: Kind.Bet, ...override }))).toBe(FailureCode.ReferenceMismatch);
  });

  test("referência ainda não processada é recusada", () => {
    expect(refund().checkReference(tx({ kind: Kind.Bet }))).toBe(FailureCode.ReferenceNotProcessed);
  });

  test("valor diferente da referência é recusado (sem reversão parcial)", () => {
    expect(refund().checkReference(processed({ kind: Kind.Bet, money: brl("10.00") }))).toBe(
      FailureCode.ReferenceAmountMismatch,
    );
  });

  test("WIN pode ter valor diferente da BET referenciada", () => {
    const win = tx({ kind: Kind.Win, money: brl("100.00"), referenceExternalTransactionId: "x" });
    expect(win.checkReference(processed({ kind: Kind.Bet }))).toBeUndefined();
  });
});

describe("opening", () => {
  test("nasce PROCESSED, interno e com crédito", () => {
    const t = WagerTransaction.opening({
      id: "tx-open",
      walletId: "wallet-1",
      playerId: "player-1",
      money: brl("1000.00"),
      payloadHash: "hash",
      at: AT,
    });
    expect(t.kind).toBe(Kind.Opening);
    expect(t.status).toBe(Status.Processed);
    expect(t.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(t.resultBalance?.toJSON().amount).toBe("1000.00");
  });
});
