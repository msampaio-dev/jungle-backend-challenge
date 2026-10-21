import { Body, Controller, Get, Headers, HttpStatus, Inject, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { InvalidRequestError } from "../../application/errors";
import { currentContext } from "../../infrastructure/observability/context";
import { WalletQueries } from "../../application/queries/wallet-queries";
import {
  ProcessWagerTransactionUseCase,
  type SubmitWagerCommand,
  type WagerResult,
} from "../../application/wagering/process-wager-transaction.use-case";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { ProviderAuthGuard } from "./provider-auth.guard";

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerResult> {
    if (!idempotencyKey?.trim()) throw new InvalidRequestError("Idempotency-Key header is required");

    const { retryAfterSeconds, ...result } = await this.processWager.execute(toCommand(idempotencyKey, body));
    response.status(statusFor(result));
    // 202: quando vale a pena consultar de novo, já calculado no relógio do banco
    if (retryAfterSeconds !== undefined) response.setHeader("Retry-After", String(retryAfterSeconds));
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  getById(@Param("transactionId") transactionId: string) {
    return this.queries.getTransaction(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}

/**
 * O status diz ao provedor o que fazer, sem ele precisar ler a mensagem:
 * 201/200 seguiu, 202 aguarde a referência, 422 não reenvie.
 */
function statusFor(result: WagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    // Os dois são terminais: reenviar devolve o mesmo resultado. FAILED não é
    // 500 porque 5xx diz "tente de novo", e aqui cada tentativa seria um
    // replay que falha igual. status e failureCode no corpo separam os dois.
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

/** Só confere a forma; as regras de valor ficam no use case e no domínio. */
function toCommand(idempotencyKey: string, body: unknown): SubmitWagerCommand {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidRequestError("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.money !== "object" || b.money === null) throw new InvalidRequestError("money is required");

  return {
    idempotencyKey,
    providerId: b.providerId as string,
    externalTransactionId: b.externalTransactionId as string,
    playerId: b.playerId as string,
    walletId: b.walletId as string,
    roundId: b.roundId as string,
    gameId: b.gameId as string,
    kind: b.kind as string,
    money: b.money as SubmitWagerCommand["money"],
    referenceExternalTransactionId: b.referenceExternalTransactionId as string | undefined,
    // aberto pelo CorrelationMiddleware: o X-Correlation-Id do provedor ou um gerado
    correlationId: currentContext().correlationId,
  };
}
