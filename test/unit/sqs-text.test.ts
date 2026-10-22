import { describe, expect, test } from "bun:test";
import { dlqReasonText } from "../../src/infrastructure/messaging/sqs-text";

/** Metade de um par UTF-16 sem a outra: o SQS recusa em atributo String. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++; // par completo
    } else if (isLow) {
      return true;
    }
  }
  return false;
}

describe("motivo enviado à DLQ", () => {
  const emoji = String.fromCodePoint(0x1f600); // ocupa duas unidades UTF-16

  test("cortar em 1000 não parte um emoji ao meio", () => {
    const reason = "x".repeat(999) + emoji + "fim"; // o emoji cruza a posição 1000
    const text = dlqReasonText(reason, "INVALID_MONEY");
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(hasLoneSurrogate(text)).toBe(false);
  });

  test("emoji que cabe inteiro é mantido; caractere de controle vira ?", () => {
    const text = dlqReasonText("a" + String.fromCharCode(0) + "b" + emoji, "X");
    expect(text).toBe("a?b" + emoji);
  });

  test("motivo vazio usa o código como texto (atributo String não pode ser vazio)", () => {
    expect(dlqReasonText("", "INVALID_ENVELOPE")).toBe("INVALID_ENVELOPE");
  });
});
