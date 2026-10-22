/**
 * O SQS só aceita em atributo os caracteres da especificação XML (tab, quebra
 * de linha e os intervalos Unicode válidos). O motivo pode repetir um valor
 * vindo do provedor ("invalid amount: ..."); com um caractere de controle, o
 * envio à DLQ era recusado e a mensagem queimava as tentativas.
 */
export function sqsSafeText(text: string): string {
  return text.replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "?");
}

/**
 * Motivo enviado à DLQ como atributo: no máximo 1000 unidades e só caracteres
 * aceitos. Corta ANTES de limpar: o corte pode partir um emoji (par UTF-16) e
 * deixar metade dele, que a limpeza então troca por "?". Na ordem inversa a
 * metade sobrava e o SQS recusava o atributo.
 */
export function dlqReasonText(reason: string, fallback: string): string {
  return sqsSafeText(reason.slice(0, 1000)) || fallback;
}
