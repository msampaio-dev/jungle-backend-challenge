import { DriverException } from "@mikro-orm/core";

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
