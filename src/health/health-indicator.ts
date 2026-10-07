/** Lista de indicadores consultados pelo `/health/ready`. */
export const HEALTH_INDICATORS = Symbol('HEALTH_INDICATORS');

export interface HealthIndicator {
  /** Nome exibido no relatório (`postgres`, `sqs`). */
  readonly name: string;
  /** Resolve se a dependência está alcançável; rejeita caso contrário. Deve respeitar o `signal`. */
  check(signal: AbortSignal): Promise<void>;
}
