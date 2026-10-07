import { describe, expect, it } from 'bun:test';
import { newUuidV7 } from '@/shared/ids';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newUuidV7', () => {
  it('generates RFC 9562 version 7 UUIDs', () => {
    expect(newUuidV7()).toMatch(UUID_V7);
  });

  it('generates unique ids that sort by creation order', () => {
    const ids = Array.from({ length: 1000 }, () => newUuidV7());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
