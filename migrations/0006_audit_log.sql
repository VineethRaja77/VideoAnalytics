-- 0006_audit_log.sql
--
-- Append-only audit trail: who did what, to what, when, from where.
--
-- Required for DPDP Act 2023 compliance (the face module processes biometric
-- data, and a Data Fiduciary must be able to show who accessed it), and for the
-- question every client eventually asks: "who watched that footage?"
--
-- Safe to run on an existing install: creates only, drops nothing.

CREATE TABLE IF NOT EXISTS audit_log (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Org the action AFFECTED. NULL only for platform-level super_admin acts.
  organization_id varchar REFERENCES organizations(id),

  -- Actor is denormalised on purpose: NO foreign key to users. If a user is
  -- deleted, the trail of what they did must survive them — a cascade or a
  -- dangling FK would let someone erase their own history by deleting the
  -- account.
  actor_id        varchar,
  actor_username  text,
  actor_role      text,

  action          text NOT NULL,
  target_type     text,
  target_id       varchar,
  target_label    text,           -- captured at the time; a camera may be renamed
  outcome         text NOT NULL DEFAULT 'success',  -- success | denied | error

  -- Scrubbed application-side: never contains passwords, tokens, stream URLs
  -- or face embeddings.
  detail          jsonb,

  ip_address      text,
  user_agent      text,
  created_at      timestamp NOT NULL DEFAULT now()
);

-- The three ways this table is actually read: a client admin reviewing their
-- own org over a time range, an investigation into one user, and a filter by
-- action type ("show me every recording_viewed").
CREATE INDEX IF NOT EXISTS audit_org_time_idx ON audit_log (organization_id, created_at);
CREATE INDEX IF NOT EXISTS audit_actor_idx    ON audit_log (actor_id);
CREATE INDEX IF NOT EXISTS audit_action_idx   ON audit_log (action);
