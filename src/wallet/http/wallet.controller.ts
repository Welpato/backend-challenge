import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { NoopProviderAuthGuard } from '@/auth/noop-provider-auth.guard';
import { CorrelationId } from '@/shared/http/correlation-id.decorator';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';
import { CreateWallet } from '@/wallet/application/create-wallet';
import { GetLedger } from '@/wallet/application/get-ledger';
import { GetWallet } from '@/wallet/application/get-wallet';
import { ReconcileWallet } from '@/wallet/application/reconcile-wallet';
import {
  type CreateWalletBody,
  createWalletBodySchema,
  type LedgerQuery,
  ledgerQuerySchema,
  walletIdParamSchema,
} from './wallet.dto';
import {
  type LedgerPageResponse,
  type ReconciliationResponse,
  toLedgerPageResponse,
  toReconciliationResponse,
  toWalletResponse,
  type WalletResponse,
} from './wallet.response';

const walletIdPipe = new ZodValidationPipe(walletIdParamSchema);

/** Endpoints de wallet (DESAFIO.md §9). Erros saem pelo filtro global (`ApiExceptionFilter`). */
@Controller('wallets')
@UseGuards(NoopProviderAuthGuard)
export class WalletController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(GetLedger) private readonly getLedger: GetLedger,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createWalletBodySchema)) body: CreateWalletBody,
    @CorrelationId() correlationId: string,
  ): Promise<WalletResponse> {
    const wallet = await this.createWallet.execute({ ...body, correlationId });
    return toWalletResponse(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId', walletIdPipe) walletId: string): Promise<WalletResponse> {
    return toWalletResponse(await this.getWallet.execute(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', walletIdPipe) walletId: string,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQuery,
  ): Promise<LedgerPageResponse> {
    return toLedgerPageResponse(await this.getLedger.execute({ walletId, ...query }));
  }

  /** POST porque é uma verificação sob demanda (pode logar e contar divergência), mas nunca altera a wallet. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId', walletIdPipe) walletId: string): Promise<ReconciliationResponse> {
    return toReconciliationResponse(await this.reconcileWallet.execute(walletId));
  }
}
