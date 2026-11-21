# Votação presencial · Canal 3 Expo

Formulário de votação presencial da Canal 3 Expo. O participante autoriza a localização, escolhe um dos 26 jogos e envia seu voto. A organização acompanha a apuração pelo painel `/admin` e pode exportar os resultados em CSV.

O projeto usa Node.js 24 ou superior, com SQLite para execução local e PostgreSQL para hospedagem na Vercel. A integração com Google Sheets é opcional.

## Rodar no computador

Em um terminal com Git e Node.js instalados, execute

```sh
git clone https://github.com/NaiSan89/c3_expo_votation.git
cd c3_expo_votation
npm ci
npm start
```

Abra o [formulário](http://localhost:3000) no navegador. Para usar o [painel da organização](http://localhost:3000/admin), copie `.env.example` para `.env`, defina `ADMIN_TOKEN` com uma chave aleatória de pelo menos 24 caracteres e reinicie o servidor. No PowerShell, use `Copy-Item .env.example .env` para fazer a cópia.

Deixe `DATABASE_URL` vazia para usar o SQLite incluído no Node.js. A aplicação abre o arquivo indicado em `DATABASE_PATH`, inclusive se ele já contiver votos.

## Hospedar na Vercel com PostgreSQL

1. Crie um banco PostgreSQL para a votação, por exemplo pelo Neon no Marketplace da Vercel. No editor SQL do provedor, execute [postgres.sql](postgres.sql) uma vez nesse banco. O script também pode ser reaplicado e preserva os votos.
2. Importe o projeto na Vercel. O arquivo `vercel.json` seleciona o framework **Node** e o servidor em `server.js`. Use Node.js 24 ou superior.
3. Em **Settings → Environment Variables**, defina as variáveis abaixo para **Production**. Para testar em **Preview**, use um banco de testes e a origem HTTPS correspondente.
4. Faça o deploy após salvar as variáveis. Abra o domínio configurado, confira os jogos em `/api/config` e a apuração em `/admin`. Teste o fluxo completo de votação no ambiente de testes, dentro da área do evento.

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | URL PostgreSQL com pool de conexões fornecida pelo provedor, com os parâmetros de TLS indicados por ele. |
| `PUBLIC_ORIGIN` | Endereço público exato da votação, por exemplo `https://seu-projeto.vercel.app`, sem barra final. |
| `ADMIN_TOKEN` | Chave aleatória de pelo menos 24 caracteres para liberar o painel. |
| `CRON_SECRET` | Com o Google Sheets ativado, defina uma segunda chave aleatória para autorizar o agendamento de sincronização. |

O PostgreSQL guarda os votos, as sessões de cinco minutos, os contadores de requisições e a fila de sincronização. Ao configurar `DATABASE_URL`, a apuração passa a usar os dados desse banco. Se o SQLite já contiver votos do mesmo evento, reserve uma janela para migrá-los antes da troca, preservando os IDs, os hashes dos votantes e o estado de sincronização. O deploy não copia o arquivo SQLite.

A votação exige uma posição real próxima ao evento. Estar fora da área durante um teste deve resultar em bloqueio. Não existe modo de demonstração que burle o GPS em produção. Os testes automatizados usam dados simulados sem alterar as regras da aplicação.

## O que está configurado

| Configuração | Padrão |
| --- | --- |
| Centro | 23°32'27.5"S 46°44'02.4"W |
| Latitude | -23.540972222222223 |
| Longitude | -46.734 |
| Raio | 200 metros |
| Precisão máxima aceita | 50 metros |
| Idade máxima da leitura | 60 segundos |
| Votação | Aberta |
| Controle de repetição | Um voto por navegador, usando cookie |
| Banco | `data/votes.sqlite` |

O servidor calcula a distância pela fórmula de Haversine. Uma posição só é aceita quando **distância ao centro + precisão declarada ≤ 200 m**. Isso é conservador e pode recusar participantes perto da borda. A precisão informada pelo aparelho é uma estimativa estatística, não uma garantia de posição exata. A localização é solicitada novamente no envio, e o servidor repete a validação. As coordenadas não são gravadas no banco nem enviadas ao Google Sheets.

## Google Sheets

É opcional: sem credenciais, o banco e o painel funcionam normalmente. O Google Forms não recebe os votos desta aplicação; as opções foram reaproveitadas e os votos são escritos diretamente numa aba nova do Sheets. Não use a aba de respostas do formulário antigo como destino.

1. No [Google Cloud Console](https://console.cloud.google.com/), crie ou selecione um projeto e ative a **Google Sheets API**.
2. Em **IAM e administrador → Contas de serviço**, crie uma conta de serviço. Não precisa conceder cargos de administrador do projeto nem delegação de domínio.
3. Gere uma chave JSON para a conta de serviço e guarde-a em local privado, fora de `public/` e fora do controle de versão. Se sua organização impedir chaves, use uma política de autenticação aprovada por ela antes de ativar esta integração.
4. Crie uma planilha e compartilhe-a como **Editor** com o endereço `client_email` do JSON. Mantenha o acesso geral da planilha restrito.
5. Crie uma aba **vazia**, exclusiva para esta instalação, chamada `Votos`. Reserve linhas suficientes para a votação; por exemplo, 10.001 linhas para até 10.000 votos.
6. Copie o ID da planilha, que aparece entre `/d/` e `/edit` no endereço.
7. Preencha no `.env`:

```dotenv
GOOGLE_SPREADSHEET_ID=ID_DA_PLANILHA
GOOGLE_SHEET_NAME=Votos
GOOGLE_APPLICATION_CREDENTIALS="C:/caminho/privado/conta-servico.json"
```

Em hospedagens que fornecem um gerenciador de segredos, você pode preencher `GOOGLE_SERVICE_ACCOUNT_JSON` com o JSON completo em vez de usar um arquivo. Nunca coloque a chave em HTML/JavaScript público nem envie-a pelo chat. Reinicie a aplicação após mudar a configuração.

A aplicação preenche `Voto ID`, `Data UTC` e `Jogo` nas colunas A–C. Cada voto ocupa a linha correspondente ao seu ID + 1. Assim, uma nova tentativa após falha de rede reescreve a mesma linha. A fila permanece no banco e envia lotes de até 200 votos. O painel informa os pendentes e erros do Google.

Um novo voto aciona uma tentativa de envio, com intervalo mínimo de 15 segundos entre lotes. Em servidor contínuo, um temporizador também verifica a fila a cada 15 segundos. Na Vercel, `vercel.json` agenda uma tentativa diária às 06h UTC para atender pendências mesmo depois do último voto. Para escoar uma fila maior durante o evento, ajuste a frequência conforme o plano ou chame `GET /api/sync` com o cabeçalho `Authorization: Bearer <CRON_SECRET>`. Cada chamada processa até um lote. [Agendamento na Vercel](https://vercel.com/docs/cron-jobs/usage-and-pricing)

**Não ordene, remova ou insira linhas na aba de destino durante a votação.** Para fazer análises, use outra aba ou uma cópia. Não aponte duas instalações com bancos diferentes para a mesma aba e não reutilize a aba ao zerar o banco. Se o número de linhas acabar, acrescente linhas; a sincronização será retomada automaticamente. Se trocar a planilha após já ter sincronizado votos, os votos antigos não são reenviados automaticamente: exporte o banco/CSV para migração.

## Painel da organização

Defina `ADMIN_TOKEN` no `.env` com uma chave aleatória de pelo menos 24 caracteres. Gere uma chave forte com:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Abra `/admin` e informe essa chave. Ela é enviada no cabeçalho de autorização e permanece somente na memória da página. O painel mostra os votos por jogo e o estado da sincronização; o botão **Baixar CSV** exporta a apuração. Sem `ADMIN_TOKEN`, o acesso aos resultados fica desativado. Não compartilhe a chave com participantes.

Os resultados vêm do banco de votos e incluem os que ainda aguardam sincronização com o Google. O painel é atualizado ao clicar em **Atualizar resultados**.

## Hospedar com Node.js

Para hospedar com SQLite, use um servidor com **Node.js 24+, uma instância e disco persistente**. Para usar PostgreSQL em um servidor contínuo, aplique `postgres.sql` e configure `DATABASE_URL` como na seção da Vercel.

1. Envie a pasta do projeto para a hospedagem.
2. Configure as variáveis de ambiente. Use `HOST=0.0.0.0` se a plataforma exigir acesso externo à porta, ou `127.0.0.1` se estiver atrás de um proxy no mesmo servidor.
3. Defina `PUBLIC_ORIGIN=https://votacao.seudominio.com.br`, sem barra no final. Esse valor precisa coincidir exatamente com o endereço usado pelos participantes. A aplicação bloqueia envios de outras origens.
4. Defina `DATABASE_PATH` num volume persistente gravável. Guarde as credenciais do Google no gerenciador de segredos da hospedagem ou em arquivo privado.
5. Instale as dependências com `npm ci` e use `npm start` como comando de início. Configure reinício automático pela hospedagem ou pelo gerenciador de serviços do servidor.
6. Ative HTTPS. O arquivo `Caddyfile.example` mostra uma configuração para encaminhar o domínio à porta 3000; ajuste o domínio e a porta conforme sua instalação.
7. Teste em um celular no evento, com localização precisa, antes de divulgar o QR Code.

Fora de `localhost`, a geolocalização exige HTTPS. Abrir `http://IP-DO-COMPUTADOR:3000` pelo celular não é um teste válido de localização; use o endereço HTTPS. Não há necessidade de Google Maps nem de uma chave de mapas.

### Docker opcional

O `Dockerfile` também está incluído. Exemplo de execução em servidor Linux, com `.env` configurado para produção e, se necessário, credenciais Google fornecidas por `GOOGLE_SERVICE_ACCOUNT_JSON`:

```sh
docker build -t c3-votacao .
docker volume create c3-votos
docker run -d --name c3-votacao --restart unless-stopped --env-file .env -e HOST=0.0.0.0 -e DATABASE_PATH=/app/data/votes.sqlite -p 127.0.0.1:3000:3000 -v c3-votos:/app/data c3-votacao
```

Se preferir arquivo de credenciais no Docker, monte-o como somente leitura e configure o caminho **dentro do contêiner**. A chave não é copiada para a imagem. Use um proxy HTTPS na frente do contêiner. Preserve o volume ao atualizar a aplicação.

## Encerrar, alterar jogos e preservar dados

- Para encerrar a votação: defina `VOTING_OPEN=false` e reinicie o processo. Os resultados continuam acessíveis à organização.
- A lista fica em `games.json`, com os rótulos copiados da referência. Faça alterações **antes** de iniciar a votação; renomear opções após votos registrados prejudica a apuração.
- Para mudar o perímetro: ajuste `EVENT_LAT`, `EVENT_LNG`, `EVENT_RADIUS_METERS` e, se necessário, `MAX_ACCURACY_METERS`, e reinicie.
- Para fazer backup do SQLite, encerre o processo de forma normal, copie a pasta `data/` completa e reinicie. Para o PostgreSQL, use os backups do provedor ou `pg_dump`.
- Um novo evento deve usar um banco novo e outra aba de destino. Não remova o banco de uma votação em andamento.

## Limites do controle

O sistema usa a posição declarada pelo navegador. Localização simulada ou uma chamada de API preparada pode contornar essa verificação; não é uma prova inviolável de presença. O cookie limita repetições no mesmo navegador, mas pode ser apagado, e outro navegador pode votar novamente. Para votação com exigência de um voto por pessoa, adicione verificação de código individual de ingresso. Esta versão não verifica ingressos e não exige login Google.

O perímetro é um **círculo** de 200 m em torno do ponto informado. Ele pode incluir ruas e imóveis vizinhos e não corresponde necessariamente às paredes ou aos limites do terreno.

Não é possível participar sem conexão de internet com o servidor. A aplicação limita pedidos de sessão/localização/voto a 600 por minuto por endereço de conexão; atrás de um proxy, esse limite pode ser compartilhado por todos. Ajuste essa estratégia se o evento tiver tráfego maior e só confie em cabeçalhos de encaminhamento de um proxy explicitamente configurado.

## Verificação

```sh
npm test
```

Para incluir o teste com duas instâncias e um PostgreSQL real, defina `TEST_DATABASE_URL` com uma conexão direta a um banco de testes antes de executar `npm test`. Esse teste cria um esquema temporário e o remove ao concluir.

Os testes cobrem o perímetro e sua margem de erro, dados de localização inválidos/antigos, voto aceito, tentativas concorrentes, repetição, persistência, votação encerrada, proteção da apuração e isolamento de sessões. A integração Google é verificada com respostas simuladas, incluindo assinatura de autenticação, destino determinístico e retomada após falha. É necessário realizar um teste real com sua própria planilha após fornecer as credenciais.

Referências: [formulário original](https://forms.gle/ym6V5hwfJRESFwPo9), [Google Sheets values.update](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update), [contas de serviço](https://developers.google.com/identity/protocols/oauth2/service-account), [geolocalização](https://www.w3.org/TR/geolocation/).
