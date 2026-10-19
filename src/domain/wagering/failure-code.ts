/**
 * Motivo estável e legível por máquina para REJECTED e FAILED.
 * O provedor decide pelo código se reenvia, corrige o payload ou desiste.
 */
export enum FailureCode {
  // regra de negócio: reenviar o mesmo payload não muda o resultado
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",

  // referência (REFUND, ROLLBACK, WIN com referência)
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceInvalidKind = "REFERENCE_INVALID_KIND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",

  // infraestrutura: erro permanente depois de esgotar as tentativas
  ProcessingFailed = "PROCESSING_FAILED",
}
