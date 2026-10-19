import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { LedgerEntryRecordSchema, WalletRecordSchema } from "./records";
import { Migration20261019230000WalletsAndLedger } from "./migrations/Migration20261019230000WalletsAndLedger";

export function createOrmConfig(clientUrl = process.env.DATABASE_URL) {
  return defineConfig({
    clientUrl,
    entities: [WalletRecordSchema, LedgerEntryRecordSchema],
    extensions: [Migrator],
    forceUtcTimezone: true,
    pool: { min: 0, max: Number(process.env.DATABASE_POOL_MAX ?? 10) },
    migrations: {
      // lista explícita: a ordem fica no código, sem varrer pasta em runtime
      migrationsList: [
        { name: "Migration20261019230000WalletsAndLedger", class: Migration20261019230000WalletsAndLedger },
      ],
      transactional: true,
      allOrNothing: true,
    },
  });
}
