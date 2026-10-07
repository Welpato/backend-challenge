/**
 * Opções de leitura comuns aos repositórios. As leituras não passam pelo Identity Map: cada `find`
 * vai ao banco e devolve um record solto. Assim (1) uma leitura com lock nunca devolve uma versão em
 * cache de antes do lock (armadilha da F07) e (2) o `flush` implícito do `transactional()` não tem
 * entidades gerenciadas para comparar/gravar — toda escrita é explícita (`insert`/`nativeUpdate`).
 */
export const UNTRACKED = { disableIdentityMap: true } as const;
