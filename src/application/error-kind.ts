import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
} from "@mikro-orm/core";
import {
  CurrencyMismatchError,
  DomainError,
  InvalidMoneyError,
  InvalidWagerTransactionError,
} from "../domain/shared/domain-error";
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidRequestError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "./errors";

/**
 * Classificação única de erros, usada pela API (status HTTP) e pelo
 * consumidor SQS (ack, retry ou DLQ). Assim os dois canais tratam o
 * mesmo erro do mesmo jeito.
 */
export enum ErrorKind {
  /** payload que nunca vai funcionar: corrigir antes de reenviar */
  InvalidInput = "INVALID_INPUT",
  NotFound = "NOT_FOUND",
  /** chave de idempotência reutilizada com outro payload, ou recurso duplicado */
  Conflict = "CONFLICT",
  /** infraestrutura temporariamente indisponível: reenviar é seguro */
  Transient = "TRANSIENT",
  /** bug ou erro inesperado */
  Unexpected = "UNEXPECTED",
}

// erros de rede do driver pg que não chegam embrulhados pelo ORM
const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "57P01", "57P03", "53300"]);

export function classifyError(error: unknown): ErrorKind {
  if (
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWagerTransactionError ||
    error instanceof CurrencyMismatchError ||
    error instanceof InvalidRequestError
  ) {
    return ErrorKind.InvalidInput;
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) return ErrorKind.NotFound;
  if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) return ErrorKind.Conflict;
  if (
    error instanceof ConnectionException ||
    error instanceof LockWaitTimeoutException ||
    error instanceof DeadlockException
  ) {
    return ErrorKind.Transient;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return ErrorKind.Transient;
  return ErrorKind.Unexpected;
}

/** Código estável para o corpo da resposta. */
export function errorCode(error: unknown): string {
  if (error instanceof DomainError || error instanceof ApplicationError) return error.code;
  return classifyError(error) === ErrorKind.Transient ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR";
}
