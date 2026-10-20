import { UniqueConstraintViolationException } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { eventsForTransaction } from "../../domain/messaging/wagering-events";
import { Money, type MoneyProps } from "../../domain/shared/money";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { OutboxRepository } from "../../infrastructure/database/outbox.repository";
import { WagerTransactionRepository } from "../../infrastructure/database/wager-transaction.repository";
import { WalletRepository } from "../../infrastructure/database/wallet.repository";
import { InvalidRequestError, WalletAlreadyExistsError } from "../errors";
import { payloadHash } from "../wagering/payload-hash";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string | undefined;
}

export class CreateWalletUseCase {
  constructor(
    private readonly orm: MikroORM,
    private readonly wallets = new WalletRepository(),
    private readonly transactions = new WagerTransactionRepository(),
    private readonly outbox = new OutboxRepository(),
  ) {}

  /** Wallet, transação OPENING, lançamento CREDIT e eventos na mesma transação SQL. */
  async execute(command: CreateWalletCommand): Promise<Wallet> {
    if (typeof command.playerId !== "string" || !UUID.test(command.playerId)) {
      throw new InvalidRequestError("playerId must be a UUID");
    }
    // UUID é igual em maiúsculas ou minúsculas; normaliza para a resposta e os
    // eventos saírem iguais ao que o banco devolve (o tipo uuid sai minúsculo)
    const playerId = command.playerId.toLowerCase();
    const initialBalance = Money.from(command.initialBalance);
    const now = new Date();
    const walletId = Bun.randomUUIDv7();
    const openingTransactionId = Bun.randomUUIDv7();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: Bun.randomUUIDv7(),
      at: now,
    });

    try {
      await this.orm.em.fork().transactional(async (em) => {
        await this.wallets.insert(em, wallet);
        if (openingEntry) {
          const opening = WagerTransaction.opening({
            id: openingTransactionId,
            walletId,
            playerId,
            money: initialBalance,
            payloadHash: payloadHash({ kind: "OPENING", walletId, playerId, money: initialBalance.toJSON() }),
            at: now,
          });
          await this.transactions.insert(em, opening, now);
          await this.wallets.insertEntry(em, openingEntry);
          const ctx = { correlationId: command.correlationId ?? openingTransactionId, occurredAt: now };
          await this.outbox.insert(
            em,
            eventsForTransaction(opening, wallet, openingEntry, ctx).map((e) => OutboxMessage.enqueue(e)),
          );
        }
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException && error.message.includes("wallets_player_currency_uq")) {
        throw new WalletAlreadyExistsError(
          `player ${playerId} already has a ${initialBalance.currency} wallet`,
        );
      }
      throw error;
    }
    return wallet;
  }
}
