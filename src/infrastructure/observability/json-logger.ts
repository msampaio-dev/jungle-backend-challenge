import { DriverException } from "@mikro-orm/core";
import type { LoggerService } from "@nestjs/common";
import { currentContext } from "./context";

type Level = "debug" | "info" | "warn" | "error";

/**
 * Chaves que nunca vão para o log, mesmo que alguém as passe por engano:
 * payloads inteiros e valores financeiros (seção 12 do desafio).
 */
const FORBIDDEN_KEYS = new Set([
  "payload",
  "body",
  "data",
  "money",
  "amount",
  "balance",
  "balanceBefore",
  "balanceAfter",
  "resultBalance",
  "difference",
]);

const MAX_MESSAGE_LENGTH = 500;

/**
 * Resume um erro para log. Erro do driver do banco traz o SQL com os valores
 * (ids de jogador, valores de aposta) na mensagem: dele só sai o tipo e o
 * código SQL. Os demais saem com a mensagem truncada.
 */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof DriverException) {
    return { name: error.constructor.name, code: error.code ?? (error as { sqlState?: string }).sqlState };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message.slice(0, MAX_MESSAGE_LENGTH) };
  }
  return { name: typeof error, message: String(error).slice(0, MAX_MESSAGE_LENGTH) };
}

/**
 * Logger do Nest que escreve uma linha JSON por evento. Junta os ids do
 * contexto atual (correlationId, messageId, transactionId...) em toda linha.
 */
export class JsonLogger implements LoggerService {
  constructor(private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.emit("info", message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.emit("warn", message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.emit("error", message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.emit("debug", message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit("debug", message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.emit("error", message, rest);
  }

  private emit(level: Level, message: unknown, rest: unknown[]): void {
    // convenção do Nest: o último argumento em texto é o contexto (nome da classe)
    const context = typeof rest.at(-1) === "string" ? (rest.at(-1) as string) : undefined;
    const fields =
      message instanceof Error
        ? { msg: message.message.slice(0, MAX_MESSAGE_LENGTH), error: describeError(message) }
        : typeof message === "object" && message !== null
          ? (message as Record<string, unknown>)
          : { msg: String(message) };

    const line: Record<string, unknown> = { time: new Date().toISOString(), level };
    if (context) line.context = context;
    const merged: Record<string, unknown> = { ...currentContext(), ...fields };
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined || FORBIDDEN_KEYS.has(key)) continue;
      line[key] = value instanceof Error ? describeError(value) : value;
    }
    this.write(JSON.stringify(line));
  }
}
