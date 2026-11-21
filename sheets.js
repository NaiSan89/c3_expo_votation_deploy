import { readFileSync } from 'node:fs';
import { createSign, randomUUID } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

// JWT de conta de serviço conforme o protocolo OAuth 2.0 do Google.
export function createAssertion(credentials, now = Date.now()) {
  const issued = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: credentials.client_email, scope: SCOPE, aud: TOKEN_URL, iat: issued, exp: issued + 3600 })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(credentials.private_key, 'base64url');
  return `${unsigned}.${signature}`;
}

export class SheetsClient {
  constructor({ spreadsheetId, sheetName = 'Votos', credentials, fetchImpl = fetch }) {
    if (!/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) throw new Error('GOOGLE_SPREADSHEET_ID inválido.');
    if (!sheetName || sheetName.length > 100) throw new Error('GOOGLE_SHEET_NAME inválido.');
    if (!credentials?.client_email || !credentials?.private_key) throw new Error('Credenciais da conta de serviço incompletas.');
    this.id = spreadsheetId;
    this.sheet = `'${sheetName.replaceAll("'", "''")}'`;
    this.credentials = credentials;
    this.fetch = fetchImpl;
    this.accessToken = null;
    this.expires = 0;
  }
  async token() {
    if (this.accessToken && Date.now() < this.expires) return this.accessToken;
    const response = await this.fetch(TOKEN_URL, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: createAssertion(this.credentials) })
    });
    if (!response.ok) throw new Error(`Autenticação Google recusada (HTTP ${response.status}). Confira a conta de serviço e a chave.`);
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !(Number(data.expires_in) > 60)) throw new Error('Resposta inválida da autenticação Google.');
    this.accessToken = data.access_token;
    this.expires = Date.now() + (Number(data.expires_in) - 60) * 1000;
    return this.accessToken;
  }
  async write(range, values) {
    const token = await this.token();
    const response = await this.fetch(`https://sheets.googleapis.com/v4/spreadsheets/${this.id}/values/${encodeURIComponent(`${this.sheet}!${range}`)}?valueInputOption=RAW`, {
      method: 'PUT', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values })
    });
    if (!response.ok) {
      if (response.status === 401) this.accessToken = null;
      throw new Error(`Google Sheets indisponível (HTTP ${response.status}). Confira o ID, a aba, as permissões e a quantidade de linhas.`);
    }
  }
  header() { return this.write('A1:C1', [['Voto ID', 'Data UTC', 'Jogo']]); }
  writeVote(vote) {
    // Cada ID tem sua própria linha: repetir uma tentativa não duplica votos.
    const row = vote.id + 1;
    return this.write(`A${row}:C${row}`, [[vote.id, vote.created_at, vote.game]]);
  }
  async writeVotes(votes) {
    if (!votes.length) return;
    const token = await this.token();
    const response = await this.fetch(`https://sheets.googleapis.com/v4/spreadsheets/${this.id}/values:batchUpdate`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'RAW', data: votes.map(vote => ({
        range: `${this.sheet}!A${vote.id + 1}:C${vote.id + 1}`, majorDimension: 'ROWS', values: [[vote.id, vote.created_at, vote.game]]
      })) })
    });
    if (!response.ok) {
      if (response.status === 401) this.accessToken = null;
      throw new Error(`Google Sheets indisponível (HTTP ${response.status}). Confira o ID, a aba, as permissões e a quantidade de linhas.`);
    }
  }
}

export function sheetsFromEnvironment() {
  const id = process.env.GOOGLE_SPREADSHEET_ID;
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!id && !path && !json) return null;
  if (!id || (!path && !json)) throw new Error('Configure GOOGLE_SPREADSHEET_ID e uma credencial Google, ou deixe todos vazios para usar somente o banco de dados.');
  const credentials = JSON.parse(json || readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  return new SheetsClient({ spreadsheetId: id, sheetName: process.env.GOOGLE_SHEET_NAME || 'Votos', credentials });
}

export function startSync(store, client, { background = true, intervalMs = 15000, minIntervalMs = intervalMs, onError = message => console.error(message) } = {}) {
  let active = null;
  let stopped = false;
  let headerReady = false;
  async function run() {
    const owner = randomUUID();
    if (!await store.claimSync(owner)) return true;
    let lastError = null;
    try {
      if (!headerReady) { await client.header(); headerReady = true; }
      const votes = await store.pending(200);
      if (!stopped && votes.length) {
        await client.writeVotes(votes);
        await store.markSynced(votes.map(vote => vote.id));
      }
    } catch (error) {
      lastError = error.message;
      onError('Sincronização pendente: ' + error.message);
    }
    await store.finishSync(owner, lastError, minIntervalMs);
    return lastError === null;
  }
  function trigger() {
    if (!client || stopped) return Promise.resolve(true);
    if (!active) {
      active = run().catch(error => {
        onError('Fila de sincronização indisponível: ' + (error.code || error.name));
        return false;
      })
        .finally(() => { active = null; });
    }
    return active;
  }
  const timer = client && background ? setInterval(() => { void trigger(); }, intervalMs) : null;
  timer?.unref();
  if (client && background) void trigger();
  return {
    trigger,
    status: async () => ({ enabled: Boolean(client), ...await store.syncStatus() }),
    async stop() { stopped = true; if (timer) clearInterval(timer); await active; }
  };
}
