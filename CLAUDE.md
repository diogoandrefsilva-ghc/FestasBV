# FestasBV — guia para o assistente

App pessoal de gestão de despesas das Festas (Barrete Verde e Salinas).
**Sem build, sem npm, sem dependências.** É servida estática no GitHub Pages e usa **Supabase (REST)** como backend. PWA (funciona offline / instalável).

## Ficheiros — edita só o que for preciso
- `index.html` — só markup + referências (`<link>`/`<script>`) e o ecrã de splash. ~530 linhas. É aqui que vês os **ids** dos elementos.
- `app.js` — **toda a lógica** (~4100 linhas). É aqui que está quase tudo.
- `style.css` — **todo o CSS** (~700 linhas). Cores, tamanhos, espaçamento, layout.
- `sw.js` — service worker (cache offline).
- Não mexer: `notif-festas.ts`, `db/`, `manifest.json`, `02 migracao dados.txt`.

## Como NÃO gastar tokens à toa (importante)
- **Não leias o `app.js` inteiro.** Está dividido em secções com comentários `/* ═══ TÍTULO ═══ */`. Para achar algo, faz `grep` pelo título e lê só esse troço. Secções:
  Sessão/refresh do token · Permissões · Fecho de contas + validação · Fator das quotas · Ícones de refeição · Classificar cash-flow · Histórico (auditoria) · **Cash Flow Modal** · Edit/Delete Cash Flow · Parametrizações · Notificações Telegram · Limpeza · Add New Year · Plantel · **Presenças Grid** · Convidados · Refeições Def (CRUD) · Hero sub-totais · **Relatórios/PDF** · Read-only mode · Resumo (despesa por membro) · FABs arrastáveis · **Auth (Supabase)** · Utilizadores↔Membros
- Mudança **só visual** → `style.css`. Mudança de **lógica/dados** → `app.js`. Para localizar um botão/campo: procura o `id` no `index.html` e salta para o handler no `app.js`.
- Faz **edições cirúrgicas** (diffs pequenos). **Nunca reescrevas o ficheiro inteiro.**

## Regras técnicas (não partir a app)
- `app.js` carrega como `<script src>` **normal, NÃO module** — há `onclick="…"` no HTML, logo as funções têm de ser **globais**. Não converter para módulo.
- **PWA/cache:** se mexeres em `app.js`, `style.css` ou `index.html`, **sobe `CACHE_NAME` no `sw.js`** (ex.: `app-cache-v3` → `v4`). Estes três já são *network-first* (atualizam sozinhos), mas o bump garante que ninguém fica com versão velha.
- **Supabase:** schema `festasbv`. A chave no topo do `app.js` é a **`anon` (pública, por design)**, protegida por RLS + login Google. **Não é bug nem risco — não a "corrijas" nem a escondas.** Acesso controlado por funções `is_allowed()`/`is_admin()` no servidor.

## Deploy
GitHub Pages a partir de `main`. Um push para `main` publica (caminho do site: `/FestasBV/`).
