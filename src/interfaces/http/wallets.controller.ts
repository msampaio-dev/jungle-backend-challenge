import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { InvalidRequestError } from "../../application/errors";
import { type WalletView, WalletQueries } from "../../application/queries/wallet-queries";
import { CreateWalletUseCase } from "../../application/wallet/create-wallet.use-case";
import type { MoneyProps } from "../../domain/shared/money";
import { ProviderAuthGuard } from "./provider-auth.guard";

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<WalletView> {
    if (typeof body !== "object" || body === null) throw new InvalidRequestError("body must be a JSON object");
    const { playerId, initialBalance } = body as { playerId?: unknown; initialBalance?: unknown };
    if (typeof initialBalance !== "object" || initialBalance === null) {
      throw new InvalidRequestError("initialBalance is required");
    }

    const wallet = await this.createWallet.execute({
      playerId: playerId as string,
      initialBalance: initialBalance as MoneyProps,
    });
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string) {
    return this.queries.getWallet(walletId);
  }

  @Get(":walletId/ledger")
  ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    return this.queries.getLedger(walletId, cursor, limit);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  reconcile(@Param("walletId") walletId: string) {
    return this.queries.reconcile(walletId);
  }
}
