import type { OutboxMessage } from "../../domain/messaging/outbox-message";

/** Porta de saída: para onde os eventos vão. Hoje SQS; a outbox não sabe disso. */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
