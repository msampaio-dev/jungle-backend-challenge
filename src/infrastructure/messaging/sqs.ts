import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../application/outbox/event-publisher";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.SQS_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
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
