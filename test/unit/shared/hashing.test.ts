import { describe, expect, it } from 'bun:test';
import { canonicalJson } from '@/shared/canonical-json';
import { sha256Hex } from '@/shared/hashing';

describe('sha256Hex', () => {
  it('returns 64 lowercase hex characters', () => {
    expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches known test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('is stable across calls', () => {
    expect(sha256Hex('payload')).toBe(sha256Hex('payload'));
  });

  it('hashes UTF-8 text', () => {
    expect(sha256Hex('ç')).not.toBe(sha256Hex('c'));
    expect(sha256Hex('ç')).toBe(sha256Hex('ç'));
  });

  it('yields the same hash for payloads that differ only in key order', () => {
    const a = sha256Hex(canonicalJson({ walletId: 'w', money: { currency: 'BRL', amount: '25.00' } }));
    const b = sha256Hex(canonicalJson({ money: { amount: '25.00', currency: 'BRL' }, walletId: 'w' }));
    expect(a).toBe(b);
  });

  it('changes when the payload changes', () => {
    const a = sha256Hex(canonicalJson({ money: { amount: '25.00', currency: 'BRL' } }));
    const b = sha256Hex(canonicalJson({ money: { amount: '25.01', currency: 'BRL' } }));
    expect(a).not.toBe(b);
  });
});
