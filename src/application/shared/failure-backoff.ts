export interface FailureBackoffOptions {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_FAILURE_BACKOFF: FailureBackoffOptions = { baseMs: 1_000, maxMs: 10_000 };

/** No teto, uma linha de log a cada tantas falhas seguidas. */
const LOG_EVERY_AT_MAX = 10;

/**
 * Espera entre rodadas de um laço em segundo plano quando a dependência
 * (banco, SQS) está fora: dobra a cada falha seguida (1s, 2s, 4s, 8s, 10s)
 * e volta ao começo no primeiro sucesso. Sem isso, os laços martelavam a
 * dependência e o log no ritmo normal durante toda a queda. Teto de 10s:
 * depois de uma queda longa, o laço percebe a volta em no máximo 10s.
 */
export class FailureBackoff {
  private failures = 0;
  private lastDelayMs = 0;
  private lastLoggedDelayMs = 0;

  constructor(private readonly options: FailureBackoffOptions = DEFAULT_FAILURE_BACKOFF) {}

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Registra uma falha e devolve quanto esperar antes da próxima rodada. */
  failed(): number {
    this.failures += 1;
    this.lastDelayMs = Math.min(this.options.baseMs * 2 ** (this.failures - 1), this.options.maxMs);
    return this.lastDelayMs;
  }

  /**
   * Vale a pena logar esta falha? A primeira e cada mudança de patamar da
   * espera; já no teto, uma a cada 10. Numa queda de 10 min: ~25 linhas,
   * não mil.
   */
  shouldLog(): boolean {
    const changed = this.lastDelayMs !== this.lastLoggedDelayMs;
    const periodicAtMax = this.lastDelayMs === this.options.maxMs && this.failures % LOG_EVERY_AT_MAX === 0;
    if (changed || periodicAtMax) {
      this.lastLoggedDelayMs = this.lastDelayMs;
      return true;
    }
    return false;
  }

  /** Registra um sucesso. Devolve quantas falhas seguidas houve antes (0 se nenhuma). */
  succeeded(): number {
    const failures = this.failures;
    this.failures = 0;
    this.lastDelayMs = 0;
    this.lastLoggedDelayMs = 0;
    return failures;
  }
}
