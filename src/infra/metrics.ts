import type { FastifyInstance } from 'fastify'
import type { ConsumerStats } from './amqp.ts'

export type Counter = ReturnType<typeof counter>

export function counter() {
  const values = new Map<string, number>()
  return {
    values,
    add(label: string, by = 1) {
      values.set(label, (values.get(label) ?? 0) + by)
    }
  }
}

function lines(
  name: string,
  help: string,
  label: string,
  values: Map<string, number>
): string[] {
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} counter`,
    ...[...values].map(
      ([value, total]) => `${name}{${label}="${value}"} ${String(total)}`
    )
  ]
}

export function registerMetrics(
  app: FastifyInstance,
  deps: {
    consumer: ConsumerStats
    deliveries: Counter
    subscriptionsExpired: Counter
  }
): void {
  app.get('/metrics', (_request, reply) =>
    reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(
        [
          ...lines(
            'twake_webhook_gateway_events_total',
            'Handler attempts on bus messages, by outcome; a retried message counts once per attempt.',
            'outcome',
            deps.consumer.outcomes
          ),
          ...lines(
            'twake_webhook_gateway_deliveries_total',
            'Delivery attempts, by result.',
            'result',
            deps.deliveries.values
          ),
          ...lines(
            'twake_webhook_gateway_subscriptions_ended_total',
            'Subscriptions ended by the gateway, by reason.',
            'reason',
            deps.subscriptionsExpired.values
          ),
          ''
        ].join('\n')
      )
  )
}
