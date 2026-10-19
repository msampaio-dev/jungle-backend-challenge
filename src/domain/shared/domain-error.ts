/**
 * Erro de regra de negócio. Carrega um código estável que a API e o
 * consumidor SQS usam para decidir a resposta, sem depender da mensagem.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, received: string) {
    super(`currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";
}

/** Transação mal formada na entrada (ex.: REFUND sem referência, OPENING externo). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_TRANSACTION";
}

/** Tentativa de transição a partir de estado terminal. Indica bug, não regra de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}

/** Lançamento cuja aritmética não fecha. Indica bug, não regra de negócio. */
export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = "UNBALANCED_LEDGER_ENTRY";
}
