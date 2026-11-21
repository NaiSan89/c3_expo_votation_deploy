const $ = selector => document.querySelector(selector);
let config;
let sessionToken;
let chosenGame = '';
let category = 'all';
let locationVerified = false;
let busy = false;
let completed = false;

function status(element, message, kind = '') {
  element.textContent = message;
  element.className = `status ${kind}`;
}
function updateButtons() {
  $('#check-location').disabled = !config?.votingOpen || !$('#consent').checked || busy || completed;
  $('#consent').disabled = busy || completed || !config?.votingOpen;
  $('#submit-vote').disabled = !config?.votingOpen || !$('#consent').checked || !chosenGame || !locationVerified || busy || completed;
  $('#games-fieldset').disabled = !config?.votingOpen || busy || completed;
}
async function api(path, payload) {
  let response;
  try {
    response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  } catch {
    throw new Error('A conexão foi interrompida. Verifique sua internet e tente novamente.');
  }
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message || 'Não foi possível concluir. Tente novamente.');
    error.status = response.status;
    throw error;
  }
  return data;
}
async function ensureSession() {
  if (!sessionToken) sessionToken = (await api('/api/session', {})).token;
}
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext) { reject(new Error('A localização precisa de uma conexão HTTPS. Abra o endereço seguro do evento.')); return; }
    if (!navigator.geolocation) { reject(new Error('Seu navegador não oferece acesso à localização. Tente outro navegador no celular.')); return; }
    navigator.geolocation.getCurrentPosition(position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, timestamp: position.timestamp }), error => {
      const messages = {
        1: 'O acesso à localização foi negado. Permita a localização precisa nas configurações do navegador e tente novamente.',
        2: 'Não foi possível obter sua localização. Ative o GPS e tente perto de uma janela ou em uma área aberta.',
        3: 'O GPS demorou para responder. Verifique o sinal e tente novamente.'
      };
      reject(new Error(messages[error.code] || 'Não foi possível obter sua localização.'));
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  });
}
function complete(message, duplicate = false) {
  completed = true;
  $('#voting-content').hidden = true;
  $('#completion').hidden = false;
  if (duplicate) {
    $('#completion .eyebrow').textContent = 'PARTICIPAÇÃO JÁ REGISTRADA';
    $('#completion-title').textContent = 'Este navegador já participou.';
  }
  $('#completion-message').textContent = message;
  $('#completion').focus();
}
function handleError(error, target) {
  if (error.status === 409) { complete('Já existe um voto registrado neste navegador. Obrigado por participar!', true); return; }
  if (error.status === 403) sessionToken = null;
  locationVerified = false;
  status(target, error.message, 'error');
}
function renderGames() {
  const term = $('#search').value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  let visible = 0;
  let selectionHidden = false;
  for (const label of $('#games-list').children) {
    const game = label.querySelector('input').value;
    const matches = (category === 'all' || game.includes(`(${category})`)) && game.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').includes(term);
    label.hidden = !matches;
    label.classList.toggle('selected', game === chosenGame);
    if (matches) visible++;
    if (game === chosenGame && !matches) selectionHidden = true;
  }
  $('#selected-hint').hidden = !selectionHidden;
  $('#games-count').textContent = `${visible} de ${config.games.length} jogos`;
  $('#empty-search').hidden = visible !== 0;
}
function buildGames() {
  config.games.forEach((game, index) => {
    const label = document.createElement('label');
    label.className = 'game-card';
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'game'; input.value = game; input.id = `game-${index}`;
    const copy = document.createElement('span'); copy.className = 'game-copy';
    const title = document.createElement('span'); title.className = 'game-title'; title.textContent = game.replace(/\s*\((INDIE|RETRO)\)\s*$/, '').trim();
    const badge = document.createElement('span'); badge.className = `game-category ${game.includes('(RETRO)') ? 'retro' : ''}`; badge.textContent = game.includes('(RETRO)') ? 'RETRO' : 'INDIE';
    copy.append(title, badge); label.append(input, copy); $('#games-list').append(label);
    input.addEventListener('change', () => {
      chosenGame = game;
      $('#selected-game').textContent = title.textContent;
      renderGames(); updateButtons();
    });
  });
  renderGames();
}
$('#consent').addEventListener('change', () => {
  if (!$('#consent').checked) { locationVerified = false; status($('#location-status'), 'Aguardando sua autorização.'); }
  else status($('#location-status'), 'Você já pode verificar sua presença.');
  updateButtons();
});
$('#check-location').addEventListener('click', async () => {
  busy = true; locationVerified = false; updateButtons();
  status($('#location-status'), 'Consultando sua localização…');
  try {
    await ensureSession();
    const position = await getPosition();
    const result = await api('/api/location', { token: sessionToken, consent: true, position });
    locationVerified = true;
    status($('#location-status'), result.message, 'success');
    status($('#form-status'), chosenGame ? 'Tudo pronto para confirmar seu voto.' : 'Escolha um jogo para continuar.');
  } catch (error) { handleError(error, $('#location-status')); }
  finally { busy = false; updateButtons(); }
});
$('#search').addEventListener('input', renderGames);
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
  category = button.dataset.category;
  document.querySelectorAll('.filter').forEach(other => { other.classList.toggle('active', other === button); other.setAttribute('aria-pressed', String(other === button)); });
  renderGames();
}));
$('#vote-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !chosenGame || !locationVerified || !$('#consent').checked) return;
  busy = true; updateButtons();
  $('#submit-vote').textContent = 'Registrando…';
  status($('#form-status'), 'Confirmando sua localização e registrando seu voto…');
  try {
    await ensureSession();
    const position = await getPosition();
    const result = await api('/api/votes', { token: sessionToken, game: chosenGame, consent: true, position });
    complete(result.message);
  } catch (error) {
    handleError(error, $('#form-status'));
    if (!completed) status($('#location-status'), 'Verifique sua presença novamente antes de tentar enviar.');
  } finally { busy = false; $('#submit-vote').textContent = 'Confirmar meu voto'; updateButtons(); }
});
async function initialize() {
  try {
    const response = await fetch('/api/config', { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    config = await response.json();
    $('#radius-label').textContent = `Raio de ${config.radius} m`;
    buildGames();
    status($('#form-status'), config.votingOpen ? 'Confirme sua presença e escolha seu favorito.' : 'A votação está encerrada.', config.votingOpen ? '' : 'error');
    if (!config.votingOpen) status($('#location-status'), 'A votação está encerrada.');
    else {
      try { await ensureSession(); } catch (error) { if (error.status === 409) complete('Obrigado por participar do festival!', true); else status($('#form-status'), error.message, 'error'); }
    }
  } catch { status($('#form-status'), 'Não foi possível carregar a votação. Verifique a conexão e recarregue esta página.', 'error'); }
  updateButtons();
}
void initialize();
