import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { classifyError, ErrorKind, errorCode } from "../../src/application/error-kind";
import { PendingReferenceWorker } from "../../src/application/wagering/pending-reference-worker";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import { createOrmConfig } from "../../src/infrastructure/database/mikro-orm.config";
import { createTestOrm } from "./support/database";
import { command, createWallet, processor } from "./support/fixtures";
import { expectLedgerInvariant } from "./support/invariant";

/**
 * Erros de conexão com o banco não trazem código SQL: o driver pg só dá a
 * mensagem. Mesmo assim são infraestrutura, não bug: 503 na API, retry no
 * worker sem contar como falha da transação.
 */
let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  try {
    await expectLedgerInvariant(orm);
  } finally {
    await orm.close();
  }
});

/** Erro real: a conexão da transação é derrubada pelo Postgres no meio dela (failover, restart). */
async function connectionLostError(): Promise<unknown> {
  const victim = await MikroORM.init(createOrmConfig(process.env.DATABASE_TEST_URL));
  try {
    return await victim.em
      .fork()
      .transactional(async (em) => {
        const [{ pid }] = await em.execute("select pg_backend_pid() as pid");
        await orm.em.getConnection().execute("select pg_terminate_backend(?)", [pid]);
        await Bun.sleep(200);
        await em.execute("select 1");
      })
      .then(() => undefined, (error: unknown) => error);
  } finally {
    await victim.close(true).catch(() => {});
  }
}

describe("classificação", () => {
  test("conexão derrubada no meio da transação é transitória", async () => {
    const error = await connectionLostError();
    expect(error).toBeDefined();
    expect(classifyError(error)).toBe(ErrorKind.Transient);
    expect(errorCode(error)).toBe("SERVICE_UNAVAILABLE");
  });

  test("pool sem conexão livre é transitório", async () => {
    const small = await MikroORM.init({
      ...createOrmConfig(process.env.DATABASE_TEST_URL),
      pool: { min: 0, max: 1, acquireTimeoutMillis: 300 },
    });
    let release!: () => void;
    const holding = small.em.fork().transactional(async (em) => {
      await em.execute("select 1");
      await new Promise<void>((resolve) => (release = resolve));
    });
    while (!release) await Bun.sleep(10);
    try {
      const w = await createWallet(orm, "100.00");
      const error = await processor(small).execute(command(w)).then(() => undefined, (e: unknown) => e);
      expect((error as Error).name).toBe("KnexTimeoutError");
      expect(classifyError(error)).toBe(ErrorKind.Transient);
    } finally {
      release();
      await holding;
      await small.close();
    }
  });
});

test("worker: queda de conexão não conta como falha da pendente (não leva a FAILED)", async () => {
  const w = await createWallet(orm, "100.00");
  const pending = await processor(orm).execute(command(w, { kind: "REFUND", amount: "5.00", referenceExternalTransactionId: "nao-chegou" }));
  expect(pending.status).toBe("PENDING_REFERENCE");

  const lost = await connectionLostError();
  class FailoverUseCase extends ProcessWagerTransactionUseCase {
    override async resolve(): Promise<never> {
      throw lost;
    }
  }
  const worker = new PendingReferenceWorker(orm, new FailoverUseCase(orm), {
    batchSize: 50, idleDelayMs: 0, leaseMs: 30_000, maxResolutionFailures: 1,
  });
  await orm.em.getConnection().execute("update wager_transactions set next_attempt_at = now() where id = ?", [pending.transactionId]);
  expect(await worker.runOnce()).toEqual(["failed"]);

  const [row] = await orm.em
    .getConnection()
    .execute("select status, resolution_failures from wager_transactions where id = ?", [pending.transactionId]);
  expect(row).toMatchObject({ status: "PENDING_REFERENCE", resolution_failures: 0 });
});
