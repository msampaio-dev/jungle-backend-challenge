import { describe, expect, test } from "bun:test";
import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { addToContext, runWithContext } from "../../src/application/shared/operation-context";
import { describeError } from "../../src/application/shared/describe-error";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = new JsonLogger((line) => lines.push(JSON.parse(line)));
  return { logger, lines };
}

describe("JsonLogger", () => {
  test("uma linha JSON por evento, com nível, contexto e campos", () => {
    const { logger, lines } = capture();
    logger.log({ msg: "message processed", transactionId: "tx-1", status: "PROCESSED" }, "SqsWagerConsumer");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      context: "SqsWagerConsumer",
      msg: "message processed",
      transactionId: "tx-1",
      status: "PROCESSED",
    });
    expect(Date.parse(lines[0]!.time as string)).not.toBeNaN();
  });

  test("texto simples vira msg", () => {
    const { logger, lines } = capture();
    logger.warn("algo estranho", "Teste");
    expect(lines[0]).toMatchObject({ level: "warn", context: "Teste", msg: "algo estranho" });
  });

  test("ids do contexto entram em toda linha sem ninguém passar", async () => {
    const { logger, lines } = capture();
    await runWithContext({ correlationId: "corr-1", messageId: "msg-1" }, async () => {
      await Promise.resolve();
      addToContext({ transactionId: "tx-9", walletId: "w-1", providerId: "provider-a" });
      logger.log({ msg: "depois de um await" }, "Teste");
    });
    logger.log({ msg: "fora do contexto" }, "Teste");

    expect(lines[0]).toMatchObject({
      correlationId: "corr-1",
      messageId: "msg-1",
      transactionId: "tx-9",
      walletId: "w-1",
      providerId: "provider-a",
    });
    expect(lines[1]!.correlationId).toBeUndefined();
  });

  test("contextos de requisições paralelas não se misturam", async () => {
    const { logger, lines } = capture();
    await Promise.all(
      ["a", "b", "c"].map((id) =>
        runWithContext({ correlationId: id }, async () => {
          await Bun.sleep(Math.random() * 10);
          logger.log({ msg: "req", expected: id }, "Teste");
        }),
      ),
    );
    for (const line of lines) expect(line.correlationId).toBe(line.expected);
  });

  test("campos financeiros e payloads nunca saem, mesmo se alguém passar", () => {
    const { logger, lines } = capture();
    logger.log(
      {
        msg: "x",
        transactionId: "tx-1",
        payload: { a: 1 },
        body: "{...}",
        data: { money: "25.00" },
        money: { amount: "25.00", currency: "BRL" },
        amount: "25.00",
        balance: "100.00",
        balanceBefore: "1",
        balanceAfter: "2",
        difference: { amount: "5.00" },
      },
      "Teste",
    );
    expect(Object.keys(lines[0]!).sort()).toEqual(["context", "level", "msg", "time", "transactionId"]);
  });

  test("erro do banco é logado sem o SQL (que carrega os valores)", () => {
    const { logger, lines } = capture();
    const driverError = new UniqueConstraintViolationException(
      Object.assign(new Error(`insert into wallets (id, player_id, balance) values ('w-1', 'player-secreto', 999.99) - duplicate key`), {
        code: "23505",
      }),
    );
    logger.error({ msg: "falhou", error: describeError(driverError) }, "Teste");

    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain("player-secreto");
    expect(text).not.toContain("999.99");
    expect(lines[0]).toMatchObject({ level: "error", error: { name: "UniqueConstraintViolationException", code: "23505" } });
  });

  test("erro comum mantém a mensagem, truncada", () => {
    const error = describeError(new Error("x".repeat(2000)));
    expect(error).toMatchObject({ name: "Error" });
    expect((error.message as string).length).toBeLessThanOrEqual(500);
  });
});
