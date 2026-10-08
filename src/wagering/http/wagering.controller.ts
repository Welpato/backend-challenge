import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { NoopProviderAuthGuard } from '@/auth/noop-provider-auth.guard';
import { ApiError } from '@/shared/http/api-error';
import { CorrelationId } from '@/shared/http/correlation-id.decorator';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';
import { GetWagerTransaction } from '@/wagering/application/get-wager-transaction';
import { ProcessWagerTransaction } from '@/wagering/application/process-wager-transaction';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';
import {
  externalTransactionIdParamSchema,
  parseIdempotencyKey,
  providerIdParamSchema,
  type SubmitTransactionBody,
  submitTransactionBodySchema,
  transactionIdParamSchema,
} from './wagering.dto';
import {
  httpStatusForResult,
  type SubmitTransactionResponse,
  type TransactionResponse,
  toSubmitTransactionResponse,
  toTransactionResponse,
} from './wagering.response';

/** O suficiente da resposta HTTP para trocar o status (sem depender dos tipos do Express). */
interface StatusSettable {
  status(code: number): unknown;
}

function found(tx: WagerTransaction | undefined): TransactionResponse {
  if (tx === undefined) {
    throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');
  }
  return toTransactionResponse(tx);
}

/**
 * Endpoints de transação (DESAFIO.md §9). O resultado de negócio — inclusive `REJECTED` e
 * `PENDING_REFERENCE` — não é exceção: volta com o corpo de transação e o status de §6. Erros (payload,
 * conflito, wallet inexistente, falha transitória) saem pelo filtro global no formato uniforme.
 */
@Controller()
@UseGuards(NoopProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWagerTransaction: ProcessWagerTransaction,
    @Inject(GetWagerTransaction) private readonly getWagerTransaction: GetWagerTransaction,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body(new ZodValidationPipe(submitTransactionBodySchema)) body: SubmitTransactionBody,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: StatusSettable,
  ): Promise<SubmitTransactionResponse> {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    const result = await this.processWagerTransaction.execute(
      { ...body, idempotencyKey },
      { source: 'http', correlationId },
    );
    response.status(httpStatusForResult(result));
    return toSubmitTransactionResponse(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(
    @Param('transactionId', new ZodValidationPipe(transactionIdParamSchema)) transactionId: string,
  ): Promise<TransactionResponse> {
    return found(await this.getWagerTransaction.byId(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId', new ZodValidationPipe(providerIdParamSchema)) providerId: string,
    @Param('externalTransactionId', new ZodValidationPipe(externalTransactionIdParamSchema))
    externalTransactionId: string,
  ): Promise<TransactionResponse> {
    return found(await this.getWagerTransaction.byProviderExternalId(providerId, externalTransactionId));
  }
}
