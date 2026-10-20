import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { ConnectionException } from "@mikro-orm/core";
import { OutboxRelay } from "../../src/application/outbox/outbox-relay";
import { PendingReferenceWorker } from "../../src/application/wagering/pending-reference-worker";
import { ProcessWagerTransactionUseCase } from "../../src/application/wagering/process-wager-transaction.use-case";
import { OutboxRepository } from "../../src/infrastructure/database/outbox.repository";
import { WalletRepository } from "../../src/infrastructure/database/wallet.repository";
import { SqsWagerConsumer } from "../../src/infrastructure/messaging/sqs-wager-consumer";
import { registry } from "../../src/infrastructure/observability/metrics";
import { command, createWallet } from "./support/fixtures";
import { startTestApi, type TestApi } from "./support/http";
import { createTestQueue } from "./support/sqs";

/**
 * Métricas da seção 12. Contadores acumulam no processo inteiro, então
 * cada teste compara a diferença antes/depois da própria ação.
 */
let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await api.close();
});

/** Valor atual de uma série; histogramas usam o sufixo _count/_sum na série. */
async function value(name: string, labels: Record<string, string> = {}, series = name): Promise<number> {
  const metric = registry.getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} not registered`);
  const { values } = await metric.get();
  // contadores e gauges vêm sem metricName; histogramas vêm como x_bucket, x_sum e x_count
  const match = values.find(
    (v) => ((v as { metricName?: string }).metricName ?? name) === series && Object.entries(labels).every(([k, l]) => String(v.labels[k]) === l),
  );
  return match ? Number(match.value) : 0;
}

async function delta(name: string, labels: Record<string, string>, action: () => Promise<unknown>, series = name) {
  const before = await value(name, labels, series);
  await action();
  return (await value(name, labels, series)) - before;
}

const useCase = () => new ProcessWagerTransactionUseCase(api.orm);

describe("/metrics", () => {
  test("expõe todas as métricas pedidas, no formato Prometheus, sem autenticação", async () => {
    const { port } = api.app.getHttpServer().address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    for (const name of [
      "wagering_transactions_total",
      "wagering_duplicates_total",
      "wagering_retries_total",
      "sqs_dead_lettered_total",
      "sqs_dlq_messages",
      "wallet_lock_wait_seconds",
      "wallet_lock_conflicts_total",
      "outbox_pending_messages",
      "outbox_oldest_pending_age_seconds",
      "outbox_publish_delay_seconds",
      "wagering_processing_duration_seconds",
      "wagering_pending_references",
      "wallet_reconciliation_divergences_total",
    ]) {
      expect(text).toContain(`# TYPE ${name}`);
    }
  });
});

describe("transações e duplicatas", () => {
  test("aposta processada conta por canal, tipo e status, e mede a latência", async () => {
    const w = await createWallet(api.orm, "100.00");
    const labels = { channel: "http", kind: "BET", status: "PROCESSED" };
    const latency = { channel: "http", outcome: "PROCESSED" };
    const before = await value("wagering_processing_duration_seconds", latency, "wagering_processing_duration_seconds_count");

    expect(await delta("wagering_transactions_total", labels, () => useCase().execute(command(w)))).toBe(1);
    expect(await value("wagering_processing_duration_seconds", latency, "wagering_processing_duration_seconds_count")).toBe(before + 1);
  });

  test("rejeição conta no status REJECTED", async () => {
    const w = await createWallet(api.orm, "1.00");
    const labels = { channel: "http", kind: "BET", status: "REJECTED" };
    expect(await delta("wagering_transactions_total", labels, () => useCase().execute(command(w, { amount: "50.00" })))).toBe(1);
  });

  test("replay conta como duplicata e não como transação nova", async () => {
    const w = await createWallet(api.orm, "100.00");
    const bet = command(w);
    await useCase().execute(bet);
    const processed = { channel: "http", kind: "BET", status: "PROCESSED" };
    const before = await value("wagering_transactions_total", processed);

    expect(await delta("wagering_duplicates_total", { type: "idempotent_replay" }, () => useCase().execute(bet))).toBe(1);
    expect(await value("wagering_transactions_total", processed)).toBe(before);
  });
});

describe("locks", () => {
  test("toda espera pelo lock da wallet é medida", async () => {
    const w = await createWallet(api.orm, "100.00");
    const n = await delta("wallet_lock_wait_seconds", {}, () => useCase().execute(command(w)), "wallet_lock_wait_seconds_count");
    expect(n).toBeGreaterThanOrEqual(1);
  });

  test("estouro do lock_timeout conta como conflito de lock", async () => {
    const w = await createWallet(api.orm, "100.00");
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = api.orm.em.fork().transactional(async (em) => {
      await new WalletRepository().lockById(em, w.walletId);
      locked();
      await new Promise<void>((r) => (release = r));
    });
    await isLocked;

    const impatient = new ProcessWagerTransactionUseCase(api.orm, new WalletRepository(200));
    const n = await delta("wallet_lock_conflicts_total", { type: "lock_timeout" }, () =>
      impatient.execute(command(w)).catch(() => {}),
    );
    release();
    await holder;
    expect(n).toBe(1);
  });
});

describe("outbox", () => {
  test("pendentes e idade da mais antiga, medidos no banco; atraso medido ao publicar", async () => {
    const w = await createWallet(api.orm, "100.00"); // relay desligado na API de teste: eventos ficam pendentes
    expect(await value("outbox_pending_messages")).toBeGreaterThanOrEqual(2);
    expect(await value("outbox_oldest_pending_age_seconds")).toBeGreaterThanOrEqual(0);

    const published = await delta(
      "outbox_publish_delay_seconds",
      {},
      async () => {
        const relay = new OutboxRelay(api.orm, { publish: async () => {} }, { batchSize: 500, idleDelayMs: 0 });
        while ((await relay.publishBatch()).published > 0);
      },
      "outbox_publish_delay_seconds_count",
    );
    expect(published).toBeGreaterThanOrEqual(2);
    expect(await value("outbox_pending_messages")).toBe(0);
    expect(w.walletId).toBeString();
  });

  test("falha de publicação conta como retry da outbox", async () => {
    await createWallet(api.orm, "100.00");
    const down = { publish: async () => Promise.reject(new Error("sqs down")) };
    const n = await delta("wagering_retries_total", { component: "outbox_publish" }, () =>
      new OutboxRelay(api.orm, down).publishBatch(),
    );
    expect(n).toBe(1);
    await api.orm.em.getConnection().execute("update outbox_messages set published_at = now() where published_at is null");
  });
});

describe("pendentes de referência", () => {
  test("gauge de pendentes e retry do worker ao reagendar", async () => {
    const w = await createWallet(api.orm, "100.00");
    await useCase().execute(command(w, { kind: "REFUND", amount: "10.00", referenceExternalTransactionId: "nunca" }));
    expect(await value("wagering_pending_references")).toBeGreaterThanOrEqual(1);

    await api.orm.em.getConnection().execute("update wager_transactions set next_attempt_at = now() where status = 'PENDING_REFERENCE'");
    const worker = new PendingReferenceWorker(api.orm, useCase(), { batchSize: 50, idleDelayMs: 0, leaseMs: 30_000, maxResolutionFailures: 5 });
    const n = await delta("wagering_retries_total", { component: "pending_reference" }, () => worker.runOnce());
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe("métricas só depois do commit", () => {
  test("resolução do worker que é desfeita não conta como transação", async () => {
    const w = await createWallet(api.orm, "100.00");
    await useCase().execute(command(w, { kind: "REFUND", amount: "10.00", referenceExternalTransactionId: "bet-rollback-metric" }));
    await useCase().execute(command(w, { amount: "10.00", externalTransactionId: "bet-rollback-metric" }));

    class BrokenOutbox extends OutboxRepository {
      override async insert(): Promise<void> {
        throw new Error("disk full");
      }
    }
    const worker = new PendingReferenceWorker(
      api.orm,
      useCase(),
      { batchSize: 50, idleDelayMs: 0, leaseMs: 30_000, maxResolutionFailures: 5 },
      undefined,
      undefined,
      new BrokenOutbox(),
    );
    const labels = { channel: "worker", kind: "REFUND", status: "PROCESSED" };
    expect(await delta("wagering_transactions_total", labels, () => worker.runOnce())).toBe(0);
  });

  test("publicação cuja transação é desfeita não conta atraso de publicação", async () => {
    await createWallet(api.orm, "100.00");
    class BrokenSave extends OutboxRepository {
      override async save(): Promise<void> {
        throw new Error("disk full");
      }
    }
    const relay = new OutboxRelay(api.orm, { publish: async () => {} }, { batchSize: 1, idleDelayMs: 0 }, new BrokenSave());
    const n = await delta(
      "outbox_publish_delay_seconds",
      {},
      () => relay.publishBatch().catch(() => {}),
      "outbox_publish_delay_seconds_count",
    );
    expect(n).toBe(0);
    await api.orm.em.getConnection().execute("update outbox_messages set published_at = now() where published_at is null");
  });
});

describe("SQS", () => {
  test("DLQ, retry e reentrega reconhecida pela inbox", async () => {
    const dlq = await createTestQueue("metrics-dlq");
    const main = await createTestQueue("metrics-main");
    const options = {
      queueUrl: main.queueUrl, dlqUrl: dlq.queueUrl, consumerName: "metrics", waitTimeSeconds: 1,
      maxAttempts: 5, backoffBaseSeconds: 0, backoffMaxSeconds: 0,
    };
    const w = await createWallet(api.orm, "100.00");

    // envelope inválido vai para a DLQ com o motivo
    await main.send("{ não é json", w.walletId);
    expect(
      await delta("sqs_dead_lettered_total", { reason: "INVALID_ENVELOPE" }, () =>
        new SqsWagerConsumer(main.client, api.orm, useCase(), options).pollOnce(),
      ),
    ).toBe(1);

    // falha transitória conta retry
    const { idempotencyKey, ...data } = command(w);
    const msg = { messageId: `m-${crypto.randomUUID()}`, type: "WagerTransactionRequested", data: { ...data, idempotencyKey } };
    await main.send(msg, w.walletId);
    const down = { execute: async () => Promise.reject(new ConnectionException(new Error("db down"))) };
    expect(
      await delta("wagering_retries_total", { component: "sqs_consumer" }, () =>
        new SqsWagerConsumer(main.client, api.orm, down as never, options).pollOnce(),
      ),
    ).toBe(1);

    // processa e depois a mesma mensagem volta: duplicata reconhecida pela inbox
    await new SqsWagerConsumer(main.client, api.orm, useCase(), options).pollOnce();
    await main.send(msg, w.walletId);
    expect(
      await delta("wagering_duplicates_total", { type: "inbox_redelivery" }, () =>
        new SqsWagerConsumer(main.client, api.orm, useCase(), options).pollOnce(),
      ),
    ).toBe(1);

    expect(Number.isNaN(await value("sqs_dlq_messages"))).toBe(false);
    await main.delete();
    await dlq.delete();
  });
});

describe("reconciliação", () => {
  test("divergência conta na métrica", async () => {
    const w = await createWallet(api.orm, "100.00");
    await api.orm.em.getConnection().execute("update wallets set balance = balance + 1 where id = ?", [w.walletId]);
    expect(
      await delta("wallet_reconciliation_divergences_total", {}, () => api.call("POST", `/wallets/${w.walletId}/reconciliation`)),
    ).toBe(1);
  });
});
