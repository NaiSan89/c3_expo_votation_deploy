import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function rankResults(games, rows) {
  const counts = new Map(rows.map(row => [row.game, row.votes]));
  return games.map(game => ({ game, votes: counts.get(game) || 0 })).sort((a, b) => b.votes - a.votes);
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
  db.exec(`CREATE TEMP TABLE voter_sessions(token_hash TEXT PRIMARY KEY, voter_hash TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX temp.sessions_expiry ON voter_sessions(expires);
    CREATE TEMP TABLE request_limits(ip_hash TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX temp.limits_expiry ON request_limits(expires);`);
  let nextSync = 0;
  let syncOwner = null;
  let lastError = null;
  let lastSuccess = null;
  return {
    hasVoted(hash) { return Boolean(db.prepare('SELECT id FROM votes WHERE voter_hash = ?').get(hash)); },
    insert(hash, game) {
      const result = db.prepare('INSERT OR IGNORE INTO votes (voter_hash, game, created_at) VALUES (?, ?, ?)').run(hash, game, new Date().toISOString());
      return result.changes === 1;
    },
    results(games) {
      return rankResults(games, db.prepare('SELECT game, COUNT(*) AS votes FROM votes GROUP BY game').all());
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
