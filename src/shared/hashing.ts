import { createHash } from 'node:crypto';

/** SHA-256 do texto em UTF-8, em hexadecimal minúsculo (64 caracteres). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
