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

/**
 * Códigos que indicam "tente de novo": rede do driver pg e códigos SQL que
 * o MikroORM não converte em tipo próprio (ele não mapeia 55P03, por exemplo).
 *  - 55P03 lock_not_available: estourou o lock_timeout esperando a wallet
 *  - 40001 serialization_failure: conflito de concorrência
 *  - 57P01/57P03/53300: banco reiniciando, subindo ou sem conexões livres
 *  - 57014 query_canceled: a consulta passou do statement_timeout
 *  - 25P03 idle_in_transaction_session_timeout: a sessão ficou parada demais
 *    numa transação e o Postgres a encerrou (soltando os locks dela)
 */
const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "55P03",
  "40001",
  "57P01",
  "57P03",
  "53300",
  "57014",
  "25P03",
]);

/**
 * Perda de conexão no meio de uma consulta: o driver pg não põe código
 * nenhum, só a mensagem (o MikroORM a embrulha num DriverException genérico).
 * Comparar texto é frágil, mas é a única pista; as mensagens são do pg.
 */
const CONNECTION_LOST_MESSAGES = [
  "Connection terminated",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
];

/** Erros sem código que ainda assim são infraestrutura indisponível. */
function isConnectionUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // pool sem conexão livre dentro do prazo (pool.acquireTimeoutMillis)
  if (error.name === "KnexTimeoutError") return true;
  return CONNECTION_LOST_MESSAGES.some((text) => error.message.includes(text));
}

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
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return ErrorKind.Transient;
  if (isConnectionUnavailable(error)) return ErrorKind.Transient;
  return ErrorKind.Unexpected;
}

/** Código estável para o corpo da resposta. */
export function errorCode(error: unknown): string {
  if (error instanceof DomainError || error instanceof ApplicationError) return error.code;
  return classifyError(error) === ErrorKind.Transient ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR";
}
