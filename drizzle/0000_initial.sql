CREATE TABLE "agent_connections" (
	"agent_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"takeover" boolean NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "agent_connections_agent_id_connection_id_pk" PRIMARY KEY("agent_id","connection_id"),
	CONSTRAINT "agent_connections_lease_id_unique" UNIQUE("lease_id")
);
--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_message_receipts" (
	"session_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"client_message_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"sender_agent_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_message_receipts_session_id_participant_id_client_message_id_pk" PRIMARY KEY("session_id","participant_id","client_message_id"),
	CONSTRAINT "agent_message_receipts_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "agent_operations" (
	"agent_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"session_id" uuid NOT NULL,
	CONSTRAINT "agent_operations_agent_id_idempotency_key_pk" PRIMARY KEY("agent_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "agent_peer_policies" (
	"agent_id" uuid NOT NULL,
	"peer_agent_id" uuid NOT NULL,
	"allow_inbound" boolean DEFAULT false NOT NULL,
	"allow_outbound" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_peer_policies_agent_id_peer_agent_id_pk" PRIMARY KEY("agent_id","peer_agent_id"),
	CONSTRAINT "agent_peer_policies_distinct_agents" CHECK ("agent_peer_policies"."agent_id" <> "agent_peer_policies"."peer_agent_id")
);
--> statement-breakpoint
CREATE TABLE "agent_receivers" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"lease_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"credential_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"accepting_sessions" boolean DEFAULT true NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "agent_receivers_lease_id_unique" UNIQUE("lease_id"),
	CONSTRAINT "agent_receivers_generation_check" CHECK ("agent_receivers"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_session_bindings" (
	"session_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"participant_id" uuid,
	"binding_id" uuid,
	"stopped_at" timestamp with time zone,
	CONSTRAINT "agent_session_bindings_session_id_agent_id_pk" PRIMARY KEY("session_id","agent_id"),
	CONSTRAINT "agent_bindings_generation_check" CHECK ("agent_session_bindings"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"initiator_agent_id" uuid NOT NULL,
	"recipient_agent_id" uuid NOT NULL,
	"state" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"offer_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"limits_json" jsonb NOT NULL,
	"history_purged_at" timestamp with time zone,
	CONSTRAINT "agent_sessions_state_check" CHECK ("agent_sessions"."state" IN ('pending','active','closed','expired')),
	CONSTRAINT "agent_sessions_distinct_agents" CHECK ("agent_sessions"."initiator_agent_id" <> "agent_sessions"."recipient_agent_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "agents_display_name_check" CHECK (char_length("agents"."display_name") BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"max_uses" integer NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_max_uses_check" CHECK ("invites"."max_uses" BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"sender_participant_id" uuid,
	"sender_owner_id" uuid,
	"sequence" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_message_id" uuid,
	CONSTRAINT "messages_one_sender" CHECK ("messages"."sender_participant_id" IS NULL OR "messages"."sender_owner_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "owner_login_attempts" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"browser_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"flow" text DEFAULT 'workos' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "owners_issuer_subject_unique" UNIQUE("issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"credential_hash" text,
	"display_name" text,
	"metadata_json" json DEFAULT '{}'::json NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"agent_id" uuid
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "security_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event" text NOT NULL,
	"session_id" uuid,
	"participant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'WAITING' NOT NULL,
	"owner_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_participants" integer NOT NULL,
	"next_sequence" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sessions_status_check" CHECK ("sessions"."status" IN ('WAITING','ACTIVE','CLOSED')),
	CONSTRAINT "sessions_max_participants_check" CHECK ("sessions"."max_participants" BETWEEN 1 AND 10)
);
--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_credential_id_agent_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_message_receipts" ADD CONSTRAINT "agent_message_receipts_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_message_receipts" ADD CONSTRAINT "agent_message_receipts_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_message_receipts" ADD CONSTRAINT "agent_message_receipts_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_operations" ADD CONSTRAINT "agent_operations_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_peer_policies" ADD CONSTRAINT "agent_peer_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_peer_policies" ADD CONSTRAINT "agent_peer_policies_peer_agent_id_agents_id_fk" FOREIGN KEY ("peer_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_receivers" ADD CONSTRAINT "agent_receivers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_receivers" ADD CONSTRAINT "agent_receivers_credential_id_agent_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_bindings" ADD CONSTRAINT "agent_session_bindings_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_bindings" ADD CONSTRAINT "agent_session_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_bindings" ADD CONSTRAINT "agent_session_bindings_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_id_sessions_id_fk" FOREIGN KEY ("id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_initiator_agent_id_agents_id_fk" FOREIGN KEY ("initiator_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_recipient_agent_id_agents_id_fk" FOREIGN KEY ("recipient_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_participant_id_participants_id_fk" FOREIGN KEY ("sender_participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_owner_id_owners_id_fk" FOREIGN KEY ("sender_owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_connections_ended" ON "agent_connections" USING btree ("ended_at") WHERE "agent_connections"."ended_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_credentials_agent" ON "agent_credentials" USING btree ("agent_id","id");--> statement-breakpoint
CREATE INDEX "agent_peer_policies_peer" ON "agent_peer_policies" USING btree ("peer_agent_id");--> statement-breakpoint
CREATE INDEX "agent_receivers_expiry" ON "agent_receivers" USING btree ("expires_at") WHERE "agent_receivers"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_bindings_receiver" ON "agent_session_bindings" USING btree ("agent_id","lease_id","generation") WHERE "agent_session_bindings"."stopped_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_sessions_policy_pair" ON "agent_sessions" USING btree ("initiator_agent_id","recipient_agent_id","id") WHERE "agent_sessions"."state" IN ('pending','active');--> statement-breakpoint
CREATE INDEX "agent_sessions_terminal" ON "agent_sessions" USING btree ("closed_at") WHERE "agent_sessions"."closed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agents_owner" ON "agents" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX "invites_session" ON "invites" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_session_sequence" ON "messages" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_id" ON "messages" USING btree ("session_id","sender_participant_id","client_message_id") WHERE "messages"."client_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "owner_login_expiry" ON "owner_login_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "participants_session" ON "participants" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_credential" ON "participants" USING btree ("session_id","credential_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_session_agent" ON "participants" USING btree ("session_id","agent_id") WHERE "participants"."agent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "security_events_time" ON "security_events" USING btree ("created_at");