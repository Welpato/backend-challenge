import { describe, expect, it } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CORRELATION_HEADER,
  correlationMiddleware,
  currentCorrelationId,
  resolveCorrelationId,
  runWithCorrelation,
} from '@/shared/observability/correlation';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeExchange(headerValue?: string): { req: IncomingMessage; res: ServerResponse; sent: Map<string, string> } {
  const sent = new Map<string, string>();
  const headers = headerValue === undefined ? {} : { [CORRELATION_HEADER]: headerValue };
  const req = { headers } as unknown as IncomingMessage;
  const res = {
    setHeader: (name: string, value: string) => {
      sent.set(name, value);
    },
  } as unknown as ServerResponse;
  return { req, res, sent };
}

describe('correlation', () => {
  it('keeps a valid incoming correlation id', () => {
    expect(resolveCorrelationId('abc-123')).toBe('abc-123');
    expect(resolveCorrelationId(['first:1', 'second'])).toBe('first:1');
  });

  it('generates a uuid v7 when the header is missing or unsafe', () => {
    expect(resolveCorrelationId(undefined)).toMatch(UUID_V7);
    expect(resolveCorrelationId('')).toMatch(UUID_V7);
    expect(resolveCorrelationId('has spaces')).toMatch(UUID_V7);
    expect(resolveCorrelationId('x'.repeat(129))).toMatch(UUID_V7);
    expect(resolveCorrelationId('line\nbreak')).toMatch(UUID_V7);
  });

  it('exposes the id through AsyncLocalStorage across awaits', async () => {
    expect(currentCorrelationId()).toBeUndefined();
    const seen = await runWithCorrelation({ correlationId: 'ctx-1' }, async () => {
      await Bun.sleep(1);
      return currentCorrelationId();
    });
    expect(seen).toBe('ctx-1');
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('middleware echoes the header and runs next inside the context', () => {
    const { req, res, sent } = fakeExchange('req-42');
    let insideNext: string | undefined;

    correlationMiddleware(req, res, () => {
      insideNext = currentCorrelationId();
    });

    expect(sent.get(CORRELATION_HEADER)).toBe('req-42');
    expect(insideNext).toBe('req-42');
  });

  it('middleware generates an id when none is sent', () => {
    const { req, res, sent } = fakeExchange();
    correlationMiddleware(req, res, () => {});
    expect(sent.get(CORRELATION_HEADER)).toMatch(UUID_V7);
  });
});
