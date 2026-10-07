import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionFilter } from './api-exception.filter';

/** Registra o filtro global de exceções (corpo de erro uniforme) para todos os papéis. */
@Module({
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class HttpCommonModule {}
