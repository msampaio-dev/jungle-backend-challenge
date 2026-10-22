import { Logger } from "@nestjs/common";
import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { LedgerEntryRecordSchema, WagerTransactionRecordSchema, WalletRecordSchema } from "./records";
import { Migration20261019230000WalletsAndLedger } from "./migrations/Migration20261019230000WalletsAndLedger";
import { Migration20261020000000WagerTransactions } from "./migrations/Migration20261020000000WagerTransactions";
import { Migration20261020010000Outbox } from "./migrations/Migration20261020010000Outbox";
import { Migration20261020020000Inbox } from "./migrations/Migration20261020020000Inbox";
import { Migration20261020030000SingleReversal } from "./migrations/Migration20261020030000SingleReversal";
import { Migration20261020040000IdentifierLength } from "./migrations/Migration20261020040000IdentifierLength";
import { Migration20261020050000LedgerTransactionWallet } from "./migrations/Migration20261020050000LedgerTransactionWallet";
import { Migration20261020060000PendingReferenceSchedule } from "./migrations/Migration20261020060000PendingReferenceSchedule";
import { Migration20261020070000ResolutionFailures } from "./migrations/Migration20261020070000ResolutionFailures";
import { Migration20261020080000CorrelationId } from "./migrations/Migration20261020080000CorrelationId";
import { Migration20261021000000PendingByReferenceIndex } from "./migrations/Migration20261021000000PendingByReferenceIndex";
import { Migration20261021010000OutboxByAggregateIndex } from "./migrations/Migration20261021010000OutboxByAggregateIndex";
import { Migration20261022000000ResultBalanceCurrency } from "./migrations/Migration20261022000000ResultBalanceCurrency";

// Logs do MikroORM e do knex (que escreve direto no console, colorido) passam
// pelo logger da aplicação, para saírem em JSON como todo o resto.
const ANSI_COLORS = /\u001b\[[0-9;]*m/g;
const MAX_LOG_LENGTH = 500;
const plain = (message: unknown) => String(message).replace(ANSI_COLORS, "").slice(0, MAX_LOG_LENGTH);
const ormLogger = new Logger("MikroORM");
const knexLogger = new Logger("Knex");

/**
 * Quanto uma operação espera por uma conexão livre do pool. O padrão do
 * knex é 60s: com o pool cheio, a requisição ficava pendurada um minuto.
 * 5s, como o lock_timeout da wallet; estourou, é erro transitório (503).
 */
function acquireTimeoutMs(): number {
  const value = Number(process.env.DATABASE_ACQUIRE_TIMEOUT_MS ?? 5_000);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid DATABASE_ACQUIRE_TIMEOUT_MS: ${process.env.DATABASE_ACQUIRE_TIMEOUT_MS}`);
  }
  return value;
}

export function createOrmConfig(clientUrl = process.env.DATABASE_URL) {
  return defineConfig({
    clientUrl,
    entities: [WalletRecordSchema, LedgerEntryRecordSchema, WagerTransactionRecordSchema],
    extensions: [Migrator],
    forceUtcTimezone: true,
    pool: { min: 0, max: Number(process.env.DATABASE_POOL_MAX ?? 10), acquireTimeoutMillis: acquireTimeoutMs() },
    logger: (message) => ormLogger.log({ msg: plain(message) }),
    driverOptions: {
      log: {
        warn: (message: unknown) => knexLogger.warn({ msg: plain(message) }),
        error: (message: unknown) => knexLogger.error({ msg: plain(message) }),
        deprecate: (message: unknown) => knexLogger.warn({ msg: plain(message) }),
        debug: () => {}, // debug do knex traz SQL com valores: nunca vai para o log
      },
    },
    migrations: {
      // lista explícita: a ordem fica no código, sem varrer pasta em runtime
      migrationsList: [
        { name: "Migration20261019230000WalletsAndLedger", class: Migration20261019230000WalletsAndLedger },
        { name: "Migration20261020000000WagerTransactions", class: Migration20261020000000WagerTransactions },
        { name: "Migration20261020010000Outbox", class: Migration20261020010000Outbox },
        { name: "Migration20261020020000Inbox", class: Migration20261020020000Inbox },
        { name: "Migration20261020030000SingleReversal", class: Migration20261020030000SingleReversal },
        { name: "Migration20261020040000IdentifierLength", class: Migration20261020040000IdentifierLength },
        { name: "Migration20261020050000LedgerTransactionWallet", class: Migration20261020050000LedgerTransactionWallet },
        { name: "Migration20261020060000PendingReferenceSchedule", class: Migration20261020060000PendingReferenceSchedule },
        { name: "Migration20261020070000ResolutionFailures", class: Migration20261020070000ResolutionFailures },
        { name: "Migration20261020080000CorrelationId", class: Migration20261020080000CorrelationId },
        { name: "Migration20261021000000PendingByReferenceIndex", class: Migration20261021000000PendingByReferenceIndex },
        { name: "Migration20261021010000OutboxByAggregateIndex", class: Migration20261021010000OutboxByAggregateIndex },
        { name: "Migration20261022000000ResultBalanceCurrency", class: Migration20261022000000ResultBalanceCurrency },
      ],
      transactional: true,
      allOrNothing: true,
    },
  });
}
