import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { LedgerEntryRecordSchema, WagerTransactionRecordSchema, WalletRecordSchema } from "./records";
import { Migration20261019230000WalletsAndLedger } from "./migrations/Migration20261019230000WalletsAndLedger";
import { Migration20261020000000WagerTransactions } from "./migrations/Migration20261020000000WagerTransactions";
import { Migration20261020010000Outbox } from "./migrations/Migration20261020010000Outbox";
import { Migration20261020020000Inbox } from "./migrations/Migration20261020020000Inbox";
import { Migration20261020030000SingleReversal } from "./migrations/Migration20261020030000SingleReversal";
import { Migration20261020040000IdentifierLength } from "./migrations/Migration20261020040000IdentifierLength";

export function createOrmConfig(clientUrl = process.env.DATABASE_URL) {
  return defineConfig({
    clientUrl,
    entities: [WalletRecordSchema, LedgerEntryRecordSchema, WagerTransactionRecordSchema],
    extensions: [Migrator],
    forceUtcTimezone: true,
    pool: { min: 0, max: Number(process.env.DATABASE_POOL_MAX ?? 10) },
    migrations: {
      // lista explícita: a ordem fica no código, sem varrer pasta em runtime
      migrationsList: [
        { name: "Migration20261019230000WalletsAndLedger", class: Migration20261019230000WalletsAndLedger },
        { name: "Migration20261020000000WagerTransactions", class: Migration20261020000000WagerTransactions },
        { name: "Migration20261020010000Outbox", class: Migration20261020010000Outbox },
        { name: "Migration20261020020000Inbox", class: Migration20261020020000Inbox },
        { name: "Migration20261020030000SingleReversal", class: Migration20261020030000SingleReversal },
        { name: "Migration20261020040000IdentifierLength", class: Migration20261020040000IdentifierLength },
      ],
      transactional: true,
      allOrNothing: true,
    },
  });
}
