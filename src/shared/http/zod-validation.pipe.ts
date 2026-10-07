import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { type FieldIssue, RequestValidationError } from './api-error';

/** Converte as issues do zod em `FieldIssue` (`path` com pontos; `prefix` = nome do parâmetro de rota/query). */
export function fieldIssuesFrom(error: z.ZodError, prefix?: string): FieldIssue[] {
  return error.issues.map((issue) => {
    const segments = [...(prefix === undefined ? [] : [prefix]), ...issue.path.map((part) => String(part))];
    return { path: segments.length === 0 ? '(root)' : segments.join('.'), message: issue.message };
  });
}

/**
 * Pipe de validação com zod: devolve o valor já transformado (ex.: `Money`) ou lança
 * `RequestValidationError` (400 `VALIDATION_ERROR` com os campos). Uso:
 * `@Body(new ZodValidationPipe(schema))`, `@Param('id', new ZodValidationPipe(schema))`.
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
    const prefix = metadata.type !== 'body' && metadata.data !== undefined ? metadata.data : undefined;
    throw new RequestValidationError(fieldIssuesFrom(result.error, prefix));
  }
}
