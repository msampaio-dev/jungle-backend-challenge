import type { EntityManager } from "@mikro-orm/postgresql";

/**
 * De onde vem a hora. Todas as datas gravadas usam o relógio do banco,
 * dentro da transação: com várias instâncias, cada uma com o próprio
 * relógio, comparar datas de máquinas diferentes daria resultado errado.
 */
export interface ClockPort {
  now(em: EntityManager): Promise<Date>;
}
