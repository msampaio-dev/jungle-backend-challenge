import type { EntityManager } from "@mikro-orm/postgresql";

/**
 * Hora atual do banco. Agendamentos (próxima checagem da referência,
 * backoff da outbox) são comparados com now() do Postgres; calculá-los com
 * o relógio da máquina faria instâncias com relógios diferentes atrasarem
 * ou adiantarem tudo. O banco é um só.
 *
 * clock_timestamp() e não now(): now() é a hora do INÍCIO da transação, e
 * um backoff contado a partir dela já nasceria vencido depois de uma
 * publicação lenta.
 */
export async function databaseNow(em: EntityManager): Promise<Date> {
  const [row] = await em.execute("select clock_timestamp() as now");
  return new Date(row!.now);
}
