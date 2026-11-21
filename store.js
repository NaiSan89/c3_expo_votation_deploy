import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function rankResults(games, rows) {
  const counts = new Map(rows.map(row => [row.game, row.votes]));
  const results = games.map(game => ({ game, votes: counts.get(game) || 0 })).sort((a, b) => b.votes - a.votes);
  const count = rows.reduce((n, row) => n + row.votes, 0);
  const last = rows.reduce((id, row) => Math.max(id, row.last_id), 0);
  return { results, revision: `${count}:${last}` };
}

export function openStore(path) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY, voter_hash TEXT NOT NULL UNIQUE,
      game TEXT NOT NULL, created_at TEXT NOT NULL, google_synced_at TEXT
    )`);
  // Compatibilidade com a primeira versão do projeto.
  if (!db.prepare('PRAGMA table_info(votes)').all().some(column => column.name === 'google_synced_at')) {
    db.exec('ALTER TABLE votes ADD COLUMN google_synced_at TEXT');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS vote_id_floor (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), next_id INTEGER NOT NULL);
    CREATE TEMP TABLE voter_sessions(token_hash TEXT PRIMARY KEY, voter_hash TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX temp.sessions_expiry ON voter_sessions(expires);
    CREATE TEMP TABLE request_limits(ip_hash TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX temp.limits_expiry ON request_limits(expires);`);
  let nextSync = 0;
  let syncOwner = null;
  let lastError = null;
  let lastSuccess = null;
  return {
    hasVoted(hash) { return Boolean(db.prepare('SELECT id FROM votes WHERE voter_hash = ?').get(hash)); },
    insert(hash, game, sessionHash) {
      if (sessionHash && !this.validSession(sessionHash, hash)) return null;
      const result = db.prepare(`INSERT OR IGNORE INTO votes (id, voter_hash, game, created_at)
        SELECT COALESCE((SELECT MAX(id) + 1 FROM votes), (SELECT next_id FROM vote_id_floor), 1), ?, ?, ?`)
        .run(hash, game, new Date().toISOString());
      return result.changes === 1;
    },
    results(games) {
      return rankResults(games, db.prepare('SELECT game, COUNT(*) AS votes, MAX(id) AS last_id FROM votes GROUP BY game').all());
    },
    resetVotes(revision) {
      if (syncOwner !== null) return 'syncing';
      db.exec('BEGIN IMMEDIATE');
      try {
        const { count, last } = db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS last FROM votes').get();
        if (revision !== `${count}:${last}`) { db.exec('ROLLBACK'); return 'changed'; }
        // Uma linha já exportada para o Sheets pertence sempre ao mesmo voto.
        db.prepare(`INSERT INTO vote_id_floor VALUES (1, ?)
          ON CONFLICT(singleton) DO UPDATE SET next_id = MAX(next_id, excluded.next_id)`).run(last + 1);
        db.exec('DELETE FROM votes; DELETE FROM voter_sessions; DELETE FROM request_limits; COMMIT');
        lastError = lastSuccess = null;
        nextSync = 0;
        return 'reset';
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    },
    createSession(tokenHash, voterHash) {
      const now = Date.now();
      db.prepare('DELETE FROM voter_sessions WHERE expires <= ?').run(now);
      return db.prepare('INSERT INTO voter_sessions SELECT ?, ?, ? WHERE (SELECT count(*) FROM voter_sessions) < 10000')
        .run(tokenHash, voterHash, now + 300000).changes === 1;
    },
    validSession(tokenHash, voterHash) {
      return Boolean(db.prepare('SELECT 1 FROM voter_sessions WHERE token_hash = ? AND voter_hash = ? AND expires > ?')
        .get(tokenHash, voterHash, Date.now()));
    },
    countRequest(ipHash) {
      const now = Date.now();
      db.prepare('DELETE FROM request_limits WHERE expires <= ?').run(now);
      const row = db.prepare(`INSERT INTO request_limits SELECT ?, 1, ?
        WHERE EXISTS (SELECT 1 FROM request_limits WHERE ip_hash = ?) OR (SELECT count(*) FROM request_limits) < 20000
        ON CONFLICT(ip_hash) DO UPDATE SET hits = hits + 1 RETURNING hits`).get(ipHash, now + 60000, ipHash);
      return row?.hits ?? null;
    },
    pending(limit = 20) { return db.prepare('SELECT id, game, created_at FROM votes WHERE google_synced_at IS NULL ORDER BY id LIMIT ?').all(limit); },
    markSynced(ids) {
      db.prepare('UPDATE votes SET google_synced_at = ? WHERE id IN (SELECT value FROM json_each(?))').run(new Date().toISOString(), JSON.stringify(ids));
    },
    claimSync(owner) {
      if (Date.now() < nextSync) return false;
      syncOwner = owner;
      nextSync = Date.now() + 90000;
      return true;
    },
    finishSync(owner, error, cooldownMs) {
      if (owner !== syncOwner) return;
      syncOwner = null;
      nextSync = Date.now() + cooldownMs;
      lastError = error;
      if (!error) lastSuccess = new Date().toISOString();
    },
    syncStatus() { return { pending: this.pendingCount(), lastError, lastSuccess }; },
    pendingCount() { return db.prepare('SELECT COUNT(*) AS count FROM votes WHERE google_synced_at IS NULL').get().count; },
    close() { db.close(); }
  };
}
