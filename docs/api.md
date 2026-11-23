# API

Every route takes the user's SSO access token, `Authorization: Bearer <token>`. The gateway introspects it with its own client: the token must be active and carry the gateway's audience (`OIDC_AUDIENCE`). The person is the `uuid` of userinfo, their organization its `org_id`, and the client the `azp` (or `client_id`) of the token.

A client only sees the subscriptions it created: a second consumer cannot list or delete what n8n created.

## Subscriptions

### `POST /subscriptions`

```json
{
  "url": "https://n8n.example.com/webhook/0f1c…/webhook",
  "types": [
    "com.twake.tasks.task.created.v1",
    "com.twake.tasks.task.assigned.v1"
  ]
}
```

`201`, with the secret, shown this once:

```json
{
  "id": "01a207db-6bd0-7c03-b14d-f097c7baa18d",
  "url": "https://n8n.example.com/webhook/0f1c…/webhook",
  "types": [
    "com.twake.tasks.task.created.v1",
    "com.twake.tasks.task.assigned.v1"
  ],
  "owner": "6208ad54-5683-1041-8c8f-c9e6dccfd4ac",
  "createdAt": "2026-11-23T10:02:30.207Z",
  "lastSuccessAt": null,
  "secret": "whsec_…"
}
```

| Status | `error`                  | When                                                       |
| ------ | ------------------------ | ---------------------------------------------------------- |
| 400    | `invalid_request`        | No URL, or no type, more than 50, or not a CloudEvent type |
| 400    | `invalid_url`            | Not a URL                                                  |
| 400    | `https_only`             | Not `https`                                                |
| 400    | `user_info`              | A user or password in the URL                              |
| 400    | `not_allowed`            | Under none of the allowed prefixes                         |
| 409    | `too_many_subscriptions` | The person already has `MAX_SUBSCRIPTIONS_PER_USER`        |

`owner` is the uuid of the person the token belongs to: it tells a subscriber which events are about them, such as an assignment to them.

A subscription is active at once, and does not expire. It ends when its owner deletes it, its URL answers `410`, its deliveries have failed for 7 days, or its owner or their organization is deleted.

### `GET /subscriptions`

`{ "subscriptions": [ … ] }`: the caller's, created by the calling client, newest first, without secrets.

### `GET /subscriptions/:id` and `DELETE /subscriptions/:id`

`200` with the subscription, or `204` once deleted. `404` when it is not the caller's, or not created by the calling client.

## Deliveries

`POST` to the subscription's URL:

```http
Content-Type: application/json
User-Agent: twake-webhook-gateway
Twake-Signature: t=1795428155,v1=78b4d908…
Twake-Event-Id: 01a207df-092d-7724-9ee1-2ddaaa9702bb
Twake-Delivery-Id: 01a207df-0930-7aaa-8c1e-5d0b6a3f2e10
```

```json
{
  "specversion": "1.0",
  "id": "01a207df-092d-7724-9ee1-2ddaaa9702bb",
  "type": "com.twake.tasks.task.created.v1",
  "source": "twake://tasks",
  "time": "2026-11-23T10:06:27.108019Z",
  "twakeorg": "twake-demo",
  "twakeactorid": "6208ad54-5683-1041-8c8f-c9e6dccfd4ac",
  "data": {
    "object": {
      "type": "task",
      "id": "01a207df-0928-…",
      "board": { "id": "01a11607-fec3-…" }
    },
    "container": { "kind": "project", "id": "01a11607-fec1-…" }
  }
}
```

The object keeps the `id`, `kind` and `type` of each object it points to, never their other fields. So does `data` for the other things the event is about, such as `assignee` in `com.twake.tasks.task.assigned.v1`: `"assignee": { "id": "<uuid>" }`. The `recipients` and the other fields of `data`, such as `changes`, are left out.

### Checking a delivery

1. Read `t` and `v1` from `Twake-Signature`.
2. Refuse a `t` more than 300 seconds away from now. Each retry is signed again, so a retry passes.
3. Compute the HMAC-SHA256 of `<t>.<raw body>` with the secret, in hex, and compare it to `v1` in constant time.
4. Deduplicate on the event `id`: delivery is at least once and unordered.

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function isSigned(secret, header, rawBody, now = Date.now() / 1000) {
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '') ?? []
  if (!t || Math.abs(now - Number(t)) > 300) return false
  const expected = createHmac('sha256', secret)
    .update(`${t}.`)
    .update(rawBody)
    .digest()
  return timingSafeEqual(expected, Buffer.from(v1, 'hex'))
}
```

Answer `2xx` once the delivery is taken, `410` to end the subscription. Anything else is retried for 24 hours.
