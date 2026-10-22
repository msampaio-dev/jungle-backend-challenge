/**
 * O texto tem caractere de controle (U+0000 a U+001F, ou U+007F)?
 * Identificadores vindos de fora não têm por que trazer um, e o NUL em
 * especial é recusado pelo Postgres em colunas de texto: sem esta checagem,
 * a entrada inválida chegava ao banco e virava erro interno (500, ou retry
 * na fila) em vez de payload inválido.
 */
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
