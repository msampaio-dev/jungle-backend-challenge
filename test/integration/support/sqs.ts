import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../../src/infrastructure/messaging/sqs";

/** Fila FIFO exclusiva do teste no LocalStack: um teste não vê mensagens de outro. */
export async function createTestQueue(prefix: string) {
  const client = createSqsClient();
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.fifo`,
      Attributes: { FifoQueue: "true" },
    }),
  );
  const queueUrl = QueueUrl!;

  return {
    client,
    queueUrl,
    /** Lê tudo que estiver na fila até ela ficar vazia. */
    async drain(): Promise<Array<Record<string, any>>> {
      const bodies: Array<Record<string, any>> = [];
      for (let empty = 0; empty < 2; ) {
        const { Messages = [] } = await client.send(
          new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
        );
        if (Messages.length === 0) empty++;
        // não apaga: a visibilidade padrão (30s) basta para não reler no mesmo teste
        for (const m of Messages) bodies.push(JSON.parse(m.Body!));
      }
      return bodies;
    },
    async delete() {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    },
  };
}
