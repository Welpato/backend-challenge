import type { IncomingMessage } from 'node:http';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { newUuidV7 } from '@/shared/ids';
import { currentCorrelationId } from '@/shared/observability/correlation';

/** `correlationId` da requisição (definido pelo `correlationMiddleware`). */
export const CorrelationId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<IncomingMessage & { correlationId?: string }>();
  return request.correlationId ?? currentCorrelationId() ?? newUuidV7();
});
