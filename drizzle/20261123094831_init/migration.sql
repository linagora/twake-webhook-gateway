CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"subscription_id" uuid NOT NULL,
	"org_id" text,
	"tenant" text GENERATED ALWAYS AS (case when org_id is null then 'b2c' else 'org:' || org_id end) STORED NOT NULL,
	"owner" uuid NOT NULL,
	"event_id" text NOT NULL,
	"body" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "disabled_members" (
	"org_id" text,
	"tenant" text GENERATED ALWAYS AS (case when org_id is null then 'b2c' else 'org:' || org_id end) STORED NOT NULL,
	"owner" uuid,
	"disabled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "disabled_members_pkey" PRIMARY KEY("org_id","owner")
);
--> statement-breakpoint
ALTER TABLE "disabled_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "seen_events" (
	"source" text,
	"id" text,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seen_events_pkey" PRIMARY KEY("source","id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"org_id" text,
	"tenant" text GENERATED ALWAYS AS (case when org_id is null then 'b2c' else 'org:' || org_id end) STORED NOT NULL,
	"owner" uuid NOT NULL,
	"client_id" text NOT NULL,
	"url" text NOT NULL,
	"types" text[] NOT NULL,
	"secret" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"failing_since" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "deliveries_due" ON "deliveries" ("due_at");--> statement-breakpoint
CREATE INDEX "deliveries_subscription" ON "deliveries" ("subscription_id");--> statement-breakpoint
CREATE INDEX "seen_events_seen_at" ON "seen_events" ("seen_at");--> statement-breakpoint
CREATE INDEX "subscriptions_match" ON "subscriptions" ("tenant","owner");--> statement-breakpoint
CREATE INDEX "subscriptions_types" ON "subscriptions" USING gin ("types");--> statement-breakpoint
CREATE INDEX "subscriptions_owner" ON "subscriptions" ("owner");--> statement-breakpoint
CREATE INDEX "subscriptions_failing" ON "subscriptions" ("failing_since") WHERE failing_since is not null;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_subscription_id_subscriptions_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "tenant" ON "deliveries" AS PERMISSIVE FOR ALL TO public USING ("deliveries"."tenant" = current_setting('app.tenant', true)) WITH CHECK ("deliveries"."tenant" = current_setting('app.tenant', true));--> statement-breakpoint
CREATE POLICY "tenant" ON "disabled_members" AS PERMISSIVE FOR ALL TO public USING ("disabled_members"."tenant" = current_setting('app.tenant', true)) WITH CHECK ("disabled_members"."tenant" = current_setting('app.tenant', true));--> statement-breakpoint
CREATE POLICY "tenant" ON "subscriptions" AS PERMISSIVE FOR ALL TO public USING ("subscriptions"."tenant" = current_setting('app.tenant', true)) WITH CHECK ("subscriptions"."tenant" = current_setting('app.tenant', true));--> statement-breakpoint
CREATE POLICY "own" ON "subscriptions" AS RESTRICTIVE FOR ALL TO public USING (nullif(current_setting('app.user_id', true), '')::uuid is null or "subscriptions"."owner" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.user_id', true), '')::uuid is null or "subscriptions"."owner" = nullif(current_setting('app.user_id', true), '')::uuid);