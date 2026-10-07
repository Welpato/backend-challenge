import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Registry } from 'prom-client';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(Registry) private readonly registry: Registry) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): Promise<string> {
    return this.registry.metrics();
  }
}
