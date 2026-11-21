const $ = selector => document.querySelector(selector);
let token = '';
let busy = false;
let revision;
async function request(csv = false) {
  const response = await fetch(`/api/admin/results${csv ? '?format=csv' : ''}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error(response.status === 401 ? 'Chave inválida ou acesso da organização ainda não configurado.' : 'Não foi possível carregar os resultados.');
  }
  return response;
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button').forEach(button => { button.disabled = value; });
}
function logout() {
  token = ''; $('#admin-token').value = ''; $('#dashboard').hidden = true; $('#login').hidden = false; $('#results').replaceChildren();
}
async function refresh() {
  const data = await (await request()).json();
  revision = data.revision;
  $('#reset-sheets').hidden = !data.sync.enabled;
  $('#login').hidden = true; $('#dashboard').hidden = false;
  $('#total').textContent = data.total.toLocaleString('pt-BR');
  $('#sync-state').textContent = !data.sync.enabled ? 'Desativada' : data.sync.pending ? `${data.sync.pending} pendentes` : 'Em dia';
  $('#voting-state').textContent = data.votingOpen ? 'Aberta' : 'Encerrada';
  $('#sync-message').textContent = !data.sync.enabled ? 'Os votos estão salvos no banco de dados. Configure o Google Sheets para sincronizar.' : data.sync.lastError || 'Os votos aguardando envio já estão incluídos na apuração.';
  $('#last-update').textContent = data.sync.lastSuccess ? `Última sincronização: ${new Date(data.sync.lastSuccess).toLocaleString('pt-BR')}.` : 'Aguardando a primeira sincronização.';
  const fragment = document.createDocumentFragment();
  data.results.forEach(result => {
    const row = document.createElement('tr');
    for (const value of [result.game, result.votes]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    fragment.append(row);
  });
  $('#results').replaceChildren(fragment);
  $('#admin-status').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}.`;
}
$('#login').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  token = $('#admin-token').value; $('#admin-token').value = '';
  setBusy(true); $('#login-status').textContent = 'Consultando resultados…';
  try { await refresh(); $('#login-status').textContent = ''; }
  catch (error) { token = ''; $('#login-status').textContent = error.message; }
  finally { setBusy(false); }
});
$('#refresh').addEventListener('click', async () => {
  if (busy) return; setBusy(true);
  try { await refresh(); } catch (error) { $('#admin-status').textContent = error.message; $('#login-status').textContent = error.message; }
  finally { setBusy(false); }
});
$('#export').addEventListener('click', async () => {
  if (busy) return; setBusy(true);
  try {
    const blob = await (await request(true)).blob();
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'resultados-c3-expo.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('#admin-status').textContent = 'Arquivo CSV preparado.';
  } catch (error) { $('#admin-status').textContent = error.message; $('#login-status').textContent = error.message; }
  finally { setBusy(false); }
});
$('#logout').addEventListener('click', logout);
$('#reset-votes').addEventListener('click', () => {
  const total = $('#total').textContent;
  $('#reset-description').textContent = `A apuração exibe ${total} ${total === '1' ? 'voto' : 'votos'}. Confirmar apaga todos os votos registrados.`;
  $('#reset-form').reset();
  $('#reset-dialog').showModal();
});
$('#cancel-reset').addEventListener('click', () => $('#reset-dialog').close());
$('#reset-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  $('#reset-dialog').close();
  setBusy(true);
  const status = $('#admin-status');
  status.textContent = 'Zerando votação…';
  try {
    const response = await fetch('/api/admin/results', {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: $('#reset-confirmation').value, revision }), signal: AbortSignal.timeout(20000)
    });
    if (response.status === 401) { logout(); $('#login-status').textContent = 'Entre novamente para acessar a apuração.'; return; }
    if (!response.ok) throw new Error((await response.json()).message);
    try { await refresh(); status.textContent = 'Votos apagados. Apuração atualizada.'; }
    catch { status.textContent = 'Votos apagados. Clique em Atualizar resultados para consultar a nova apuração.'; }
  } catch (error) {
    status.textContent = error.message + ' Confira a apuração em Atualizar resultados.';
  } finally {
    setBusy(false);
    if (!$('#dashboard').hidden) { status.scrollIntoView({ block: 'center' }); $('#refresh').focus({ preventScroll: true }); }
  }
});
