import type { IncomingMessage } from 'node:http';

/** Identidade do provedor de jogos autenticado. */
export interface ProviderIdentity {
  readonly providerId: string;
}

/**
 * Ponto de extensão da autenticação (DESAFIO.md §2, ESPECIFICACAO.md §2). Resolve a identidade do provedor a
 * partir da requisição; `null` = requisição sem identidade (hoje sempre, com o `NoopProviderIdentity`).
 */
export interface ProviderIdentityPort {
  resolve(request: IncomingMessage): ProviderIdentity | null;
}

export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');

/** Propriedade da requisição onde o guard anexa a identidade resolvida (`ProviderIdentity | null`). */
export const PROVIDER_IDENTITY_REQUEST_KEY = 'providerIdentity';

export type RequestWithProviderIdentity = IncomingMessage & {
  [PROVIDER_IDENTITY_REQUEST_KEY]?: ProviderIdentity | null;
};
