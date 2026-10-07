import type { FailureCode } from '@/shared/failure-code';

/**
 * Base dos erros de domínio. `code` é preferencialmente um `FailureCode` (§3.8); outros códigos
 * (ex.: erros de programação como `INVALID_TRANSACTION_STATE`) são permitidos como string.
 */
export abstract class DomainError extends Error {
  readonly code: FailureCode | string;

  protected constructor(code: FailureCode | string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}
