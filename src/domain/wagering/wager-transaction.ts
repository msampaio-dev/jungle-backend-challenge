import { Money } from "../shared/money";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "../shared/domain-error";
import { LedgerDirection } from "../wallet/wallet-ledger-entry";
import { FailureCode } from "./failure-code";

export enum WagerTransactionKind {
  Opening = "OPENING", // interno: crédito de abertura da wallet
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Que tipo cada operação pode referenciar. */
const ALLOWED_REFERENCES: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
  /** rastreio da requisição de origem; sem ele, vale o próprio id */
  correlationId?: string | undefined;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, "roundId" | "gameId"> {
  roundId: string | undefined;
  gameId: string | undefined;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  resultBalance: Money | undefined;
  processedAt: Date | undefined;
  referenceAttempts: number;
  nextReferenceCheckAt: Date | undefined;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  at: Date;
}

export const OPENING_PROVIDER_ID = "internal";

/** Tamanho máximo dos identificadores vindos do provedor (também é CHECK no banco). */
export const MAX_IDENTIFIER_LENGTH = 255;

/**
 * Transições válidas:
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PROCESSED, REJECTED, FAILED: terminais, não mudam mais.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _resultBalance?: Money,
    private _processedAt?: Date,
    /** tentativas de resolver a referência (a da chegada conta como a primeira) */
    private _referenceAttempts = 0,
    private _nextReferenceCheckAt?: Date,
    private readonly _correlationId?: string,
  ) {}

  /** Nasce em PENDING. Valida a forma da transação vinda de um provedor. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.validate(props);
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      props.correlationId,
    );
  }

  /**
   * As mesmas regras do create, sem precisar da data: permite recusar um
   * payload inválido antes de abrir transação no banco, e só carimbar a data
   * (relógio do banco) depois, já dentro dela.
   */
  static validate(props: Omit<CreateWagerTransactionProps, "createdAt">): void {
    const { kind, money, referenceExternalTransactionId: reference } = props;

    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING is internal and cannot be submitted");
    }
    // namespace das transações internas: um provedor com esse id dividiria
    // as chaves únicas (idempotência, id externo) com as OPENING
    if (props.providerId === OPENING_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(`providerId ${OPENING_PROVIDER_ID} is reserved`);
    }
    if (!Object.values(WagerTransactionKind).includes(kind)) {
      throw new InvalidWagerTransactionError(`unknown kind: ${String(kind)}`);
    }
    for (const field of ["providerId", "externalTransactionId", "idempotencyKey", "roundId", "gameId"] as const) {
      if (typeof props[field] !== "string" || props[field].trim() === "") {
        throw new InvalidWagerTransactionError(`${field} is required`);
      }
    }
    for (const field of [
      "providerId",
      "externalTransactionId",
      "idempotencyKey",
      "roundId",
      "gameId",
      "referenceExternalTransactionId",
      "correlationId",
    ] as const) {
      const value = props[field];
      if (typeof value === "string" && value.length > MAX_IDENTIFIER_LENGTH) {
        throw new InvalidWagerTransactionError(`${field} must have at most ${MAX_IDENTIFIER_LENGTH} characters`);
      }
    }
    if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !reference) {
      throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
    }
    if ((kind === WagerTransactionKind.Bet || kind === WagerTransactionKind.Loss) && reference) {
      throw new InvalidWagerTransactionError(`${kind} does not accept a reference`);
    }
    // LOSS só registra o resultado; os demais movimentam dinheiro e precisam de valor positivo
    if (kind === WagerTransactionKind.Loss ? money.isNegative() : !money.isPositive()) {
      throw new InvalidWagerTransactionError(`invalid amount ${money} for ${kind}`);
    }
  }

  /** Crédito interno de abertura da wallet, já processado. */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    const tx = new WagerTransaction(
      props.id,
      OPENING_PROVIDER_ID,
      `opening:${props.walletId}`,
      `opening:${props.walletId}`,
      props.payloadHash,
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.at,
      WagerTransactionStatus.Pending,
    );
    tx.markProcessed(undefined, props.at, props.money);
    return tx;
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.resultBalance,
      state.processedAt,
      state.referenceAttempts,
      state.nextReferenceCheckAt,
      state.correlationId,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  /** Saldo da wallet observado quando a transação foi resolvida (para o replay). */
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /** Rastreio da requisição que criou a transação (ou o próprio id). */
  get correlationId(): string {
    return this._correlationId ?? this.id;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  /** Quando o worker deve tentar de novo. Só existe em PENDING_REFERENCE. */
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.assertNotTerminal("markProcessed");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultBalance = resultBalance;
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
  }

  /** Mais uma tentativa sem achar a referência; a próxima fica para nextCheckAt. */
  markPendingReference(nextCheckAt: Date): void {
    this.assertNotTerminal("markPendingReference");
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = nextCheckAt;
  }

  reject(code: FailureCode, observedBalance: Money): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = observedBalance;
    this._nextReferenceCheckAt = undefined;
  }

  /** Última tentativa sem conseguir resolver a referência: conta a tentativa e rejeita. */
  rejectAfterReferenceAttempts(code: FailureCode, observedBalance: Money): void {
    this.assertNotTerminal("rejectAfterReferenceAttempts");
    this._referenceAttempts += 1;
    this.reject(code, observedBalance);
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
  }

  // ---- consultas

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK inverte a direção da referência; os demais têm direção fixa. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidWagerTransactionError("ROLLBACK needs the reference to know its direction");
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError("LOSS does not move balance");
    }
  }

  /**
   * Confere se a referência pode ser usada por esta transação. Não cobre
   * "já revertida": isso depende de outras transações e fica no banco.
   */
  checkReference(reference: WagerTransaction): FailureCode | undefined {
    const allowed = ALLOWED_REFERENCES[this.kind] ?? [];
    if (!allowed.includes(reference.kind)) return FailureCode.ReferenceInvalidKind;

    const sameContext =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.roundId === this.roundId &&
      reference.money.currency === this.money.currency;
    if (!sameContext) return FailureCode.ReferenceMismatch;

    if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

    if (this.requiresReference() && !reference.money.equals(this.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }
    return undefined;
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`${transition} on terminal transaction ${this.id} (${this._status})`);
    }
  }
}
