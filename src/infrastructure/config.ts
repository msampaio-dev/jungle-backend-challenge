/** Componentes ligados por padrão; só "false" desliga. */
export function isEnabled(flag: string): boolean {
  return process.env[flag] !== "false";
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
