-- 001_core: projects, api keys, admin user, sessions, segments, saved views,
-- and ingest counters. Identity and deletion tables are added by Plans 2 and 4.

CREATE TABLE IF NOT EXISTS projects (
  id                  bigserial PRIMARY KEY,
  name                text        NOT NULL,
  slug                text        NOT NULL UNIQUE,
  write_key           text        NOT NULL UNIQUE,
  server_key_hash     text        NOT NULL,
  retention_months    integer     NOT NULL DEFAULT 24
                        CONSTRAINT projects_retention_months_range CHECK (retention_months BETWEEN 1 AND 120),
  monthly_event_quota bigint      NOT NULL DEFAULT 50000000
                        CONSTRAINT projects_quota_positive CHECK (monthly_event_quota > 0),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           bigserial PRIMARY KEY,
  project_id   bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  key_hash     text        NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE IF NOT EXISTS admin_user (
  id            bigserial PRIMARY KEY,
  email         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id            text        PRIMARY KEY,
  admin_user_id bigint      NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS segments (
  id          bigserial PRIMARY KEY,
  project_id  bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  filter_tree jsonb       NOT NULL,
  ast_version integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS saved_views (
  id         bigserial PRIMARY KEY,
  project_id bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  config     jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS ingest_counters (
  project_id       bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  month            date   NOT NULL,
  events_accepted  bigint NOT NULL DEFAULT 0,
  events_rejected  bigint NOT NULL DEFAULT 0,
  events_throttled bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, month)
);
