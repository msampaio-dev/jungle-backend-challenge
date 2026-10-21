/**
 * O que a aplicação mede, em termos de negócio. A infraestrutura decide
 * como vira métrica (hoje, contadores e histogramas do Prometheus).
 */
export interface MetricsPort {
  /** uma transação chegou a um status (canal: http, sqs ou worker) */
  transactionCompleted(channel: string, kind: string, status: string): void;
  duplicateDetected(type: string): void;
  retryScheduled(component: string): void;
  processingObserved(channel: string, outcome: string, seconds: number): void;
  outboxPublished(delaySeconds: number): void;
  /** um erro aconteceu; se for conflito de lock (timeout, deadlock...), conta como tal */
  operationFailed(error: unknown): void;
}
