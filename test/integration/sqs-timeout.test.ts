import { afterAll, beforeAll, expect, test } from "bun:test";
import type { TCPSocketListener } from "bun";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { WalletBalanceChanged } from "../../src/domain/messaging/wagering-events";
import { Money } from "../../src/domain/shared/money";
import { Wallet } from "../../src/domain/wallet/wallet";
import { createSqsClient, SqsEventPublisher } from "../../src/infrastructure/messaging/sqs";

/** "SQS" que aceita a conexão e nunca responde. */
let blackhole: TCPSocketListener;

beforeAll(() => {
  blackhole = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
});

afterAll(() => {
  blackhole.stop(true);
});

function anyMessage(): OutboxMessage {
  const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
  const { wallet } = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: brl("10.00"),
    openingTransactionId: crypto.randomUUID(),
    openingEntryId: crypto.randomUUID(),
    at: new Date(),
  });
  const entry = wallet.debit(brl("1.00"), { transactionId: crypto.randomUUID(), entryId: crypto.randomUUID(), at: new Date() });
  return OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, { correlationId: "c", occurredAt: new Date() }));
}

test(
  "SQS que não responde: a publicação falha por timeout em vez de travar para sempre",
  async () => {
    const client = createSqsClient({ endpoint: `http://127.0.0.1:${blackhole.port}`, requestTimeoutMs: 1_000 });
    const publisher = new SqsEventPublisher(client, `http://127.0.0.1:${blackhole.port}/000000000000/events.fifo`);

    const started = Date.now();
    await expect(publisher.publish(anyMessage())).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  },
  { timeout: 15_000 },
);
