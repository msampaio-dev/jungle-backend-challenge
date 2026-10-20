/**
 * Erros da camada de aplicação: não são regra de negócio da transação
 * (essas viram REJECTED com FailureCode), e sim pedidos que não podem
 * nem começar. A API mapeia cada código para um status HTTP.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Parâmetro de consulta ou cabeçalho mal formado (id que não é UUID, cursor inválido...). */
export class InvalidRequestError extends ApplicationError {
  readonly code = "INVALID_REQUEST";
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = "TRANSACTION_NOT_FOUND";
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = "WALLET_NOT_FOUND";
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = "WALLET_ALREADY_EXISTS";
}

/** Mesma chave de idempotência (ou mesmo id externo) com payload diferente. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = "IDEMPOTENCY_CONFLICT";
}
