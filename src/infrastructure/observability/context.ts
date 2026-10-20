import { AsyncLocalStorage } from "node:async_hooks";

/** Ids de rastreio que acompanham uma requisição, mensagem ou resolução. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Roda `fn` com um contexto próprio. Tudo que `fn` chamar, inclusive depois
 * de awaits, enxerga esse contexto; requisições paralelas não se misturam.
 */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/** Acrescenta ids ao contexto atual (ex.: o transactionId só existe no meio do caminho). */
export function addToContext(fields: LogContext): void {
  const current = storage.getStore();
  if (!current) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (current as Record<string, unknown>)[key] = value;
  }
}

export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}
