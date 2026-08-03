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
  Sessão/refresh do token · Permissões · Fecho de contas + validação · Fator das quotas · Ícones de refeição · Classificar cash-flow · Histórico (auditoria) · **Cash Flow Modal** · Edit/Delete Cash Flow · Parametrizações · Notificações Telegram · Limpeza · Add New Year · Plantel · Categorias de Artigos (agrupadores + AI) · Normalizar Artigos (nomes, via AI) · Pedidos Repetidos (2.º passo do Normalizar: tamanhos/embalagens) · **Compras/Shoplist** · Separador Stock · Stock sem compra (ofertas / ano anterior) · **Foto → Lista** (foto da lista de compras → Gemini) · Importar Fatura (OCR) · **Presenças Grid** · Convidados · Refeições Def (CRUD) · **Swipe entre painéis** (refeições + convidados) · **Troca de Refeições** · Cartaz das Ementas · Hero sub-totais · **T-shirts** · **Relatórios/PDF** · Read-only mode · Resumo fundido nos Saldos (despesa por membro + movimentos + saldo) · FABs arrastáveis · **Auth (Supabase)** · Utilizadores↔Membros

## Convidados que levam acompanhantes ("levo 5 comigo")
Uma linha de `convidados` pode valer **várias bocas**: guarda-se o nome de quem se conhece e a linha diz de que é feita — `adultos` (o próprio incluído, quando é adulto) e `criancas`. Não se inventam linhas "Amigo do João 1/2/3".
- **Toda a contagem passa pelos helpers `gAdultos(g)` / `gCriancas(g)` / `gPessoas(g)`** (e os `gSoma*(lista)`) — nunca contar linhas (`convidados.length`) nem ler `g.adultos` à mão. Sem a migração os campos não existem e os helpers caem no flag `crianca` (1 pessoa por linha).
- Contas: **só os adultos pagam**. Cada adulto de uma linha pagante paga a quota `Q` → `m._convs[i].q = Q × adultos`. O `Ec`/`E` da refeição é a soma dos adultos pagantes, logo entra certo nos denominadores.
- As crianças de um convidado são como os filhos dos membros: **não entram no `calcular()`**, só na contagem de bocas. Podem vir agarradas a qualquer linha, mesmo com adultos.
- O flag `crianca` mantém-se mas é **derivado**: `crianca = (adultos === 0)`. Linha sem adultos → sem "Pagante?" (não há nada a pagar).
- Migração: `db/convidados_acompanhantes.sql`. Tolerante: sem ela, `CONV_AC_COLS=false`, os campos ficam escondidos e cada convidado vale 1 pessoa.

## T-shirts (separador 👕)
Levantamento das t-shirts a encomendar. **Hoje não entra em nenhuma conta** — quotas, saldos e cash-flows ignoram isto.
> **Previsto (ainda NÃO implementado — não avançar sem o dono decidir):** a fatura das t-shirts vai ser um **cash-flow pago por alguém** e o valor entra no **saldo individual** de cada membro segundo a imputação (`imputadoA`), e não pela fórmula das quotas (fator/presenças). Falta saber como vem a fatura e como se formam os preços — sobretudo o que fazer quando o total faturado não bate certo com a soma da grelha (portes, descontos). A peça de imputação já existe para alimentar isto; o que falta é o canal de imputação direta no `calcular()`.
- Uma linha = **uma t-shirt**: nome de quem a veste + tipologia (Homem/Mulher/Criança) + tamanho. Cada um mete quantas quiser; mexe nas suas e nas do cônjuge, o admin em tudo.
- A **grelha de tamanhos** (`tshirt_tamanhos`) é global e só do admin (Definições › T-shirts); o **preço** é opcional — com tudo a 0 a app não fala em dinheiro.
- `tamanho` guarda-se como **texto, não FK**: apagar um tamanho da grelha não mexe nas encomendas já feitas (ficam marcadas "fora da grelha").
- **`membro` é quem PEDIU; `imputadoA` é quem PAGA** (`db/tshirts_imputacao.sql`). Lista vazia = conta de quem pediu — o defeito, para o admin só tocar nas exceções (as dos filhos dividem-se pelos pais). Vários nomes = partes iguais, com o arredondamento a ficar para o fim. Só o admin imputa: garantido por **trigger** (`tshirts_guard_imputacao`), porque o dono da linha também a pode editar. Sem a migração, `TS_IMPUT_COL=false` e o campo fica escondido.
- Relatório PDF próprio (`buildTshirtsReport`): pedidos por pessoa + total por tipologia/tamanho.
- Migração: `db/tshirts.sql`. Tolerante: sem ela, `TSHIRTS_TABLE=false` e o separador nem aparece.

## Crianças (filhos + convidados-criança)
**Não pagam nada.** Não entram no `calcular()` — existem só para se saber quantas bocas há por refeição (compras/cozinha). Se mexeres em quotas ou saldos, as crianças não têm de aparecer lá.
- `filhos` é **global** (como `conjuges`): pais parametrizados pelo admin em Definições › Utilizadores & Casais. `filho_presencas` é **por evento**.
- `filho_presencas` **não tem coluna `modo`, de propósito**: uma criança ou come ou não conta — não há "só bebe". A linha existir = come. Não lhe acrescentes estados.
- A grelha de presenças está ordenada **por agregado** (casal junto), com os filhos logo a seguir aos pais.
- Convidados têm o flag `crianca`; criança força `pagante=false`.
- Migração: `db/filhos.sql`. Tudo tolerante: sem ela, `FILHOS_TABLE=false` e as crianças ficam escondidas.
- Mudança **só visual** → `style.css`. Mudança de **lógica/dados** → `app.js`. Para localizar um botão/campo: procura o `id` no `index.html` e salta para o handler no `app.js`.
- Faz **edições cirúrgicas** (diffs pequenos). **Nunca reescrevas o ficheiro inteiro.**

## Regras técnicas (não partir a app)
- `app.js` carrega como `<script src>` **normal, NÃO module** — há `onclick="…"` no HTML, logo as funções têm de ser **globais**. Não converter para módulo.
- **PWA/cache:** se mexeres em `app.js`, `style.css` ou `index.html`, **sobe `CACHE_NAME` no `sw.js`** (ex.: `app-cache-v3` → `v4`). Estes três já são *network-first* (atualizam sozinhos), mas o bump garante que ninguém fica com versão velha.
- **Versão visível:** em cada deploy relevante sobe também o **`APP_BUILD`** no topo do `app.js` (etiqueta `vNN · data · o que mudou`, mostrada em Definições › Conta) — é assim que o utilizador confirma no telemóvel que já tem a build nova. É independente do `CACHE_NAME`.
- **Supabase:** schema `festasbv`. A chave no topo do `app.js` é a **`anon` (pública, por design)**, protegida por RLS + login Google. **Não é bug nem risco — não a "corrijas" nem a escondas.** Acesso controlado por funções `is_allowed()`/`is_admin()` no servidor.

## Deploy
GitHub Pages a partir de `main`. Um push para `main` publica (caminho do site: `/FestasBV/`).
