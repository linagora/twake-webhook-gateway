-- Work that spans tenants, run as the owner of the tables, whom their row
-- level security does not bind. Each function does one narrow thing.

-- Leases the deliveries that are due, oldest first, so that no other replica
-- takes them before the lease ends. A replica that dies mid-delivery leaves
-- the delivery to be taken again once its lease ends.
CREATE FUNCTION claim_deliveries(lease_seconds integer, max_rows integer)
RETURNS TABLE (id uuid, tenant text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE deliveries d
  SET due_at = now() + make_interval(secs => lease_seconds)
  FROM (
    SELECT deliveries.id FROM deliveries
    WHERE deliveries.due_at <= now()
    ORDER BY deliveries.due_at
    LIMIT max_rows
    FOR UPDATE SKIP LOCKED
  ) due
  WHERE d.id = due.id
  RETURNING d.id, d.tenant
$$;
--> statement-breakpoint
-- Ends the subscriptions whose deliveries have failed for that many days.
CREATE FUNCTION expire_failing_subscriptions(failure_days integer)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH expired AS (
    DELETE FROM subscriptions
    WHERE failing_since < now() - make_interval(days => failure_days)
    RETURNING 1
  )
  SELECT count(*)::integer FROM expired
$$;
--> statement-breakpoint
-- Ends every subscription of a deleted person, whatever their organization.
-- A data-modifying CTE runs even when nothing reads it.
CREATE FUNCTION forget_owner(deleted uuid)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH gone AS (
    DELETE FROM subscriptions WHERE owner = deleted RETURNING 1
  ), members AS (
    DELETE FROM disabled_members WHERE owner = deleted RETURNING 1
  )
  SELECT count(*)::integer FROM gone
$$;
--> statement-breakpoint
-- Drops the dedupe rows older than the window.
CREATE FUNCTION forget_seen_events(window_hours integer)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH old AS (
    DELETE FROM seen_events
    WHERE seen_at < now() - make_interval(hours => window_hours)
    RETURNING 1
  )
  SELECT count(*)::integer FROM old
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_deliveries(integer, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION expire_failing_subscriptions(integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION forget_owner(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION forget_seen_events(integer) FROM PUBLIC;
