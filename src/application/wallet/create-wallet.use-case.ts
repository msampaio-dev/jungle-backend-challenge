import { UniqueConstraintViolationException } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { eventsForTransaction } from "../../domain/messaging/wagering-events";
import { Money, type MoneyProps } from "../../domain/shared/money";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { InvalidRequestError, WalletAlreadyExistsError } from "../errors";
import type { WageringPorts } from "../ports";
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
    private readonly ports: Pick<WageringPorts, "wallets" | "transactions" | "outbox" | "clock">,
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
    const walletId = Bun.randomUUIDv7();
    const openingTransactionId = Bun.randomUUIDv7();

    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // a wallet nasce já dentro da transação, com a data do relógio do banco
        const now = await this.ports.clock.now(em);
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId,
          initialBalance,
          openingTransactionId,
          openingEntryId: Bun.randomUUIDv7(),
          at: now,
        });

        await this.ports.wallets.insert(em, wallet);
        if (openingEntry) {
          const opening = WagerTransaction.opening({
            id: openingTransactionId,
            walletId,
            playerId,
            money: initialBalance,
            payloadHash: payloadHash({ kind: "OPENING", walletId, playerId, money: initialBalance.toJSON() }),
            at: now,
          });
          await this.ports.transactions.insert(em, opening, now);
          await this.ports.wallets.insertEntry(em, openingEntry);
          const ctx = { correlationId: command.correlationId ?? openingTransactionId, occurredAt: now };
          await this.ports.outbox.insert(
            em,
            eventsForTransaction(opening, wallet, openingEntry, ctx).map((e) => OutboxMessage.enqueue(e)),
          );
        }
        return wallet;
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException && error.message.includes("wallets_player_currency_uq")) {
        const [existing] = await this.orm.em
          .getConnection()
          .execute("select id from wallets where player_id = ? and currency = ?", [playerId, initialBalance.currency]);
        throw new WalletAlreadyExistsError(
          `player ${playerId} already has a ${initialBalance.currency} wallet`,
          String(existing!.id),
        );
      }
      throw error;
    }
  }
}
