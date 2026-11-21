import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { validatePosition } from './geo.js';
import { openStore } from './store.js';
import { openPostgres } from './postgres.js';
import { waitUntil } from '@vercel/functions';
import { sheetsFromEnvironment, startSync } from './sheets.js';
import games from './games.json' with { type: 'json' };

const base = process.env.VERCEL === '1' ? process.cwd() : dirname(fileURLToPath(import.meta.url));
function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Configuração inválida: ${name}`);
  return value;
}
function authorized(req, token) {
  const given = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return Boolean(token) && given.length === expected.length && timingSafeEqual(given, expected);
}
export function createApp(overrides = {}) {
  const config = {
    lat: numberEnv('EVENT_LAT', -23.540972222222223, -90, 90),
    lng: numberEnv('EVENT_LNG', -46.734, -180, 180),
    radius: numberEnv('EVENT_RADIUS_METERS', 200, 1, 100000),
    maxAccuracy: numberEnv('MAX_ACCURACY_METERS', 50, 1, 1000),
    origin: process.env.PUBLIC_ORIGIN || 'http://localhost:3000',
    adminToken: process.env.ADMIN_TOKEN || '',
    votingOpen: process.env.VOTING_OPEN !== 'false',
    databasePath: resolve(process.env.DATABASE_PATH || join(base, 'data/votes.sqlite')),
    databaseUrl: process.env.DATABASE_URL || '',
    vercel: process.env.VERCEL === '1',
    cronSecret: process.env.CRON_SECRET || '',
    sheetsClient: undefined,
    ...overrides
  };
  const publicUrl = new URL(config.origin);
  if (publicUrl.origin !== config.origin || !['http:', 'https:'].includes(publicUrl.protocol)) throw new Error('PUBLIC_ORIGIN deve ser uma origem HTTP/HTTPS sem barra final.');
  if (publicUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)) throw new Error('Use HTTPS para disponibilizar o formulário fora de localhost.');
  if (config.adminToken && config.adminToken.length < 24) throw new Error('ADMIN_TOKEN precisa ter pelo menos 24 caracteres.');
  if (config.vercel && !config.databaseUrl) throw new Error('Configure DATABASE_URL para usar PostgreSQL na Vercel.');
  if (config.vercel && publicUrl.protocol !== 'https:') throw new Error('Configure PUBLIC_ORIGIN com a URL HTTPS da votação na Vercel.');
  const client = config.sheetsClient === undefined ? sheetsFromEnvironment() : config.sheetsClient;
  const store = config.databaseUrl ? openPostgres(config.databaseUrl) : openStore(config.databasePath);
  const sync = startSync(store, client, { background: !config.vercel });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', readFileSync(join(base, 'public/index.html'))]],
    ['/app.js', ['text/javascript; charset=utf-8', readFileSync(join(base, 'public/app.js'))]],
    ['/style.css', ['text/css; charset=utf-8', readFileSync(join(base, 'public/style.css'))]],
    ['/admin', ['text/html; charset=utf-8', readFileSync(join(base, 'public/admin.html'))]],
    ['/admin.js', ['text/javascript; charset=utf-8', readFileSync(join(base, 'public/admin.js'))]]
  ]);
  function send(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }
  async function body(req) {
    let size = 0;
    const parts = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw new Error('BODY_TOO_LARGE');
      parts.push(chunk);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (publicUrl.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const path = new URL(req.url, config.origin).pathname;
      if (req.method === 'GET' && assets.has(path)) {
        const [type, content] = assets.get(path);
        res.writeHead(200, { 'Content-Type': type }); res.end(content); return;
      }
      if (req.method === 'GET' && path === '/api/config') {
        send(res, 200, { games, radius: config.radius, maxAccuracy: config.maxAccuracy, votingOpen: config.votingOpen }); return;
      }
      if (path === '/api/sync' && req.method === 'GET') {
        if (!client) { res.writeHead(204); res.end(); return; }
        if (!authorized(req, config.cronSecret)) { send(res, 401, { message: 'Acesso não autorizado.' }); return; }
        const ok = await sync.trigger();
        const status = await sync.status();
        send(res, ok && !status.lastError ? 200 : 503, status); return;
      }
      if (path === '/api/admin/results' && ['GET', 'DELETE'].includes(req.method)) {
        if (!authorized(req, config.adminToken)) {
          send(res, 401, { message: 'Acesso não autorizado.' }); return;
        }
        if (req.method === 'DELETE') {
          if (req.headers.origin !== config.origin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
            send(res, 403, { message: 'Abra o painel no endereço oficial da votação.' }); return;
          }
          const payload = await body(req);
          if (payload?.confirmation !== 'APAGAR' || typeof payload.revision !== 'string' || !/^\d+:\d+$/.test(payload.revision)) {
            send(res, 400, { message: 'Confirme a exclusão digitando APAGAR.' }); return;
          }
          const result = await store.resetVotes(payload.revision);
          if (result === 'changed') { send(res, 409, { message: 'A apuração mudou. Atualize os resultados antes de confirmar novamente.' }); return; }
          if (result === 'syncing') { send(res, 409, { message: 'O Google Sheets está sincronizando. Aguarde e tente novamente.' }); return; }
          res.writeHead(204); res.end(); return;
        }
        const { results, revision } = await store.results(games);
        if (new URL(req.url, config.origin).searchParams.get('format') === 'csv') {
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="resultados.csv"' });
          res.end('\uFEFFJogo;Votos\r\n' + results.map(row => `"${row.game.replaceAll('"', '""')}";${row.votes}`).join('\r\n')); return;
        }
        send(res, 200, { total: results.reduce((sum, row) => sum + row.votes, 0), results, revision, sync: await sync.status(), votingOpen: config.votingOpen }); return;
      }
      if (req.method !== 'POST' || !['/api/session', '/api/location', '/api/votes'].includes(path)) {
        send(res, 404, { message: 'Página não encontrada.' }); return;
      }
      if (req.headers.origin !== config.origin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        send(res, 403, { message: 'Origem da solicitação inválida. Abra o endereço oficial do formulário.' }); return;
      }
      const ip = (config.vercel && req.headers['x-vercel-forwarded-for']) || req.socket.remoteAddress;
      const hits = await store.countRequest(hash(ip));
      if (hits === null) { send(res, 503, { message: 'Servidor ocupado. Tente em instantes.' }); return; }
      if (hits > 600) { res.setHeader('Retry-After', '60'); send(res, 429, { message: 'Muitas tentativas. Aguarde um minuto.' }); return; }
      if (!config.votingOpen) { send(res, 403, { message: 'A votação está encerrada.' }); return; }
      const cookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('c3_voter='))?.slice(9);
      const voter = /^[a-f0-9]{64}$/.test(cookie || '') ? cookie : randomBytes(32).toString('hex');
      const voterHash = hash(voter);
      if (await store.hasVoted(voterHash)) { send(res, 409, { message: 'Este navegador já registrou um voto.' }); return; }
      if (path === '/api/session') {
        const token = randomBytes(32).toString('hex');
        if (!await store.createSession(hash(token), voterHash)) { send(res, 503, { message: 'Servidor ocupado. Tente em instantes.' }); return; }
        res.setHeader('Set-Cookie', `c3_voter=${voter}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${publicUrl.protocol === 'https:' ? '; Secure' : ''}`);
        send(res, 200, { token }); return;
      }
      const payload = await body(req);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { send(res, 400, { message: 'Dados inválidos.' }); return; }
      if (typeof payload.token !== 'string' || !/^[a-f0-9]{64}$/.test(payload.token) || !await store.validSession(hash(payload.token), voterHash)) {
        send(res, 403, { message: 'Sua sessão expirou. Verifique sua presença novamente.' }); return;
      }
      if (payload.consent !== true) { send(res, 400, { message: 'Autorize o uso pontual da localização para validar a presença.' }); return; }
      const position = validatePosition(payload.position, config);
      if (!position.ok) { send(res, 422, { message: position.message }); return; }
      if (path === '/api/location') { send(res, 200, { message: 'Presença confirmada na área do evento.' }); return; }
      if (!games.includes(payload.game)) { send(res, 400, { message: 'Selecione um jogo da lista.' }); return; }
      const inserted = await store.insert(voterHash, payload.game, hash(payload.token));
      if (inserted === null) { send(res, 403, { message: 'Sua sessão expirou. Verifique sua presença novamente.' }); return; }
      if (!inserted) { send(res, 409, { message: 'Este navegador já registrou um voto.' }); return; }
      if (client && config.vercel) waitUntil(sync.trigger());
      else void sync.trigger();
      send(res, 201, { message: 'Voto registrado. Obrigado por participar!' });
    } catch (error) {
      if (error instanceof SyntaxError || error.message === 'BODY_TOO_LARGE') send(res, error.message === 'BODY_TOO_LARGE' ? 413 : 400, { message: 'Solicitação inválida.' });
      else { console.error('Falha ao processar solicitação:', error.code || error.name); if (!res.headersSent) send(res, 500, { message: 'Não foi possível salvar seu voto. Tente novamente.' }); else res.end(); }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.whenClosed = new Promise(resolveClosed => server.once('close', () => {
    void sync.stop().then(() => store.close()).finally(resolveClosed);
  }));
  return server;
}

let productionHandler;
export default function handleVercelRequest(req, res) {
  // Reutiliza o mesmo pool e o mesmo handler HTTP entre requisições da instância.
  productionHandler ??= createApp({ vercel: true }).listeners('request')[0];
  return productionHandler(req, res);
}

if (process.env.VERCEL !== '1' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = numberEnv('PORT', 3000, 1, 65535);
  const server = createApp();
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Formulário disponível: ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { void server.whenClosed.then(() => process.exit(0)); }));
}
