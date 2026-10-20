import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { Logger } from "@nestjs/common";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import type { EventContext } from "../../domain/messaging/integration-event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { eventsForTransaction } from "../../domain/messaging/wagering-events";
import {
  BalanceLimitExceededError,
  InsufficientFundsError,
  InvalidWagerTransactionError,
} from "../../domain/shared/domain-error";
import { Money, type MoneyProps } from "../../domain/shared/money";
import { FailureCode } from "../../domain/wagering/failure-code";
import {
  DEFAULT_REFERENCE_RETRY_POLICY,
  nextReferenceCheckAt,
  type ReferenceRetryPolicy,
  referenceAttemptsExhausted,
} from "../../domain/wagering/reference-retry-policy";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { databaseNow } from "../../infrastructure/database/clock";
import { OutboxRepository } from "../../infrastructure/database/outbox.repository";
import { WagerTransactionRepository } from "../../infrastructure/database/wager-transaction.repository";
import { WalletRepository } from "../../infrastructure/database/wallet.repository";
import { IdempotencyConflictError, WalletNotFoundError } from "../errors";
import { addToContext } from "../../infrastructure/observability/context";
import { payloadHash } from "./payload-hash";

/** Entrada comum à API HTTP e ao consumidor SQS. */
export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  /** rastreio: id da requisição/fluxo e, no SQS, o messageId que causou a operação */
  correlationId?: string | undefined;
  causationId?: string | undefined;
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode | undefined;
  /** só em PENDING_REFERENCE: quando a referência será procurada de novo (ISO-8601) */
  nextReferenceCheckAt?: string | undefined;
  /**
   * Só em PENDING_REFERENCE: segundos até a próxima checagem, calculados no
   * relógio do banco (base do header Retry-After; não vai no corpo).
   */
  retryAfterSeconds?: number | undefined;
}

export interface ExecuteOptions {
  /**
   * Trabalho extra que precisa ser confirmado junto com a operação (o
   * consumidor SQS grava a inbox aqui). Roda também no caminho de replay.
   */
  inTransaction?: (em: EntityManager) => Promise<void>;
  /** por onde a operação chegou (logs e métricas) */
  channel?: WagerChannel;
}

export type WagerChannel = "http" | "sqs";

/** Entrada já validada; vira WagerTransaction dentro da transação SQL, com a data do banco. */
type PreparedWager = Omit<CreateWagerTransactionProps, "createdAt">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_CONSTRAINTS = /wager_tx_idempotency_uq|wager_tx_external_id_uq/;

export class ProcessWagerTransactionUseCase {
  private readonly logger = new Logger(ProcessWagerTransactionUseCase.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly wallets = new WalletRepository(),
    private readonly transactions = new WagerTransactionRepository(),
    private readonly outbox = new OutboxRepository(),
    private readonly referencePolicy: ReferenceRetryPolicy = DEFAULT_REFERENCE_RETRY_POLICY,
  ) {}

  async execute(command: SubmitWagerCommand, options: ExecuteOptions = {}): Promise<WagerResult> {
    const channel = options.channel ?? "http";
    // latência medida no processo, com relógio monotônico (não depende de relógio de parede)
    const startedAt = performance.now();

    // Segunda volta só acontece se outra instância gravou a mesma chave entre
    // a nossa leitura e o nosso INSERT: aí a releitura vira replay ou conflito.
    for (let attempt = 1; ; attempt++) {
      const prepared = this.build(command);
      addToContext({ walletId: prepared.walletId, providerId: prepared.providerId });
      try {
        const trace = { correlationId: prepared.correlationId ?? prepared.id, causationId: command.causationId };
        const result = await this.orm.em.fork().transactional(async (em) => {
          const result = await this.process(em, prepared, trace);
          await options.inTransaction?.(em);
          return result;
        });

        // depois do commit: o log nunca anuncia algo que não foi confirmado
        addToContext({ transactionId: result.transactionId });
        this.logger.log({
          msg: result.idempotentReplay ? "idempotent replay" : "wager transaction processed",
          transactionId: result.transactionId,
          walletId: prepared.walletId,
          providerId: prepared.providerId,
          kind: prepared.kind,
          status: result.status,
          failureCode: result.failureCode,
          channel,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        });
        return result;
      } catch (error) {
        const raced = error instanceof UniqueConstraintViolationException && IDEMPOTENCY_CONSTRAINTS.test(error.message);
        if (raced && attempt === 1) continue;
        throw error;
      }
    }
  }

  /**
   * Valida a entrada e calcula o hash, antes de abrir transação no banco.
   * Erros aqui são payload inválido (nada é gravado). A data fica para depois.
   */
  private build(command: SubmitWagerCommand): PreparedWager {
    for (const field of ["playerId", "walletId"] as const) {
      if (typeof command[field] !== "string" || !UUID.test(command[field])) {
        throw new InvalidWagerTransactionError(`${field} must be a UUID`);
      }
    }
    const reference = command.referenceExternalTransactionId;
    if (reference !== undefined && (typeof reference !== "string" || reference.trim() === "")) {
      throw new InvalidWagerTransactionError("referenceExternalTransactionId must be a non-empty string");
    }
    const money = Money.from(command.money);
    const hash = payloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId.toLowerCase(),
      walletId: command.walletId.toLowerCase(),
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(), // normalizado: "25" e "25.00" geram o mesmo hash
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    const prepared: PreparedWager = {
      id: Bun.randomUUIDv7(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: hash,
      walletId: command.walletId.toLowerCase(),
      playerId: command.playerId.toLowerCase(),
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      correlationId: command.correlationId,
    };
    WagerTransaction.validate(prepared);
    return prepared;
  }

  private async process(
    em: EntityManager,
    prepared: PreparedWager,
    trace: Omit<EventContext, "occurredAt">,
  ): Promise<WagerResult> {
    // a chegada é carimbada no relógio do banco, como todas as outras datas
    const receivedAt = await databaseNow(em);

    // 1. Replay barato, sem lock.
    const known = await this.transactions.findByIdempotencyKey(em, prepared.providerId, prepared.idempotencyKey);
    if (known) return this.replay(em, known, prepared);

    // 2. Trava a carteira: tudo que toca esta wallet passa a ser serial.
    const wallet = await this.wallets.lockById(em, prepared.walletId);
    if (!wallet) throw new WalletNotFoundError(`wallet ${prepared.walletId} not found`);

    // 3. Confere de novo: outra requisição pode ter gravado enquanto esperávamos o lock.
    const raced = await this.transactions.findByIdempotencyKey(em, prepared.providerId, prepared.idempotencyKey);
    if (raced) return this.replay(em, raced, prepared);
    if (await this.transactions.findByExternalId(em, prepared.providerId, prepared.externalTransactionId)) {
      throw new IdempotencyConflictError(
        `externalTransactionId ${prepared.externalTransactionId} was already submitted with another idempotency key`,
      );
    }

    const tx = WagerTransaction.create({ ...prepared, createdAt: receivedAt });
    // hora de processar (depois de esperar o lock), também do banco
    const now = await databaseNow(em);
    const expectedVersion = wallet.version;
    const entry = await this.resolve(em, tx, wallet, now);

    // Tudo na mesma transação SQL: transação, saldo, lançamento e eventos.
    // A transação vai antes do lançamento por causa da FK do ledger.
    await this.transactions.insert(em, tx, now);
    if (entry) await this.wallets.saveMovement(em, wallet, expectedVersion, entry);
    // quem estava esperando por esta transação pode ser resolvido já
    if (tx.isTerminal()) await this.transactions.wakePendingDependents(em, tx.providerId, tx.externalTransactionId);
    await this.outbox.insert(
      em,
      eventsForTransaction(tx, wallet, entry, { ...trace, occurredAt: now }).map((e) => OutboxMessage.enqueue(e)),
    );

    return toResult(tx, wallet.balance, false, now);
  }

  /**
   * Aplica as regras de negócio e muda o estado da transação. Devolve o
   * lançamento quando o saldo mudou. A wallet já precisa estar travada.
   */
  async resolve(
    em: EntityManager,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<WalletLedgerEntry | undefined> {
    if (wallet.playerId !== tx.playerId) {
      tx.reject(FailureCode.PlayerWalletMismatch, wallet.balance);
      return undefined;
    }
    if (wallet.currency !== tx.money.currency) {
      tx.reject(FailureCode.CurrencyMismatch, wallet.balance);
      return undefined;
    }

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId) {
      reference =
        (await this.transactions.findByExternalId(em, tx.providerId, tx.referenceExternalTransactionId)) ?? undefined;

      // Referência ainda não chegou (ou ainda não foi resolvida): esta tentativa
      // conta. Esgotado o limite, desiste; senão, agenda a próxima para o worker.
      if (!reference || !reference.isTerminal()) {
        const attemptsMade = tx.referenceAttempts + 1;
        if (referenceAttemptsExhausted(this.referencePolicy, attemptsMade)) {
          const code = reference ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound;
          tx.rejectAfterReferenceAttempts(code, wallet.balance);
        } else {
          tx.markPendingReference(nextReferenceCheckAt(this.referencePolicy, attemptsMade, now));
        }
        return undefined;
      }
      const problem = tx.checkReference(reference);
      if (problem) {
        tx.reject(problem, wallet.balance);
        return undefined;
      }
      // uma reversão por referência, qualquer que seja o tipo: REFUND e depois
      // ROLLBACK da mesma BET devolveriam o valor duas vezes
      if (tx.requiresReference() && (await this.transactions.hasProcessedReversal(em, reference.id))) {
        tx.reject(FailureCode.ReferenceAlreadyReversed, wallet.balance);
        return undefined;
      }
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      return undefined;
    }

    const ctx = { transactionId: tx.id, entryId: Bun.randomUUIDv7(), at: now };
    try {
      const entry =
        tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(tx.money, ctx)
          : wallet.credit(tx.money, ctx);
      tx.markProcessed(reference?.id, now, wallet.balance);
      return entry;
    } catch (error) {
      if (error instanceof BalanceLimitExceededError) {
        tx.reject(FailureCode.BalanceLimitExceeded, wallet.balance);
        return undefined;
      }
      if (!(error instanceof InsufficientFundsError)) throw error;
      // estornar um WIN já gasto é diferente de apostar sem saldo
      const code = tx.requiresReference() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
      tx.reject(code, wallet.balance);
      return undefined;
    }
  }

  private async replay(em: EntityManager, known: WagerTransaction, incoming: PreparedWager): Promise<WagerResult> {
    if (!known.matchesPayload(incoming.payloadHash)) {
      throw new IdempotencyConflictError(
        `idempotency key ${incoming.idempotencyKey} was already used with a different payload`,
      );
    }
    // transação ainda pendente não tem saldo final: devolve o saldo atual
    const balance = known.resultBalance ?? (await this.wallets.findById(em, known.walletId))!.balance;
    return toResult(known, balance, true, await databaseNow(em));
  }
}

function toResult(tx: WagerTransaction, balance: Money, idempotentReplay: boolean, now: Date): WagerResult {
  const next = tx.nextReferenceCheckAt;
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: balance.toJSON(),
    idempotentReplay,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    ...(next
      ? {
          nextReferenceCheckAt: next.toISOString(),
          retryAfterSeconds: Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000)),
        }
      : {}),
  };
}
