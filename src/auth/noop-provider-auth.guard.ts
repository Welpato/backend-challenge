import type { IncomingMessage } from 'node:http';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import {
  PROVIDER_IDENTITY_PORT,
  PROVIDER_IDENTITY_REQUEST_KEY,
  type ProviderIdentity,
  type ProviderIdentityPort,
  type RequestWithProviderIdentity,
} from './provider-identity.port';

/** Implementação nula da porta: nenhuma requisição carrega identidade. */
export class NoopProviderIdentity implements ProviderIdentityPort {
  resolve(_request: IncomingMessage): ProviderIdentity | null {
    return null;
  }
}

/**
 * Autenticação **não implementada** (vale 0 ponto; o enunciado aceita, DESAFIO.md §2). Este guard é o ponto de
 * extensão explícito: aceita toda requisição e anexa a identidade resolvida pela `ProviderIdentityPort`
 * (sempre `null` aqui) em `request.providerIdentity`. Aplicado nos controllers de wallet e wagering;
 * **não** em `/health/*` nem `/metrics`, que ficam abertos.
 *
 * Desenho adotado com Keycloak (a documentar no ARCHITECTURE.md):
 * - um *client* confidencial por provedor de jogos, fluxo OAuth2 *client credentials*;
 * - a API valida o JWT de acesso (assinatura via JWKS do realm, `iss`, `aud`, `exp`) num
 *   `KeycloakProviderIdentity` que implementa a mesma porta; a claim `azp` (client id) vira o `providerId`;
 * - o guard real devolve 401 sem token válido, e o use case de wagering confere `body.providerId === identity.providerId`
 *   (403 caso contrário) — o `providerId` do payload continua passando pelas mesmas validações de domínio;
 * - mensagens do SQS são canal interno confiável: o consumidor não passa por este guard.
 * Trocar o provider de `PROVIDER_IDENTITY_PORT` e o guard no `AuthModule` é a única mudança de wiring.
 */
@Injectable()
export class NoopProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY_PORT) private readonly identities: ProviderIdentityPort) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithProviderIdentity>();
    request[PROVIDER_IDENTITY_REQUEST_KEY] = this.identities.resolve(request);
    return true;
  }
}
