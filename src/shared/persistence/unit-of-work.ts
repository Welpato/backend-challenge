import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { UnitOfWorkScopeError } from '@/shared/persistence/persistence.errors';
import { classifyPgError } from '@/shared/persistence/pg-errors';

export type TransactionIsolation = 'read committed' | 'repeatable read' | 'serializable';

export interface UnitOfWorkOptions {
  /** Default: `read committed` (ESPECIFICACAO.md §2). */
  readonly isolation?: TransactionIsolation;
  /** Default: `DB_LOCK_TIMEOUT_MS` (3s). Aplicado com `SET LOCAL lock_timeout` — vale só nesta transação. */
  readonly lockTimeoutMs?: number;
}

export interface UnitOfWorkDefaults {
  readonly lockTimeoutMs: number;
}

/** Token de injeção (o Nest resolve por classe também; o símbolo existe para testes/overrides). */
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

/**
 * Unidade de trabalho = uma transação SQL (`em.transactional()`) com `lock_timeout` fixado.
 *
 * **Como os repositórios enxergam a transação: AsyncLocalStorage.** `run` guarda o `EntityManager` do
 * escopo transacional num `AsyncLocalStorage`; os repositórios leem `uow.em` e falham com
 * `UnitOfWorkScopeError` se chamados fora de `run`. Assim as assinaturas das portas não carregam tipos do
 * ORM (o use case não conhece `EntityManager`) e nenhuma query de escrita ou com lock roda fora de uma
 * transação por engano. O callback também recebe o `em`, para queries pontuais em testes.
 *
 * Regras:
 * - cada `run` usa um fork novo do EntityManager (Identity Map vazio — nada em cache de outra transação);
 * - `run` aninhado é proibido (lança): a ordem de locks (§2) depende de saber onde a transação começa;
 * - os repositórios usam operações nativas (`insert`/`nativeUpdate`/`execute`) e leituras com `refresh`;
 *   o `flush` implícito do `transactional()` no fim não tem nada a gravar — e nunca há `flush` fora daqui;
 * - erros do PostgreSQL saem classificados (`TransientDatabaseError`, `UniqueViolationError`,
 *   `CheckViolationError`, ver `pg-errors.ts`), inclusive os do COMMIT (constraint trigger diferida).
 *   Os demais erros (domínio, bugs) passam sem alteração.
 */
export class UnitOfWork {
  private readonly scope = new AsyncLocalStorage<EntityManager>();

  constructor(
    private readonly orm: MikroORM,
    private readonly defaults: UnitOfWorkDefaults,
  ) {}

  async run<T>(work: (em: EntityManager) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    if (this.scope.getStore() !== undefined) {
      throw new UnitOfWorkScopeError('Nested UnitOfWork.run is not allowed');
    }
    const lockTimeoutMs = options.lockTimeoutMs ?? this.defaults.lockTimeoutMs;
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new RangeError('lockTimeoutMs must be a positive integer');
    }
    try {
      return await this.orm.em.fork({ clear: true }).transactional(
        async (em) => {
          await em.execute('select set_config(?, ?, true)', ['lock_timeout', `${lockTimeoutMs}ms`]);
          return this.scope.run(em, () => work(em));
        },
        { isolationLevel: options.isolation ?? 'read committed' },
      );
    } catch (error: unknown) {
      throw classifyPgError(error) ?? error;
    }
  }

  /** `EntityManager` da transação corrente. Só pode ser chamado dentro de `run`. */
  get em(): EntityManager {
    const em = this.scope.getStore();
    if (em === undefined) {
      throw new UnitOfWorkScopeError('Repository used outside of UnitOfWork.run');
    }
    return em;
  }

  isActive(): boolean {
    return this.scope.getStore() !== undefined;
  }
}
