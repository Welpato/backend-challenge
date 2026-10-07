import { describe, expect, it } from 'bun:test';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HealthController } from '@/health/health.controller';
import { ReadinessService } from '@/health/readiness.service';

@Injectable()
class GreetingService {
  greet(): string {
    return 'hello';
  }
}

@Injectable()
class GreetingConsumer {
  constructor(readonly greetingService: GreetingService) {}
}

@Module({ providers: [GreetingService, GreetingConsumer] })
class GreetingModule {}

describe('smoke', () => {
  it('runs under Bun 1.x', () => {
    expect(Bun.version.startsWith('1.')).toBe(true);
  });

  it('emits design:paramtypes so Nest can inject by type', () => {
    const paramTypes: unknown = Reflect.getMetadata('design:paramtypes', HealthController);
    expect(Array.isArray(paramTypes)).toBe(true);
    expect((paramTypes as unknown[])[0]).toBe(ReadinessService);
  });

  it('resolves dependencies by type without @Inject', async () => {
    const context = await NestFactory.createApplicationContext(GreetingModule, { logger: false });
    try {
      expect(context.get(GreetingConsumer).greetingService.greet()).toBe('hello');
    } finally {
      await context.close();
    }
  });
});
