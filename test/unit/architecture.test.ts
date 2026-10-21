import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * Regra de dependência entre as camadas, conferida nos imports:
 *   interfaces, infrastructure ─▶ application ─▶ domain
 * A aplicação fala com o mundo de fora só por portas (application/ports),
 * que a infraestrutura implementa e monta (infrastructure/wiring.ts).
 */

const IMPORT = /(?:import|export)[^"']*?from\s*["']([^"']+)["']/g;

async function importsOf(layer: string): Promise<Array<{ file: string; specifier: string }>> {
  const found: Array<{ file: string; specifier: string }> = [];
  for await (const file of new Glob(`src/${layer}/**/*.ts`).scan(".")) {
    const source = await Bun.file(file).text();
    for (const match of source.matchAll(IMPORT)) found.push({ file: file.replaceAll("\\", "/"), specifier: match[1]! });
  }
  return found;
}

function violations(imports: Array<{ file: string; specifier: string }>, forbidden: RegExp): string[] {
  return imports.filter((i) => forbidden.test(i.specifier)).map((i) => `${i.file} -> ${i.specifier}`);
}

describe("regra de dependência", () => {
  test("o domínio não depende de nenhuma outra camada nem de framework", async () => {
    const imports = await importsOf("domain");
    expect(imports.length).toBeGreaterThan(0);
    expect(violations(imports, /\/(application|infrastructure|interfaces|health)\/|^@nestjs|^@mikro-orm|^@aws-sdk|^prom-client/)).toEqual([]);
  });

  test("a aplicação não importa infraestrutura nem interfaces: fala por portas", async () => {
    const imports = await importsOf("application");
    expect(imports.length).toBeGreaterThan(0);
    // MikroORM fica permitido de propósito: a transação é o EntityManager (ver ARCHITECTURE.md)
    expect(violations(imports, /\/(infrastructure|interfaces|health)\/|^@aws-sdk|^prom-client/)).toEqual([]);
  });
});
