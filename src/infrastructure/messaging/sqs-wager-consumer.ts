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
import {
  DEFAULT_FAILURE_BACKOFF,
  FailureBackoff,
  type FailureBackoffOptions,
} from "../../application/shared/failure-backoff";
import type {
  ProcessWagerTransactionUseCase,
  SubmitWagerCommand,
  WagerResult,
} from "../../application/wagering/process-wager-transaction.use-case";
import { payloadHash } from "../../application/wagering/payload-hash";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { MAX_IDENTIFIER_LENGTH } from "../../domain/wagering/wager-transaction";
import { databaseNow } from "../database/clock";
import { InboxRepository } from "../database/inbox.repository";
import { runWithContext } from "../observability/context";
import { metrics } from "../observability/metrics";
import { describeError } from "../observability/json-logger";

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
  /** espera crescente entre leituras que falham (SQS fora; padrão: 1s, 2s, 4s... até 10s) */
  pollFailureBackoff?: FailureBackoffOptions;
  /** leitores em paralelo; cada um segura no máximo uma mensagem por vez (padrão 5) */
  concurrency?: number;
}

/**
 * 8 tentativas com espera 2, 4, 8, 16, 32, 60, 60s: ~3 min antes da DLQ.
 * Cobre um failover típico de banco (o desafio diz que ele pode ficar
 * temporariamente indisponível) sem virar trabalho manual de reprocessar
 * a DLQ. A política da fila (maxReceiveCount) fica acima disso, como rede
 * de segurança para o caso de o processo morrer a cada tentativa.
 */
export const DEFAULT_CONSUMER_OPTIONS = {
  consumerName: "wager-transactions-consumer",
  waitTimeSeconds: 10,
  maxAttempts: 8,
  backoffBaseSeconds: 2,
  backoffMaxSeconds: 60,
  concurrency: 5,
} satisfies Partial<SqsConsumerOptions>;

export type Outcome = "processed" | "duplicate" | "retry" | "dead-letter";

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
 *
 * Vários leitores, cada um lendo UMA mensagem por vez. A FIFO nunca entrega
 * a próxima mensagem de uma wallet enquanto a anterior está pendente, então
 * ela mesma garante a ordem por wallet e que uma wallet nunca está com dois
 * leitores. Ler em lote obrigava a devolver as mensagens de trás quando a
 * da frente entrava em retry, e cada devolução contava como entrega: elas
 * gastavam o limite sem nunca serem tentadas e acabavam na DLQ.
 */
export class SqsWagerConsumer {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private running = false;
  private stopping = false;
  private readers: Promise<void>[] = [];
  private readonly wakes = new Set<() => void>();
  /** compartilhada pelos leitores: com o SQS fora, 5 leitores não viram 5x o log */
  private readonly pollBackoff: FailureBackoff;

  constructor(
    private readonly client: SQSClient,
    private readonly orm: MikroORM,
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly options: SqsConsumerOptions,
    private readonly inbox = new InboxRepository(),
  ) {
    // NaN ou 0 criaria zero leitores: um consumidor que sobe e nunca lê nada, sem erro
    const concurrency = options.concurrency ?? DEFAULT_CONSUMER_OPTIONS.concurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`invalid consumer concurrency: ${options.concurrency}`);
    }
    this.pollBackoff = new FailureBackoff(options.pollFailureBackoff ?? DEFAULT_FAILURE_BACKOFF);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    const concurrency = this.options.concurrency ?? DEFAULT_CONSUMER_OPTIONS.concurrency;
    this.readers = Array.from({ length: concurrency }, () => this.readLoop());
  }

  /**
   * SIGTERM: para de buscar e deixa cada leitor terminar a mensagem que está
   * processando (commit + ack). A leitura em andamento (long polling) NÃO é
   * cortada: o SQS não sabe que a conexão caiu e entregaria a mensagem que
   * chegasse naquele instante a ninguém, deixando-a presa pela visibilidade
   * (30s) e gastando uma entrega. Em vez disso, a leitura termina (no máximo
   * waitTimeSeconds) e o que chegar durante a parada volta à fila na hora.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    const startedAt = performance.now();
    this.running = false;
    this.stopping = true;
    for (const wake of this.wakes) wake(); // corta só a espera entre tentativas
    await Promise.all(this.readers);
    // confirma no log que o desligamento foi limpo (e quanto o long polling segurou)
    this.logger.log({ msg: "sqs consumer stopped", durationMs: Math.round(performance.now() - startedAt) });
  }

  /** Uma leitura de UMA mensagem e o processamento dela (0 ou 1 resultado). */
  async pollOnce(): Promise<Outcome[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
    );
    const [message] = response.Messages ?? [];
    if (!message) return [];
    if (this.stopping) {
      // chegou durante a parada: devolve já, para outra instância pegar sem esperar
      await this.setVisibility(message, 0);
      return [];
    }
    return [await this.handleSafely(message)];
  }

  /**
   * Nenhum erro escapa do processamento de uma mensagem: falha inesperada
   * fora do use case (ex.: banco fora ao consultar a inbox) também vira retry.
   */
  private async handleSafely(message: Message): Promise<Outcome> {
    try {
      return await this.handle(message);
    } catch (error) {
      try {
        return await this.retryLater(message, error, { sqsMessageId: message.MessageId });
      } catch (visibilityError) {
        // nem o SQS respondeu: a mensagem volta sozinha quando a visibilidade expirar
        this.logger.error({ msg: "could not schedule retry", sqsMessageId: message.MessageId, error: describeError(visibilityError) });
        return "retry";
      }
    }
  }

  async handle(message: Message): Promise<Outcome> {
    const receiveCount = receiveCountOf(message);

    let envelope: Envelope;
    try {
      envelope = parseEnvelope(message.Body);
    } catch (error) {
      return this.deadLetter(message, "INVALID_ENVELOPE", (error as Error).message);
    }

    // daqui em diante, todo log (inclusive o do use case) sai com os ids da mensagem
    return runWithContext({ messageId: envelope.messageId, correlationId: envelope.correlationId ?? envelope.messageId }, () =>
      this.handleEnvelope(message, envelope, receiveCount),
    );
  }

  private async handleEnvelope(message: Message, envelope: Envelope, receiveCount: number): Promise<Outcome> {
    const hash = payloadHash(envelope.data);
    const log = { messageId: envelope.messageId, sqsMessageId: message.MessageId, receiveCount };

    // reentrega de algo que já foi confirmado: só falta o ack
    const known = await this.inbox.find(this.orm.em.fork(), this.options.consumerName, envelope.messageId);
    if (known) return this.alreadyHandled(message, known, hash, log);

    let result: WagerResult;
    try {
      result = await this.useCase.execute(toCommand(envelope), {
        channel: "sqs",
        // dentro da transação da operação, com a data do relógio do banco
        inTransaction: async (em) => {
          const now = await databaseNow(em);
          const inboxMessage = InboxMessage.receive({
            messageId: envelope.messageId,
            consumerName: this.options.consumerName,
            payloadHash: hash,
            receivedAt: now,
          });
          inboxMessage.markProcessed(now);
          await this.inbox.insert(em, inboxMessage);
        },
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
      return this.retryLater(message, error, log);
    }

    // Commit feito. O ack fica fora do try de cima: se ele falhar, a operação
    // NÃO falhou. A mensagem volta depois da visibilidade e a inbox a reconhece.
    try {
      await this.ack(message);
    } catch (error) {
      this.logger.warn({ msg: "ack failed after commit; redelivery will be acked as duplicate", ...log, error: describeError(error) });
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
      metrics.duplicates.inc({ type: "message_id_conflict" });
      return this.deadLetter(message, "MESSAGE_ID_CONFLICT", "messageId was already used with a different payload");
    }
    metrics.duplicates.inc({ type: "inbox_redelivery" });
    await this.ack(message);
    this.logger.log({ msg: "duplicate message acked", ...log });
    return "duplicate";
  }

  /** Erro transitório: backoff pela invisibilidade; esgotadas as tentativas, DLQ. */
  private async retryLater(message: Message, error: unknown, log: Record<string, unknown>): Promise<Outcome> {
    const receiveCount = receiveCountOf(message);
    if (receiveCount >= this.options.maxAttempts) {
      return this.deadLetter(message, "RETRIES_EXHAUSTED", (error as Error).message);
    }
    const delay = Math.min(this.options.backoffBaseSeconds * 2 ** (receiveCount - 1), this.options.backoffMaxSeconds);
    await this.setVisibility(message, delay);
    metrics.retries.inc({ component: "sqs_consumer" });
    this.logger.warn({ msg: "transient failure, will retry", ...log, kind: classifyError(error), retryInSeconds: delay });
    return "retry";
  }

  private async readLoop(): Promise<void> {
    const backoff = this.pollBackoff;
    while (this.running) {
      try {
        await this.pollOnce();
        const failedRounds = backoff.succeeded();
        if (failedRounds > 0) this.logger.log({ msg: "sqs consumer recovered", failedRounds });
      } catch (error) {
        // SQS fora: espera cada vez mais e loga só de vez em quando
        const delayMs = backoff.failed();
        if (backoff.shouldLog()) {
          this.logger.error({
            msg: "sqs poll failed",
            error: describeError(error),
            consecutiveFailures: backoff.consecutiveFailures,
            retryInMs: delayMs,
          });
        }
        if (this.running) await this.sleep(delayMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakes.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wakes.add(wake);
    });
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
    metrics.deadLettered.inc({ reason: code });
    this.logger.error({ msg: "message sent to DLQ", sqsMessageId: message.MessageId, errorCode: code });
    return "dead-letter";
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

function receiveCountOf(message: Message): number {
  return Number(message.Attributes?.ApproximateReceiveCount ?? "1");
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
  if (e.messageId.length > MAX_IDENTIFIER_LENGTH) {
    throw new InvalidEnvelopeError(`messageId must have at most ${MAX_IDENTIFIER_LENGTH} characters`);
  }
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
