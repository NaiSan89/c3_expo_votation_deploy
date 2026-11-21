import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import handleVercelRequest, { createApp } from '../server.js';
import games from '../games.json' with { type: 'json' };

const origin = 'http://localhost:3000';
test('exporta a função HTTP exigida pelo runtime da Vercel', () => {
  assert.equal(typeof handleVercelRequest, 'function');
});
const adminToken = 'test-admin-token-with-at-least-24-characters';
const position = () => ({ latitude: -23.540972222222223, longitude: -46.734, accuracy: 10, timestamp: Date.now() });
async function start(t, overrides = {}) {
  const app = createApp({ databaseUrl: '', databasePath: ':memory:', origin, adminToken, sheetsClient: null, ...overrides });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await app.whenClosed; });
  const url = `http://127.0.0.1:${app.address().port}`;
  const get = (path, headers) => fetch(url + path, { headers });
  const post = (path, payload, cookie = '', extra = {}) => fetch(url + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...extra }, body: JSON.stringify(payload) });
  const session = async () => {
    const response = await post('/api/session', {}); assert.equal(response.status, 200);
    return { token: (await response.json()).token, cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  return { get, post, session };
}

test('serve interface, 26 jogos e painel sem expor resultados ou arquivos internos', async t => {
  const { get } = await start(t);
  const page = await get('/'); assert.equal(page.status, 200); assert.match(await page.text(), /Qual jogo conquistou/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await (await get('/api/config')).json()).games.length, 26);
  assert.equal((await get('/admin')).status, 200);
  assert.equal((await get('/api/admin/results')).status, 401);
  for (const path of ['/.env', '/server.js', '/data/votes.sqlite', '/games.json', '/%2e%2e/server.js']) assert.equal((await get(path)).status, 404);
});
test('aceita voto dentro da área, protege resultados e impede repetição concorrente', async t => {
  const { post, session, get } = await start(t);
  const { token, cookie } = await session();
  const payload = { token, game: games[0], consent: true, position: position() };
  assert.equal((await post('/api/location', payload, cookie)).status, 200);
  const responses = await Promise.all([post('/api/votes', payload, cookie), post('/api/votes', payload, cookie)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal((await post('/api/session', {}, cookie)).status, 409);
  const results = await (await get('/api/admin/results', { Authorization: `Bearer ${adminToken}` })).json();
  assert.equal(results.total, 1); assert.equal(results.results[0].game, games[0]); assert.equal(results.sync.enabled, false);
  const csv = await get('/api/admin/results?format=csv', { Authorization: `Bearer ${adminToken}` });
  assert.match(csv.headers.get('content-disposition'), /resultados.csv/); assert.match(await csv.text(), /Tuned Turtle/);
});
test('servidor recusa fora do raio, sem autorização, sem sessão, jogo falso e posição antiga', async t => {
  const { post, session } = await start(t);
  const { token, cookie } = await session();
  const base = { token, game: games[0], consent: true, position: position() };
  for (const [change, code] of [
    [{ position: { ...position(), latitude: -23 } }, 422],
    [{ position: { ...position(), accuracy: 100 } }, 422],
    [{ position: { ...position(), timestamp: Date.now() - 70000 } }, 422],
    [{ consent: false }, 400], [{ token: 'fake' }, 403], [{ game: 'Jogo inexistente' }, 400]
  ]) assert.equal((await post('/api/votes', { ...base, ...change }, cookie)).status, code);
  assert.equal((await post('/api/votes', base)).status, 403);
  assert.equal((await post('/api/votes', base, cookie, { Origin: 'https://outro.site' })).status, 403);
  assert.equal((await post('/api/votes', null, cookie)).status, 400);
});
test('sessão de outro navegador não autoriza voto', async t => {
  const { post, session } = await start(t);
  const a = await session(); const b = await session();
  assert.equal((await post('/api/votes', { token: a.token, game: games[0], consent: true, position: position() }, b.cookie)).status, 403);
});
test('votação encerrada recusa abertura de sessão e envio', async t => {
  const { post, get } = await start(t, { votingOpen: false });
  assert.equal((await post('/api/session', {})).status, 403);
  assert.equal((await post('/api/votes', {})).status, 403);
  assert.equal((await (await get('/api/config')).json()).votingOpen, false);
});
test('votos persistem entre reinícios do servidor', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'c3-votes-'));
  const dbPath = join(folder, 'votes.sqlite');
  let app = createApp({ databaseUrl: '', databasePath: dbPath, origin, adminToken, sheetsClient: null });
  t.after(async () => {
    if (app.listening) await new Promise(resolve => app.close(resolve));
    await app.whenClosed;
    assert.ok(folder.startsWith(join(tmpdir(), 'c3-votes-')));
    rmSync(folder, { recursive: true, force: true });
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  let url = `http://127.0.0.1:${app.address().port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const first = await fetch(url + '/api/session', { method: 'POST', headers, body: '{}' });
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const { token } = await first.json();
  assert.equal((await fetch(url + '/api/votes', { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ token, game: games[2], consent: true, position: position() }) })).status, 201);
  await new Promise(resolve => app.close(resolve)); await app.whenClosed;
  app = createApp({ databaseUrl: '', databasePath: dbPath, origin, adminToken, sheetsClient: null });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  url = `http://127.0.0.1:${app.address().port}`;
  const results = await (await fetch(url + '/api/admin/results', { headers: { Authorization: `Bearer ${adminToken}` } })).json();
  assert.equal(results.total, 1);
  assert.equal(results.sync.pending, 1);
  assert.equal((await fetch(url + '/api/session', { method: 'POST', headers: { ...headers, Cookie: cookie }, body: '{}' })).status, 409);
});
test('configuração de produção exige HTTPS e chave longa', () => {
  assert.throws(() => createApp({ origin: 'http://evento.example', databasePath: ':memory:', sheetsClient: null }), /HTTPS/);
  assert.throws(() => createApp({ adminToken: 'curta', databasePath: ':memory:', sheetsClient: null }), /24 caracteres/);
});

test('Vercel exige banco compartilhado e origem HTTPS', () => {
  assert.throws(() => createApp({ vercel: true, databaseUrl: '' }), /DATABASE_URL/);
  assert.throws(() => createApp({ vercel: true, databaseUrl: 'postgresql://localhost/test', origin }), /PUBLIC_ORIGIN/);
});

test('PostgreSQL compartilha sessões, voto único, limites e fila entre instâncias', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const connection = new URL(process.env.TEST_DATABASE_URL);
  const setup = new Pool({ connectionString: connection.href });
  const schema = 'c3_test_' + randomUUID().replaceAll('-', '');
  await setup.query('CREATE SCHEMA ' + schema);
  try {
    connection.searchParams.set('options', '-c search_path=' + schema);
    const databaseUrl = connection.href;
    const db = new Pool({ connectionString: databaseUrl });
    try {
      const sql = await readFile(new URL('../postgres.sql', import.meta.url), 'utf8');
      await db.query(sql);
      await db.query(sql);
      await t.test('uma instância abre a sessão e as duas recebem o mesmo voto', async t => {
        const a = await start(t, { databaseUrl });
        const b = await start(t, { databaseUrl });
        const { token, cookie } = await a.session();
        const payload = { token, game: games[1], consent: true, position: position() };
        assert.equal((await b.post('/api/location', payload, cookie)).status, 200);
        const responses = await Promise.all([a.post('/api/votes', payload, cookie), b.post('/api/votes', payload, cookie)]);
        assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
        for (const server of [a, b]) {
          const res = await server.get('/api/admin/results', { Authorization: `Bearer ${adminToken}` });
          const results = await res.json();
          assert.equal(results.total, 1);
          assert.equal(results.results[0].game, games[1]);
          assert.equal(results.sync.pending, 1);
        }
        const fresh = await a.session();
        await db.query("UPDATE voter_sessions SET expires_at = now() - interval '1 second'");
        assert.equal((await b.post('/api/location', { ...payload, token: fresh.token }, fresh.cookie)).status, 403);
        await db.query('UPDATE request_limits SET hits = 600');
        assert.equal((await b.post('/api/session', {})).status, 429);
      });
      await t.test('agendamento autenticado retoma a fila após falha e coordena duas instâncias', async t => {
        const batches = [];
        const sheetsClient = {
          async header() {},
          async writeVotes(votes) {
            batches.push(votes);
            if (batches.length === 1) throw new Error('falha simulada');
          }
        };
        const cronSecret = 'segredo-exclusivo-do-teste';
        const options = { databaseUrl, origin: 'https://votos.example', vercel: true, cronSecret, sheetsClient };
        const a = await start(t, options);
        const b = await start(t, options);
        const cronHeaders = { Authorization: `Bearer ${cronSecret}` };
        assert.equal((await a.get('/api/sync')).status, 401);
        assert.equal((await a.get('/api/sync', cronHeaders)).status, 503);
        const results = await b.get('/api/admin/results', { Authorization: `Bearer ${adminToken}` });
        const { sync } = await results.json();
        assert.equal(sync.pending, 1);
        assert.equal(sync.lastError, 'falha simulada');
        await b.get('/api/sync', cronHeaders);
        assert.equal(batches.length, 1);
        await db.query("UPDATE sheets_sync SET available_at = now() - interval '1 second'");
        await Promise.all([a.get('/api/sync', cronHeaders), b.get('/api/sync', cronHeaders)]);
        assert.equal(batches.length, 2);
        assert.deepEqual(batches[0], batches[1]);
        const [vote] = batches[1];
        assert.equal(typeof vote.id, 'number');
        assert.equal(new Date(vote.created_at).toISOString(), vote.created_at);
        const final = await b.get('/api/sync', cronHeaders);
        assert.equal(final.status, 200);
        const status = await final.json();
        assert.equal(status.pending, 0);
        assert.equal(status.lastError, null);
        assert.ok(status.lastSuccess);
      });
    } finally { await db.end(); }
  } finally {
    try { await setup.query('DROP SCHEMA ' + schema + ' CASCADE'); }
    finally { await setup.end(); }
  }
});
