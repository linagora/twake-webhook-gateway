# twake-webhook-gateway

The outbound webhooks of Twake Workplace ([ADR 075](https://github.com/linagora/twake-adr/pull/7)): it consumes the CloudEvents of the `activity` exchange and calls the URLs that users subscribed, such as the triggers of the Twake n8n nodes.

```mermaid
flowchart LR
  apps[Twake apps] -- CloudEvents --> activity((activity))
  activity --> gateway[twake-webhook-gateway]
  n8n[n8n] -- "subscribe, with the user's token" --> gateway
  gateway -- "signed call, ids only" --> n8n
  n8n -- "fetch the object, with the user's token" --> apps
```

```bash
npm install
docker compose up -d   # RabbitMQ and Postgres
npm run dev            # with a .env, see docs/configuration.md
npm run check
```

`npm run check` runs the Postgres tests only when `TEST_DATABASE_URL` holds a superuser URL, as in CI:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

## Documentation

- [Architecture](docs/architecture.md): the flow of an event, the tables and their row level security.
- [API](docs/api.md): the subscription routes, and what a delivery carries and how to check it.
- [Configuration](docs/configuration.md): the environment variables.
- [Operations](docs/operations.md): probes, metrics, the dead letter queue.

## What this first version leaves out

- The AMQP `user-id` check: `@linagora/rabbitmq-client` does not pass the property on yet, and Twake Tasks does not set it. An app is trusted on its `source` alone, the gateway warns about it at start, and refuses a broker `user` in `PUBLISHERS`.
- The operator routes (list, pause and delete by owner, organization or URL prefix) and the screen of a person's subscriptions in twake-sessions.
- The subscription secrets are encrypted with one key from the environment, which OpenBao can inject. There is no key rotation yet.
- No limit on refused tokens per address, as twake-tasks has.
