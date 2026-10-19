import { createHash } from "node:crypto";

/**
 * JSON canônico: chaves em ordem alfabética em todos os níveis e campos
 * undefined omitidos. O mesmo conteúdo gera sempre a mesma string,
 * independente da ordem em que os campos chegaram.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** SHA-256 em hex (64 caracteres) do JSON canônico. */
export function payloadHash(fields: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(fields), "utf8").digest("hex");
}
