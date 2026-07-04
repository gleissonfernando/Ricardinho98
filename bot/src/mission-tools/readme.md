<!-- Credito: Perfil Discord https://discord.com/users/1411202571804348507 -->

# Mission Tools

> Bot Discord em TypeScript com painel interativo para gerenciar ferramentas de missões, Rich Presence, conexão em voz e utilidades administrativas.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Discord.js](https://img.shields.io/badge/Discord.js-14.x-5865F2?logo=discord&logoColor=white)
![License](https://img.shields.io/badge/licença-ver%20LICENSE-lightgrey)

---

## Recursos

| Recurso | Descrição |
|---|---|
| `/mission-panel` | Painel principal interativo via slash command |
| Controle de missões | Fila e gerenciamento por usuário |
| Rich Presence | Atividade configurável com imagens e botões |
| Conexão em voz | Entrada automática em canal de voz |
| Verificador de usernames | Consulta e validação de nomes de usuário |
| Persistência local | Configurações do painel salvas em JSON |

---

## Requisitos

- **Node.js** 18 ou superior
- **npm**
- Aplicativo criado no [Discord Developer Portal](https://discord.com/developers/applications) com um bot e token válido

---

## Instalação

**1. Clone o repositório**

```bash
git clone https://github.com/luizpauloteam-dot/mission-tools.git
cd mission-tools
```

**2. Instale as dependências**

```bash
npm install
```

**3. Configure as variáveis de ambiente**

Crie um arquivo `.env` na raiz do projeto com as variáveis obrigatórias:

```env
BOT_TOKEN=seu_token_do_bot
GUILD_ID=id_do_servidor
APPLICATION_ID=id_da_aplicacao
```

<details>
<summary>Variáveis opcionais</summary>

```env
# Alias para APPLICATION_ID (alguns módulos usam este nome)
CLIENT_ID=id_da_aplicacao

# Rich Presence
RICH_PRESENCE_APPLICATION_ID=id_da_aplicacao_para_assets
RICH_PRESENCE_ASSET_CHANNEL_ID=id_do_canal_para_assets

# Caminhos de armazenamento local
PANEL_STORE_PATH=data/panel-store.json
TOKEN_STORE_PATH=data/mission-tokens.json

# Chave de criptografia para tokens salvos
TOKEN_STORE_SECRET=uma_chave_secreta_forte

# Controle de limpeza de DMs
BASE_DELETE_DELAY_MS=700
DISCORD_CLEANUP_VERBOSE=false

# Usuários e amizades com permissões especiais (IDs separados por vírgula)
WHITELISTED_USERS=
WHITELISTED_FRIENDSHIPS=
```

</details>

---

## Scripts

```bash
npm start          # Inicia o bot em produção
npm run dev        # Inicia em modo desenvolvimento (hot reload)
npm run typecheck  # Verifica os tipos TypeScript sem compilar
```

---

## Deploy na Discloud

O projeto já inclui `discloud.config`. Antes de enviar, confirme que os campos principais estão corretos:

```
MAIN=bot.ts
START=npm start
```

Depois envie pelo painel ou pela CLI da Discloud.

---

## Controle de versão

Certifique-se de que o `.gitignore` inclui todos os arquivos sensíveis e gerados antes de qualquer commit:

```gitignore
# Ambiente e segredos
.env

# Dados locais gerados em runtime
data/

# Dependências
node_modules/

# Arquivos gerados por ferramentas internas
banned.txt
hits.txt
proxies.txt
taken.txt
```

Fluxo básico para subir alterações:

```bash
git add -A
git commit -m "feat: descrição da alteração"
git push -u origin main
```

> **Atenção:** se um token ou segredo foi enviado por engano, revogue e regenere imediatamente no Discord Developer Portal.

---

## Licença

Consulte o arquivo [`LICENSE`](./LICENSE).