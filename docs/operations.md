# Operations

## Probes

- `GET /health/ready` on `HTTP_PORT`: 200 once the queue is consumed and Postgres answers.
- `GET /health/live`: 503 when the broker has been unreachable for a minute, the subscription to the queue is lost, a message has been in its handler for 5 minutes, or the delivery worker has not run for 5 minutes.

## Metrics

On `METRICS_PORT`, `/metrics`:

| Metric                                            | Labels                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `twake_webhook_gateway_events_total`              | `outcome`: `queued`, `unmatched`, `duplicate`, `ignored`, `applied`, `skipped`, `dead_lettered`, `failed` |
| `twake_webhook_gateway_deliveries_total`          | `result`: `delivered`, `failed`, `expired`, `gone`, `refused_url`, `skipped`                              |
| `twake_webhook_gateway_subscriptions_ended_total` | `reason`: `gone` (the URL answered 410), `failing` (7 days of failures)                                   |

`expired` counts the deliveries dropped after 24 hours of failures: their events are lost for that subscriber.

## Logs

pino JSON on stdout. Each message read from the bus gives one line: `event handled` with its `outcome` (`queued`, `unmatched`, `duplicate`, `ignored`, or `applied` and `skipped` for an account event), `dead lettered a rejected event` with its `reason`, or `event failed, retried`. A line carries the exchange, the routing key and the message id, and of the event only its `source`, `id`, `twakeorg`, `twakeactorid`, or the `organizationId` and `uuid` of an account event: never its content, an email or the people it lists.

## Dead letter queue

A malformed event, or one refused because its app did not publish it, goes to `twake-webhook-gateway.dlq`. Once the cause is fixed, move it back to its exchange with its routing key. For a message moved straight to the queue, which comes through the default exchange, the gateway reads the original exchange from `x-first-death-exchange`: only operators should be allowed to publish to the default exchange.

## Scaling

Every replica consumes the queue and runs a delivery worker. A delivery is leased for 2 minutes, so a replica that dies mid-delivery leaves it to another one, and a deploy loses no retry. Each replica sweeps the old dedupe rows and the failing subscriptions once a minute.
