import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@/config/app-config';
import { type ReadinessReport, ReadinessService } from './readiness.service';

export interface LivenessStatus {
  readonly status: 'ok';
  readonly instanceId: string;
  readonly role: AppConfig['role'];
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness: só o processo — não consulta dependências (evita reinícios em cascata). */
  @Get('live')
  live(): LivenessStatus {
    return { status: 'ok', instanceId: this.config.instanceId, role: this.config.role };
  }

  /** Readiness: PostgreSQL + SQS; 503 com o relatório se algo falhar ou se estiver em shutdown. */
  @Get('ready')
  async ready(): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    if (report.status !== 'ok') {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }
}
