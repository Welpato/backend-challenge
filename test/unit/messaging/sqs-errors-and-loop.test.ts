import { describe, expect, it } from 'bun:test';
import { isTransientSqsError } from '@/messaging/sqs/sqs.client';
import { PollingLoop } from '@/shared/workers/polling-loop';

describe('isTransientSqsError', () => {
  it.each([
    ['connection refused', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['throttling', Object.assign(new Error('slow down'), { name: 'ThrottlingException' })],
    ['5xx', Object.assign(new Error('boom'), { name: 'Whatever', $metadata: { httpStatusCode: 503 } })],
    ['429', Object.assign(new Error('too many'), { name: 'Whatever', $metadata: { httpStatusCode: 429 } })],
    ['SDK retryable flag', Object.assign(new Error('x'), { $retryable: { throttling: false } })],
    ['timeout abort', Object.assign(new Error('aborted'), { name: 'TimeoutError' })],
  ])('treats %s as transient', (_label, error) => {
    expect(isTransientSqsError(error)).toBe(true);
  });

  it.each([
    [
      'missing queue',
      Object.assign(new Error('nope'), { name: 'QueueDoesNotExist', $metadata: { httpStatusCode: 400 } }),
    ],
    [
      'invalid parameter',
      Object.assign(new Error('bad'), { name: 'InvalidParameterValue', $metadata: { httpStatusCode: 400 } }),
    ],
    ['not an error', 'string'],
    ['null', null],
  ])('treats %s as permanent', (_label, error) => {
    expect(isTransientSqsError(error)).toBe(false);
  });
});

describe('PollingLoop', () => {
  it('runs immediately while busy, waits while idle and finishes the current iteration on stop', async () => {
    const results: ('busy' | 'idle')[] = ['busy', 'busy', 'idle'];
    let calls = 0;
    let release: () => void = () => undefined;
    const loop = new PollingLoop(
      async () => {
        calls += 1;
        if (calls === 4) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return results.shift() ?? 'idle';
      },
      { intervalMs: 20, onError: () => undefined },
    );
    loop.start();
    await Bun.sleep(5);
    expect(calls).toBe(3); // busy, busy → sem espera; idle → esperando
    await Bun.sleep(30);
    expect(calls).toBe(4); // 4ª iteração em andamento

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(10);
    expect(stopped).toBe(false); // espera a iteração atual
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(calls).toBe(4);
  });

  it('keeps looping after an iteration throws and reports the error', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const loop = new PollingLoop(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('transient');
        }
        return 'idle';
      },
      { intervalMs: 5, onError: (error) => errors.push(error) },
    );
    loop.start();
    await Bun.sleep(30);
    await loop.stop();
    expect(errors).toHaveLength(1);
    expect(calls).toBeGreaterThan(1);
  });
});
