# Configuration

Environment variables. The service refuses to start on an invalid value and names it.

## Required

| Variable                | Example                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `AMQP_URL`              | `amqp://twake-webhook-gateway:…@rabbitmq:5672`                           |
| `PUBLISHERS`            | `{"tasks":{"source":"twake://tasks"}}`                                   |
| `DATABASE_URL`          | `postgres://twake_webhook_gateway:…@postgres/twake_webhook_gateway`      |
| `OIDC_ISSUER`           | `https://sso.example.com/`                                               |
| `OIDC_CLIENT_ID`        | `twake-webhook-gateway`                                                  |
| `OIDC_CLIENT_SECRET`    |                                                                          |
| `ALLOWED_URL_PREFIXES`  | `https://n8n.example.com/webhook/ https://n8n.example.com/webhook-test/` |
| `SECRET_ENCRYPTION_KEY` | 32 random bytes in base64: `openssl rand -base64 32`                     |

- `PUBLISHERS` lists the apps whose events are forwarded, and the `source` each publishes with. The AMQP `user-id` is not checked yet, so an app is trusted on its source alone, and a broker `user` is refused.
- A prefix in `ALLOWED_URL_PREFIXES` is `https`, a host and a path ending with `/`, separated by spaces or commas. The host and port compare exactly, the path as a prefix.
- `SECRET_ENCRYPTION_KEY` encrypts the subscription secrets. Losing it makes every subscription undeliverable.

## Optional

| Variable                     | Default                 | Meaning                                                                                   |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `AMQP_EXCHANGE`              | `activity`              | The exchange of the events                                                                |
| `AMQP_QUEUE`                 | `twake-webhook-gateway` | The quorum queue every replica consumes                                                   |
| `AMQP_DEAD_LETTER_EXCHANGE`  | `<queue>.dlx`           | Routes refused events to `<queue>.dlq`                                                    |
| `AMQP_PREFETCH`              | `20`                    | Messages held per replica                                                                 |
| `AMQP_DELIVERY_LIMIT`        | `20`                    | Redeliveries before the dead letter queue                                                 |
| `AUTH_EXCHANGE`              | unset                   | Usually `auth`: B2C deletions end subscriptions                                           |
| `B2B_EXCHANGE`               | unset                   | Usually `b2b`: member and organization deletions, disabled members                        |
| `DATABASE_MIGRATION_URL`     | `DATABASE_URL`          | The role that owns the tables and migrates                                                |
| `MIGRATE_ON_START`           | `true`                  |                                                                                           |
| `DATABASE_POOL_MAX`          | `10`                    |                                                                                           |
| `OIDC_AUDIENCE`              | `OIDC_CLIENT_ID`        | The audience a token must carry                                                           |
| `ALLOWED_PRIVATE_NETWORKS`   | none                    | Private addresses a delivery may reach, such as `172.27.0.100/32` for an internal ingress |
| `MAX_SUBSCRIPTIONS_PER_USER` | `100`                   |                                                                                           |
| `DELIVERY_TIMEOUT_MS`        | `10000`                 |                                                                                           |
| `DELIVERY_CONCURRENCY`       | `10`                    | Deliveries in flight per replica                                                          |
| `DELIVERY_POLL_MS`           | `1000`                  | How often an idle worker looks for due deliveries                                         |
| `DELIVERY_MAX_AGE_HOURS`     | `24`                    | Then a failing delivery is dropped                                                        |
| `SUBSCRIPTION_FAILURE_DAYS`  | `7`                     | Then a failing subscription ends                                                          |
| `HTTP_HOST`                  | `0.0.0.0`               |                                                                                           |
| `HTTP_PORT`                  | `8080`                  | API and probes                                                                            |
| `METRICS_PORT`               | `9464`                  | `/metrics`                                                                                |
| `LOG_LEVEL`                  | `info`                  |                                                                                           |
| `SENTRY_DSN`                 | unset                   |                                                                                           |

## SSO

- The gateway has its own confidential client, used to introspect tokens only.
- The SSO adds the gateway's client id to the audiences of the tokens of each consumer, such as the `n8n` client.
- The consumer's userinfo must carry `uuid` and, for a member of an organization, `org_id`.

## Database

Create two roles: one owns the database and migrates, the other serves and owns nothing.

```sql
create role twake_webhook_gateway_owner login password '…';
create role twake_webhook_gateway login password '…';
create database twake_webhook_gateway owner twake_webhook_gateway_owner;
```

Each start migrates as the owner and grants the serving role what it needs. The service refuses a serving role that is a superuser or has `BYPASSRLS`, and warns when it owns tables.
