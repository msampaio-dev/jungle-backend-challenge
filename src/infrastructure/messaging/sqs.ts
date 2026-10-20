import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../application/outbox/event-publisher";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface SqsClientOptions {
  endpoint?: string | undefined;
  /**
   * Tempo máximo de uma chamada. Sem isso, um SQS travado prende para
   * sempre a transação (e o lock) do relay da outbox. Quem faz long
   * polling precisa de um valor maior que o WaitTimeSeconds.
   */
  requestTimeoutMs?: number;
}

export const DEFAULT_SQS_REQUEST_TIMEOUT_MS = 5_000;

export function createSqsClient(options: SqsClientOptions = {}): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: options.endpoint ?? process.env.SQS_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
    requestHandler: {
      connectionTimeout: 2_000,
      requestTimeout: options.requestTimeoutMs ?? DEFAULT_SQS_REQUEST_TIMEOUT_MS,
      // sem isto o SDK só loga um aviso e a requisição continua pendurada
      throwOnRequestTimeout: true,
    },
    // Uma tentativa só: quem decide retry é a aplicação (backoff da outbox,
    // reentrega do SQS). Retry do SDK por cima multiplicaria o tempo preso.
    maxAttempts: 1,
  });
}

/**
 * Publica na fila FIFO de eventos. MessageGroupId = walletId mantém a
 * ordem por carteira; MessageDeduplicationId = eventId corta duplicatas
 * dentro da janela de 5 minutos do SQS (otimização, não garantia).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: message.eventType },
        },
      }),
    );
  }
}
