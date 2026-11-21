import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createAssertion, SheetsClient, startSync } from '../sheets.js';
import { openStore } from '../store.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = { client_email: 'test@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
test('JWT usa escopo Sheets, validade de uma hora e assinatura RSA válida', () => {
  const now = Date.now();
  const [header, payload, signature] = createAssertion(credentials, now).split('.');
  const data = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(data.iss, credentials.client_email); assert.equal(data.exp - data.iat, 3600);
  assert.equal(data.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(data.scope, 'https://www.googleapis.com/auth/spreadsheets');
  assert.equal(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url')), true);
});
test('Google escreve sempre a mesma linha e reutiliza token sem interpretar fórmulas', async () => {
  const calls = [];
  const client = new SheetsClient({ spreadsheetId: 'example_id', sheetName: "Votos d'evento", credentials, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.includes('oauth2') ? { access_token: 'fake-access-token', expires_in: 3600 } : {}));
  } });
  const vote = { id: 7, game: '=HYPERLINK("example")', created_at: '2026-11-20T12:00:00.000Z' };
  await client.header(); await client.writeVote(vote); await client.writeVote(vote);
  assert.equal(calls.filter(call => call.url.includes('oauth2')).length, 1);
  assert.equal(calls[2].url, calls[3].url);
  assert.match(decodeURIComponent(calls[2].url), /'Votos d''evento'!A8:C8/);
  assert.match(calls[2].url, /valueInputOption=RAW/);
  assert.equal(JSON.parse(calls[2].options.body).values[0][2], vote.game);
});
test('fila persiste voto após falha e só marca sincronizado após sucesso; execuções não se sobrepõem', async () => {
  const store = openStore(':memory:'); store.insert('voter1', 'Game');
  let fail = true; let attempts = 0; let active = 0; let maxActive = 0;
  const client = {
    header: async () => {},
    writeVotes: async () => {
      attempts++; active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      if (fail) throw new Error('Simulação de falha do Google');
    }
  };
  const sync = startSync(store, client, { intervalMs: 1000000, minIntervalMs: 0, onError: () => {} });
  await sync.trigger();
  assert.equal(store.pendingCount(), 1); assert.match((await sync.status()).lastError, /falha/);
  fail = false;
  await Promise.all([sync.trigger(), sync.trigger(), sync.trigger()]);
  assert.equal(store.pendingCount(), 0); assert.equal((await sync.status()).lastError, null); assert.equal(maxActive, 1); assert.equal(attempts, 2);
  await sync.stop(); store.close();
});
test('votos em lote mantêm destino determinístico e uma chamada atende várias linhas', async () => {
  const calls = [];
  const client = new SheetsClient({ spreadsheetId: 'sheet', credentials, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.includes('oauth2') ? { access_token: 'token', expires_in: 3600 } : {}));
  } });
  const votes = [{ id: 1, game: 'A', created_at: 'now' }, { id: 3, game: 'B', created_at: 'now' }];
  await client.writeVotes(votes); await client.writeVotes(votes);
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /values:batchUpdate$/);
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body.data.map(row => row.range), ["'Votos'!A2:C2", "'Votos'!A4:C4"]);
  assert.equal(calls[1].options.body, calls[2].options.body);
});
test('sincronização não martela Google a cada voto durante falha', async () => {
  const store = openStore(':memory:'); store.insert('voter', 'Game');
  let attempts = 0;
  const sync = startSync(store, { header: async () => { attempts++; throw new Error('Sem conexão'); } }, { onError: () => {} });
  await sync.trigger();
  for (let i = 0; i < 10; i++) await sync.trigger();
  assert.equal(attempts, 1); assert.equal(store.pendingCount(), 1);
  await sync.stop(); store.close();
});
test('falha de autenticação do Google não revela dados da credencial', async () => {
  const client = new SheetsClient({ spreadsheetId: 'id', credentials, fetchImpl: async () => new Response('secret internal data', { status: 403 }) });
  await assert.rejects(client.header(), /Autenticação Google recusada \(HTTP 403\)/);
});
