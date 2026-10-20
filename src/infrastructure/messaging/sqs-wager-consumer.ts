import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { Logger } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { classifyError, ErrorKind, errorCode } from "../../application/error-kind";
import type {
  ProcessWagerTransactionUseCase,
  SubmitWagerCommand,
  WagerResult,
} from "../../application/wagering/process-wager-transaction.use-case";
import { payloadHash } from "../../application/wagering/payload-hash";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { InboxRepository } from "../database/inbox.repository";

export interface SqsConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  /** long polling: quanto tempo o ReceiveMessage espera por mensagens */
  waitTimeSeconds: number;
  /** entregas antes de desistir de um erro transitório e mandar para a DLQ */
  maxAttempts: number;
  /** invisibilidade após falha transitória: base * 2^(entrega-1), até o máximo */
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
}

export const DEFAULT_CONSUMER_OPTIONS = {
  consumerName: "wager-transactions-consumer",
  waitTimeSeconds: 10,
  maxAttempts: 5,
  backoffBaseSeconds: 2,
  backoffMaxSeconds: 60,
} satisfies Partial<SqsConsumerOptions>;

export type Outcome = "processed" | "duplicate" | "retry" | "dead-letter" | "released";

interface Envelope {
  messageId: string;
  correlationId?: string;
  data: Record<string, unknown>;
}

class InvalidEnvelopeError extends Error {}

/**
 * Consome wager-transactions.fifo usando o MESMO use case da API HTTP.
 * Ack só depois do commit; a inbox (gravada na mesma transação) torna a
 * reentrega inofensiva.
 */
export class SqsWagerConsumer {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private running = false;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private abort: AbortController | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly orm: MikroORM,
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly options: SqsConsumerOptions,
    private readonly inbox = new InboxRepository(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /**
   * SIGTERM: para de buscar, deixa terminar o que já começou (commit + ack)
   * e devolve à fila, com visibilidade zero, o que ainda não começou.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    this.abort?.abort();
    await this.loop;
  }

  /** Uma leitura da fila e o processamento do lote. */
  async pollOnce(): Promise<Outcome[]> {
    this.abort = new AbortController();
    let messages: Message[];
    try {
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.options.queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
        }),
        { abortSignal: this.abort.signal },
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (this.abort.signal.aborted) return [];
      throw error;
    }
    return this.handleBatch(messages);
  }

  /** Mesmo grupo (wallet) em sequência para manter a ordem; grupos diferentes em paralelo. */
  async handleBatch(messages: Message[]): Promise<Outcome[]> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? "default";
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }

    const outcomes = await Promise.all(
      [...groups.values()].map(async (group) => {
        const results: Outcome[] = [];
        let blocked = false;
        for (const message of group) {
          // Se uma mensagem do grupo voltou para retry, as seguintes não podem
          // passar na frente: voltam para a fila e a FIFO as entrega depois dela.
          const outcome = this.stopping || blocked ? await this.release(message) : await this.handle(message);
          if (outcome === "retry") blocked = true;
          results.push(outcome);
        }
        return results;
      }),
    );
    return outcomes.flat();
  }

  async handle(message: Message): Promise<Outcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");

    let envelope: Envelope;
    try {
      envelope = parseEnvelope(message.Body);
    } catch (error) {
      return this.deadLetter(message, "INVALID_ENVELOPE", (error as Error).message);
    }

    const hash = payloadHash(envelope.data);
    const log = { messageId: envelope.messageId, sqsMessageId: message.MessageId, receiveCount };

    // reentrega de algo que já foi confirmado: só falta o ack
    const known = await this.inbox.find(this.orm.em.fork(), this.options.consumerName, envelope.messageId);
    if (known) return this.alreadyHandled(message, known, hash, log);

    let result: WagerResult;
    try {
      const inboxMessage = InboxMessage.receive({
        messageId: envelope.messageId,
        consumerName: this.options.consumerName,
        payloadHash: hash,
        receivedAt: new Date(),
      });
      inboxMessage.markProcessed(new Date());

      result = await this.useCase.execute(toCommand(envelope), {
        inTransaction: (em) => this.inbox.insert(em, inboxMessage),
      });
    } catch (error) {
      // outra instância processou a mesma mensagem ao mesmo tempo e confirmou primeiro
      if (error instanceof UniqueConstraintViolationException && error.message.includes("inbox_messages_pk")) {
        const winner = await this.inbox.find(this.orm.em.fork(), this.options.consumerName, envelope.messageId);
        if (winner) return this.alreadyHandled(message, winner, hash, log);
      }

      const kind = classifyError(error);
      if (kind === ErrorKind.InvalidInput || kind === ErrorKind.NotFound || kind === ErrorKind.Conflict) {
        // nunca vai dar certo: não gasta tentativas
        return this.deadLetter(message, errorCode(error), (error as Error).message);
      }
      if (receiveCount >= this.options.maxAttempts) {
        return this.deadLetter(message, "RETRIES_EXHAUSTED", (error as Error).message);
      }
      const delay = Math.min(
        this.options.backoffBaseSeconds * 2 ** (receiveCount - 1),
        this.options.backoffMaxSeconds,
      );
      await this.setVisibility(message, delay);
      this.logger.warn({ msg: "transient failure, will retry", ...log, kind, retryInSeconds: delay });
      return "retry";
    }

    // Commit feito. O ack fica fora do try de cima: se ele falhar, a operação
    // NÃO falhou. A mensagem volta depois da visibilidade e a inbox a reconhece.
    try {
      await this.ack(message);
    } catch (error) {
      this.logger.warn({ msg: "ack failed after commit; redelivery will be acked as duplicate", ...log, error: (error as Error).message });
    }
    this.logger.log({ msg: "message processed", ...log, transactionId: result.transactionId, status: result.status });
    return "processed";
  }

  /**
   * O messageId já está na inbox. Mesmo conteúdo: é reentrega, só falta o
   * ack. Conteúdo diferente: é outra operação usando um id repetido; não dá
   * para processar nem para descartar em silêncio, então vai para a DLQ.
   */
  private async alreadyHandled(
    message: Message,
    known: InboxMessage,
    hash: string,
    log: Record<string, unknown>,
  ): Promise<Outcome> {
    if (known.payloadHash !== hash) {
      return this.deadLetter(message, "MESSAGE_ID_CONFLICT", "messageId was already used with a different payload");
    }
    await this.ack(message);
    this.logger.log({ msg: "duplicate message acked", ...log });
    return "duplicate";
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logger.error({ msg: "sqs poll failed", error: (error as Error).message });
        if (this.running) await Bun.sleep(1_000);
      }
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  /** Copia para a DLQ com o motivo e só então remove da fila principal. */
  private async deadLetter(message: Message, code: string, reason: string): Promise<Outcome> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          errorCode: { DataType: "String", StringValue: code },
          errorReason: { DataType: "String", StringValue: reason.slice(0, 1000) || code },
        },
      }),
    );
    await this.ack(message);
    this.logger.error({ msg: "message sent to DLQ", sqsMessageId: message.MessageId, errorCode: code });
    return "dead-letter";
  }

  /** Devolve à fila sem esperar o fim da visibilidade (usado no shutdown). */
  private async release(message: Message): Promise<Outcome> {
    await this.setVisibility(message, 0);
    return "released";
  }

  private async setVisibility(message: Message, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}

function parseEnvelope(body: string | undefined): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "");
  } catch {
    throw new InvalidEnvelopeError("body is not valid JSON");
  }
  const e = parsed as Record<string, unknown> | null;
  if (typeof e !== "object" || e === null) throw new InvalidEnvelopeError("body must be a JSON object");
  if (e.type !== "WagerTransactionRequested") throw new InvalidEnvelopeError(`unexpected type: ${String(e.type)}`);
  if (typeof e.messageId !== "string" || e.messageId.trim() === "") throw new InvalidEnvelopeError("messageId is required");
  if (typeof e.data !== "object" || e.data === null) throw new InvalidEnvelopeError("data is required");
  const data = e.data as Record<string, unknown>;
  if (typeof data.idempotencyKey !== "string" || data.idempotencyKey.trim() === "") {
    throw new InvalidEnvelopeError("data.idempotencyKey is required");
  }
  if (typeof data.money !== "object" || data.money === null) throw new InvalidEnvelopeError("data.money is required");
  return {
    messageId: e.messageId,
    ...(typeof e.correlationId === "string" ? { correlationId: e.correlationId } : {}),
    data,
  };
}

function toCommand(envelope: Envelope): SubmitWagerCommand {
  const d = envelope.data;
  return {
    idempotencyKey: d.idempotencyKey as string,
    providerId: d.providerId as string,
    externalTransactionId: d.externalTransactionId as string,
    playerId: d.playerId as string,
    walletId: d.walletId as string,
    roundId: d.roundId as string,
    gameId: d.gameId as string,
    kind: d.kind as string,
    money: d.money as SubmitWagerCommand["money"],
    referenceExternalTransactionId: d.referenceExternalTransactionId as string | undefined,
    correlationId: envelope.correlationId ?? envelope.messageId,
    causationId: envelope.messageId,
  };
}
