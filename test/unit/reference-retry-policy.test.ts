import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REFERENCE_RETRY_POLICY as policy,
  nextReferenceCheckAt,
  referenceAttemptsExhausted,
} from "../../src/domain/wagering/reference-retry-policy";

const T0 = new Date("2026-10-20T12:00:00.000Z");

describe("política de espera da referência", () => {
  test("espera dobra a cada tentativa até o teto de 120s", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map(
      (attemptsMade) => (nextReferenceCheckAt(policy, attemptsMade, T0).getTime() - T0.getTime()) / 1000,
    );
    expect(delays).toEqual([2, 4, 8, 16, 32, 64, 120]);
  });

  test("8 tentativas cobrem cerca de 4 minutos", () => {
    let total = 0;
    for (let attemptsMade = 1; attemptsMade < policy.maxAttempts; attemptsMade++) {
      total += nextReferenceCheckAt(policy, attemptsMade, T0).getTime() - T0.getTime();
    }
    expect(total / 1000).toBe(246);
  });

  test("esgota na oitava tentativa", () => {
    expect(referenceAttemptsExhausted(policy, 7)).toBe(false);
    expect(referenceAttemptsExhausted(policy, 8)).toBe(true);
  });
});
