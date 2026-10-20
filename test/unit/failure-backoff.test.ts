import { expect, test } from "bun:test";
import { DEFAULT_FAILURE_BACKOFF, FailureBackoff } from "../../src/application/shared/failure-backoff";

test("cada falha seguida dobra a espera, até o teto", () => {
  const backoff = new FailureBackoff({ baseMs: 1_000, maxMs: 30_000 });
  const delays = Array.from({ length: 8 }, () => backoff.failed());
  expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  expect(backoff.consecutiveFailures).toBe(8);
});

test("um sucesso volta ao começo e informa quantas falhas houve", () => {
  const backoff = new FailureBackoff({ baseMs: 1_000, maxMs: 30_000 });
  backoff.failed();
  backoff.failed();
  backoff.failed();
  expect(backoff.succeeded()).toBe(3);
  expect(backoff.succeeded()).toBe(0); // sem falhas pendentes, nada a anunciar
  expect(backoff.failed()).toBe(1_000);
});

test("só a primeira falha e as que mudam de patamar merecem log", () => {
  const backoff = new FailureBackoff({ baseMs: 1_000, maxMs: 4_000 });
  const logged = Array.from({ length: 6 }, () => {
    backoff.failed();
    return backoff.shouldLog();
  });
  // 1s, 2s, 4s (teto), 4s, 4s, 4s: no teto, loga a cada 10 falhas
  expect(logged).toEqual([true, true, true, false, false, false]);
});

test("padrão: começa em 1s e não passa de 10s (volta rápido depois de uma queda longa)", () => {
  expect(DEFAULT_FAILURE_BACKOFF).toEqual({ baseMs: 1_000, maxMs: 10_000 });
});
