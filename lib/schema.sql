-- The pack-wide stats store. Applied with executescript() on every open, so every statement
-- must be idempotent — this doubles as the migration path for a db that already exists.
--
-- Four tables, one question each:
--   runs      what happened, once per invocation or outcome
--   findings  what was found, and whether triage judged it real — the only place precision lives
--   items     what each workflow agent was asked and answered, with its real cost
--   meta      schema_version, so a later ALTER knows what it is looking at

CREATE TABLE IF NOT EXISTS runs (
  run_id         TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  repo           TEXT,
  skill          TEXT,
  -- 'invoke' (the hook saw a skill start) or 'result' (a skill reported an outcome). Runs are
  -- COUNTED from invoke rows only: one run produces both, and counting both doubles everything.
  event          TEXT NOT NULL DEFAULT 'result',
  via            TEXT,
  origin         TEXT NOT NULL DEFAULT 'live',
  session_id     TEXT,
  kind           TEXT,
  profile        TEXT,
  profile_forced INTEGER,
  invoked_by     TEXT,
  commit_sha     TEXT,
  files_changed  INTEGER,
  lines_added    INTEGER,
  lines_removed  INTEGER,
  -- The caller's JSON, verbatim. A field a skill invents survives with no column for it, and
  -- json_extract() keeps it queryable — so adding a column later never has to rewrite history.
  payload        TEXT
);

CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(run_id),
  track       TEXT,
  category    TEXT,
  severity    TEXT,
  file        TEXT,
  line        INTEGER,
  -- 'confirmed' | 'dismissed' | 'unresolved'. The point of the whole table: a track that finds ten
  -- real things triage rejects scores the same as one that finds nothing until this is recorded.
  verdict     TEXT,
  fixed       INTEGER,
  description TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT,
  wf_run_id       TEXT,
  agent_id        TEXT UNIQUE,
  agent_type      TEXT,
  label           TEXT,
  model           TEXT,
  effort          TEXT,
  prompt_chars    INTEGER,
  prompt_sha      TEXT,
  prompt          TEXT,
  result          TEXT,
  result_chars    INTEGER,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  tokens_cache    INTEGER,
  started_at      TEXT,
  ended_at        TEXT,
  duration_ms     INTEGER,
  -- prompt/result are capped; this is where the untruncated text still lives.
  transcript_path TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS runs_skill_ts  ON runs(skill, ts);
CREATE INDEX IF NOT EXISTS runs_session   ON runs(session_id);
CREATE INDEX IF NOT EXISTS findings_run   ON findings(run_id);
CREATE INDEX IF NOT EXISTS findings_track ON findings(track, verdict);
CREATE INDEX IF NOT EXISTS items_run      ON items(run_id);

INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
