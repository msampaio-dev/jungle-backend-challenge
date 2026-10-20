import {
  CreateQueueCommand,
  DeleteQueueCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../../src/infrastructure/messaging/sqs";

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.fifo`;

/** Fila FIFO exclusiva do teste no LocalStack: um teste não vê mensagens de outro. */
export async function createTestQueue(prefix: string, attributes: Record<string, string> = {}) {
  const client = createSqsClient();
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: uniqueName(prefix), Attributes: { FifoQueue: "true", ...attributes } }),
  );
  const queueUrl = QueueUrl!;

  /** Lê até a fila ficar vazia (sem apagar: a visibilidade segura a releitura). */
  async function receiveAll(): Promise<Message[]> {
    const all: Message[] = [];
    for (let empty = 0; empty < 2; ) {
      const { Messages = [] } = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ["All"],
        }),
      );
      if (Messages.length === 0) empty++;
      all.push(...Messages);
    }
    return all;
  }

  return {
    client,
    queueUrl,
    receiveAll,
    async drain(): Promise<Array<Record<string, any>>> {
      return (await receiveAll()).map((m) => JSON.parse(m.Body!));
    },
    async send(body: unknown, groupId: string): Promise<void> {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: typeof body === "string" ? body : JSON.stringify(body),
          MessageGroupId: groupId,
          // dedup id sempre novo: simula reentrega real, que o SQS não filtra
          MessageDeduplicationId: crypto.randomUUID(),
        }),
      );
    },
    async delete() {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    },
  };
}
