import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NoopProviderAuthGuard, NoopProviderIdentity } from '@/auth/noop-provider-auth.guard';
import type { RequestWithProviderIdentity } from '@/auth/provider-identity.port';
import { HealthController } from '@/health/health.controller';
import { MetricsController } from '@/shared/observability/metrics.controller';
import { WalletController } from '@/wallet/http/wallet.controller';

function contextFor(request: RequestWithProviderIdentity): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('NoopProviderAuthGuard', () => {
  it('accepts every request and attaches a null provider identity', () => {
    const request = { headers: {} } as RequestWithProviderIdentity;
    const guard = new NoopProviderAuthGuard(new NoopProviderIdentity());
    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.providerIdentity).toBeNull();
  });

  it('attaches whatever identity the port resolves (extension point)', () => {
    const request = { headers: {} } as RequestWithProviderIdentity;
    const guard = new NoopProviderAuthGuard({ resolve: () => ({ providerId: 'provider-a' }) });
    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.providerIdentity).toEqual({ providerId: 'provider-a' });
  });

  it('is applied to the wallet controller but not to health or metrics', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, WalletController)).toEqual([NoopProviderAuthGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, HealthController)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, MetricsController)).toBeUndefined();
  });
});
