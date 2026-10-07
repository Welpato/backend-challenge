/**
 * Gera UUID v7 (ordenável pelo tempo de criação). Usa o gerador nativo do Bun.
 */
export function newUuidV7(): string {
  return Bun.randomUUIDv7();
}
