import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/**
 * Record de teste da F00 (tabela criada pela migration `0000_spike`).
 * Valida o estilo schema-first (`defineEntity`) que os records reais da F07 vão usar.
 */
export const SpikeAccountSchema = defineEntity({
  name: 'SpikeAccount',
  tableName: 'spike_account',
  properties: {
    id: p.uuid().primary(),
    balance: p.decimal('string').precision(20).scale(2),
    version: p.integer(),
  },
});

export type SpikeAccount = InferEntity<typeof SpikeAccountSchema>;
