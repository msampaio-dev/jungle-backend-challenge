import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/shared/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/domain/shared/domain-error";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money — entrada e escala", () => {
  test.each([
    ["25", "25.00"],
    ["25.5", "25.50"],
    ["25.00", "25.00"],
    ["0", "0.00"],
    ["0.01", "0.01"],
    ["9999999999999999.99", "9999999999999999.99"],
  ])("aceita %p e serializa como %p", (input, expected) => {
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: "BRL" });
  });

  test.each([
    "",
    " 25.00",
    "25.00 ",
    "25.",
    ".50",
    "-1.00",
    "+1.00",
    "007.00",
    "1e3",
    "NaN",
    "Infinity",
    "10.005", // mais de 2 casas: recusa em vez de arredondar
    "1,50",
    "10000000000000000.00", // não cabe em NUMERIC(18,2)
  ])("recusa amount %p", (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  test("recusa amount que não é string", () => {
    const props = { amount: 25, currency: "BRL" } as unknown as { amount: string; currency: string };
    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

  test.each(["brl", "BR", "BRLL", "", "R$"])("recusa moeda %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });
});

describe("Money — aritmética exata", () => {
  test("0.10 + 0.20 é exatamente 0.30", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  test("somar um centavo um milhão de vezes não acumula erro", () => {
    let total = Money.zero("BRL");
    const cent = brl("0.01");
    for (let i = 0; i < 1_000_000; i++) total = total.add(cent);
    expect(total.toJSON().amount).toBe("10000.00");
  });

  test("subtract pode ficar negativo; quem barra saldo negativo é a Wallet", () => {
    const result = brl("20.00").subtract(brl("80.00"));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe("-60.00");
  });

  test("negate inverte o sinal e preserva a moeda", () => {
    const negated = brl("12.34").negate();
    expect(negated.toString()).toBe("-12.34 BRL");
    expect(negated.negate().equals(brl("12.34"))).toBe(true);
  });

  test("é imutável: operações devolvem nova instância", () => {
    const original = brl("10.00");
    original.add(brl("5.00"));
    original.subtract(brl("5.00"));
    expect(original.toJSON().amount).toBe("10.00");
  });
});

describe("Money — comparação", () => {
  test("isZero / isPositive / isNegative", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").negate().isNegative()).toBe(true);
  });

  test("isLessThan", () => {
    expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
    expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
  });

  test("equals considera a moeda e não lança erro", () => {
    expect(brl("1.00").equals(Money.from({ amount: "1.00", currency: "USD" }))).toBe(false);
    expect(brl("1").equals(brl("1.00"))).toBe(true);
  });
});

describe("Money — conflito de moeda", () => {
  const usd = Money.from({ amount: "1.00", currency: "USD" });

  test.each([
    ["add", () => brl("1.00").add(usd)],
    ["subtract", () => brl("1.00").subtract(usd)],
    ["isLessThan", () => brl("1.00").isLessThan(usd)],
  ])("%s entre moedas diferentes lança CurrencyMismatchError", (_name, operation) => {
    expect(operation).toThrow(CurrencyMismatchError);
  });
});
