/**
 * Espera a janela passar E a condição valer. Testes de backoff contam
 * tentativas numa janela de tempo; numa máquina lenta (CI carregada) o
 * mínimo esperado demora mais para acontecer. Em vez de falhar, a espera
 * se alonga, até o prazo de segurança. O máximo (prova de que não há laço
 * quente) só fica mais folgado quando a máquina é lenta.
 */
export async function waitAtLeast(windowMs: number, condition: () => boolean, deadlineMs = 5_000): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < windowMs || !condition()) {
    if (performance.now() - started > deadlineMs) throw new Error(`condição não atingida em ${deadlineMs}ms`);
    await Bun.sleep(10);
  }
}
