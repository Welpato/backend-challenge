import { Module } from '@nestjs/common';
import { NoopProviderAuthGuard, NoopProviderIdentity } from './noop-provider-auth.guard';
import { PROVIDER_IDENTITY_PORT } from './provider-identity.port';

/** Ponto de extensão de autenticação dos provedores (no-op; ver `NoopProviderAuthGuard`). */
@Module({
  providers: [{ provide: PROVIDER_IDENTITY_PORT, useClass: NoopProviderIdentity }, NoopProviderAuthGuard],
  exports: [PROVIDER_IDENTITY_PORT, NoopProviderAuthGuard],
})
export class AuthModule {}
