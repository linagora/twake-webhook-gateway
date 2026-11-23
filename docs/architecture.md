# Architecture

## An event, from the bus to a subscriber

1. An app publishes a CloudEvent on the `activity` exchange ([ADR 067](https://github.com/linagora/twake-adr)). The gateway's quorum queue, `twake-webhook-gateway`, is bound to `#`, and every replica consumes it.
2. The gateway reads the app from the type, `com.twake.<app>.…`. An app missing from `PUBLISHERS` is ignored. An event whose `source` is not that app's is refused. A refused or malformed event goes to the dead letter queue.
3. The audience of the event is its actor (`twakeactorid`) and the `uuid` of each of `data.recipients`. Emails are never read.
4. In one transaction, in the tenant of the event (`twakeorg`, or B2C without one), the gateway finds the subscriptions of that audience to that type, whose owner is not a disabled member. It writes the dedupe row `(source, id)`, then one delivery per subscription. A redelivered event finds its dedupe row and stops there.
5. The delivery worker of each replica leases due deliveries, decrypts the subscription's secret, signs the body and POSTs it. A `2xx` deletes the delivery. A `410` ends the subscription. Anything else is retried, after 30 seconds and then twice as long each time, up to an hour, for 24 hours.

A delivery carries the event's `id`, `type`, `source`, `time`, `twakeorg` and `twakeactorid`, and the ids of its object, of what the object points to (such as a task's board) and of its container. Never a title, a name or an email: the subscriber reads the object with its own token. See [API](api.md#deliveries).

## Tables

| Table              | Holds                                                                                | Row level security             |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------------------ |
| `subscriptions`    | Owner `uuid`, organization, client (`azp`), URL, types, the encrypted secret, health | Tenant, and owner on a request |
| `deliveries`       | One row per event and subscription: the body to sign, attempts, the next attempt     | Tenant                         |
| `disabled_members` | The members of an organization whose subscriptions are paused                        | Tenant                         |
| `seen_events`      | `(source, id)` of the events queued in the last 24 hours                             | None: it holds no content      |

The tenant is `org:<id>` or `b2c`, from `app.tenant`, which every transaction sets. A session that forgets it reads nothing. A request also sets `app.user_id`, so a person only reaches their own subscriptions.

The service connects as a role that owns no table, so row level security binds it. The tables are owned by the role of `DATABASE_MIGRATION_URL`, which migrates at start. Work that spans tenants goes through four `SECURITY DEFINER` functions, owned by that role:

- `claim_deliveries(lease_seconds, max_rows)`: leases the due deliveries of every tenant, so that no other replica takes them before the lease ends.
- `expire_failing_subscriptions(failure_days)`: ends the subscriptions whose deliveries failed for that many days.
- `forget_owner(uuid)`: ends every subscription of a deleted person.
- `forget_seen_events(window_hours)`: drops the old dedupe rows.

## Accounts

The gateway binds, and never forwards:

- `user.deleted` on `auth` and `domain.user.deleted` on `b2b`: the person's subscriptions end. A replayed deletion without `uuid` is skipped.
- `domain.organization.deleted` on `b2b`: the organization's subscriptions end.
- `b2b.member.disabled` and `b2b.member.enabled` on `b2b`: while a member is disabled, their pending deliveries are dropped and no event is queued for them.

## Outbound calls

- Only `https`, to a URL under one of `ALLOWED_URL_PREFIXES`, checked at subscription and again at each delivery.
- No redirect is followed.
- Every address the host resolves to is checked before connecting, and the connection goes to a checked address. A private, loopback or link-local address is refused unless it is in `ALLOWED_PRIVATE_NETWORKS`.

## Logs

The logs carry no email, token, secret, URL or event content: an event is named by its routing key and message id, a delivery by its id.
