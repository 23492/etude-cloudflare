-- Etude sync server (self-hosted etude-cloud subset) on Cloudflare D1.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Long sign-in tokens the admin hands out (one per person). Only the SHA-256 is stored.
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS invites_email ON invites(email);

-- Device tokens issued at sign-in. Only the SHA-256 is stored.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen TEXT
);
CREATE INDEX IF NOT EXISTS devices_account ON devices(account_id);

CREATE TABLE IF NOT EXISTS vaults (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  keys_json TEXT,
  keys_etag INTEGER NOT NULL DEFAULT 0,
  server_vk TEXT,
  snapshot_json TEXT,
  snapshot_etag INTEGER NOT NULL DEFAULT 0
);

-- Append-only encrypted event log. seq is global and monotonic; cursors are per account by filtering.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  device TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (account_id, id)
);
CREATE INDEX IF NOT EXISTS events_account_seq ON events(account_id, seq);

-- Encrypted blobs live in R2 under <account>/<sha256>; this table tracks them for usage and snapshot checks.
CREATE TABLE IF NOT EXISTS blobs (
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (account_id, name)
);

-- Fallback blob storage when no R2 binding is configured: 1 MiB chunks.
CREATE TABLE IF NOT EXISTS blob_chunks (
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  n INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (account_id, name, n)
);

-- One-time sign-in links: from Cloudflare Access (60 s) or admin magic links (hours). Only the SHA-256 is stored.
CREATE TABLE IF NOT EXISTS link_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS link_tokens_expires ON link_tokens(expires_at);

-- Accounts that may not sign in, whatever the route.
CREATE TABLE IF NOT EXISTS blocked (
  email TEXT PRIMARY KEY
);

-- AI proxy usage per person per day (for the daily cap).
CREATE TABLE IF NOT EXISTS ai_usage (
  email TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, day)
);
