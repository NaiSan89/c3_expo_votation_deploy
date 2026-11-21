import { Pool } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { rankResults } from './store.js';

export function openPostgres(connectionString) {
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 10000, idleTimeoutMillis: 5000 });
  if (process.env.VERCEL === '1') attachDatabasePool(pool);
  pool.on('error', error => console.error('Conexão PostgreSQL interrompida:', error.code || error.name));
  const query = (sql, params) => pool.query(sql, params);
  return {
    async hasVoted(hash) {
      return (await query('SELECT 1 FROM votes WHERE voter_hash = $1', [hash])).rowCount > 0;
    },
    async insert(hash, game, sessionHash) {
      const { rows } = await query(`WITH session AS (
        SELECT 1 FROM voter_sessions WHERE token_hash = $3 AND voter_hash = $1 AND expires_at > now() FOR SHARE
      ), inserted AS (
        INSERT INTO votes(voter_hash, game) SELECT $1, $2 FROM session ON CONFLICT (voter_hash) DO NOTHING RETURNING id
      ) SELECT EXISTS(SELECT FROM session) AS valid, EXISTS(SELECT FROM inserted) AS saved`, [hash, game, sessionHash]);
      return rows[0].valid ? rows[0].saved : null;
    },
    async results(games) {
      const { rows } = await query('SELECT game, count(*)::integer AS votes, max(id) AS last_id FROM votes GROUP BY game');
      return rankResults(games, rows);
    },
    async resetVotes(revision) {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('LOCK TABLE votes, voter_sessions, request_limits, sheets_sync IN EXCLUSIVE MODE');
        const { rows: [state] } = await db.query(`SELECT count(*)::text || ':' || COALESCE(max(id), 0)::text AS revision,
          (SELECT owner IS NOT NULL AND available_at > now() FROM sheets_sync WHERE id = 1) AS syncing FROM votes`);
        if (state.revision !== revision || state.syncing) {
          await db.query('ROLLBACK');
          return state.syncing ? 'syncing' : 'changed';
        }
        await db.query(`DELETE FROM votes; DELETE FROM voter_sessions; DELETE FROM request_limits;
          UPDATE sheets_sync SET owner = NULL, available_at = '-infinity', last_error = NULL, last_success = NULL WHERE id = 1`);
        await db.query('COMMIT');
        return 'reset';
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      } finally { db.release(); }
    },
    async createSession(tokenHash, voterHash) {
      await query('DELETE FROM voter_sessions WHERE expires_at <= now()');
      const result = await query(`INSERT INTO voter_sessions(token_hash, voter_hash, expires_at)
        SELECT $1, $2, now() + interval '5 minutes' WHERE (SELECT count(*) FROM voter_sessions) < 10000`, [tokenHash, voterHash]);
      return result.rowCount === 1;
    },
    async validSession(tokenHash, voterHash) {
      const result = await query('SELECT 1 FROM voter_sessions WHERE token_hash = $1 AND voter_hash = $2 AND expires_at > now()', [tokenHash, voterHash]);
      return result.rowCount === 1;
    },
    async countRequest(ipHash) {
      await query('DELETE FROM request_limits WHERE expires_at <= now()');
      const { rows } = await query(`INSERT INTO request_limits AS r(ip_hash, hits, expires_at)
        SELECT $1, 1, now() + interval '1 minute'
        WHERE EXISTS (SELECT 1 FROM request_limits WHERE ip_hash = $1) OR (SELECT count(*) FROM request_limits) < 20000
        ON CONFLICT (ip_hash) DO UPDATE SET hits = CASE WHEN r.expires_at <= now() THEN 1 ELSE r.hits + 1 END,
          expires_at = CASE WHEN r.expires_at <= now() THEN excluded.expires_at ELSE r.expires_at END
        RETURNING hits`, [ipHash]);
      return rows[0]?.hits ?? null;
    },
    async pending(limit) {
      const { rows } = await query('SELECT id, game, created_at FROM votes WHERE google_synced_at IS NULL ORDER BY id LIMIT $1', [limit]);
      return rows.map(row => ({ ...row, created_at: row.created_at.toISOString() }));
    },
    async markSynced(ids) {
      await query('UPDATE votes SET google_synced_at = now() WHERE id = ANY($1::integer[]) AND google_synced_at IS NULL', [ids]);
    },
    async claimSync(owner) {
      const result = await query(`UPDATE sheets_sync SET owner = $1, available_at = now() + interval '90 seconds'
        WHERE id = 1 AND available_at <= now()`, [owner]);
      return result.rowCount === 1;
    },
    async finishSync(owner, error, cooldownMs) {
      await query(`UPDATE sheets_sync SET owner = NULL, available_at = now() + $3 * interval '1 millisecond',
        last_error = $2, last_success = CASE WHEN $2::text IS NULL THEN now() ELSE last_success END
        WHERE id = 1 AND owner = $1`, [owner, error, cooldownMs]);
    },
    async syncStatus() {
      const { rows } = await query(`SELECT (SELECT count(*)::integer FROM votes WHERE google_synced_at IS NULL) AS pending,
        last_error AS "lastError", last_success AS "lastSuccess" FROM sheets_sync WHERE id = 1`);
      return rows[0];
    },
    close: () => pool.end()
  };
}
