/**
 * Quanto esperar por uma referência que ainda não chegou (REFUND antes da
 * BET, por exemplo). Fora de ordem costuma ser questão de milissegundos a
 * segundos; 8 tentativas (~4 min no total) cobrem atrasos normais sem
 * deixar uma devolução de dinheiro pendurada por horas.
 */
export interface ReferenceRetryPolicy {
  /** tentativas de resolver, contando a da chegada da transação */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_REFERENCE_RETRY_POLICY: ReferenceRetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 2_000,
  maxDelayMs: 120_000,
};

/** Próxima checagem depois de `attemptsMade` tentativas: 2s, 4s, 8s... até o teto. */
export function nextReferenceCheckAt(policy: ReferenceRetryPolicy, attemptsMade: number, now: Date): Date {
  const delay = Math.min(policy.baseDelayMs * 2 ** (attemptsMade - 1), policy.maxDelayMs);
  return new Date(now.getTime() + delay);
}

export function referenceAttemptsExhausted(policy: ReferenceRetryPolicy, attemptsMade: number): boolean {
  return attemptsMade >= policy.maxAttempts;
}
