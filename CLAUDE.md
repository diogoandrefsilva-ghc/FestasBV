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
  Sessão/refresh do token · Permissões · Fecho de contas + validação · Fator das quotas · Ícones de refeição · Classificar cash-flow · Histórico (auditoria) · **Cash Flow Modal** · **Pagamentos Pendentes** · Edit/Delete Cash Flow · Parametrizações · Notificações Telegram · Limpeza · Add New Year · Plantel · Categorias de Artigos (agrupadores + AI) · Normalizar Artigos (nomes, via AI) · Pedidos Repetidos (2.º passo do Normalizar: tamanhos/embalagens) · **Artigos de Despensa** (3.º passo do Normalizar) · **Compras/Shoplist** · **Pesquisa de Artigos** (🔎 na Shop List e no Stock) · Separador Stock · Stock sem compra (ofertas / ano anterior) · **Foto → Lista** (foto da lista de compras → Gemini) · Importar Fatura (OCR) · **Presenças Grid** · Convidados · Refeições Def (CRUD) · **Swipe entre painéis** (refeições + convidados) · **Troca de Refeições** · Cartaz das Ementas · Hero sub-totais · **T-shirts** · **Relatórios/PDF** · Read-only mode · Resumo fundido nos Saldos (despesa por membro + movimentos + saldo) · FABs arrastáveis · **Auth (Supabase)** · Utilizadores↔Membros

## Esqueci-me da password
Quem entra com email+password recupera-a sozinho: "Esqueci-me da password" no login → `/auth/v1/recover` → email com **link e código**.

**O template do email tem de apontar para a app, não para o GoTrue.** (Supabase › Authentication › Emails › Reset Password.) O `{{ .ConfirmationURL }}` de defeito vai a `/auth/v1/verify`, que **gasta o token num simples GET** — e os scanners de segurança do email (Gmail & c.ª) abrem os links antes do dono, pelo que ele apanhava "link inválido ou expirado" **sempre, logo à primeira**. Com `token_hash` o link é uma página estática nossa e o token só é gasto no `POST /auth/v1/verify` que a app faz:
```html
<a href="https://diogoandrefsilva-ghc.github.io/FestasBV/?token_hash={{ .TokenHash }}&type=recovery">Definir password nova</a>
<p>Ou escreve este código na app: <strong>{{ .Token }}</strong></p>
```
- **O código de 6 dígitos (`{{ .Token }}`) é a saída garantida**: ler um email não o gasta. Aparece na caixa `login-codigo`, que se abre sozinha depois de se pedir o email e sempre que um link falha. Confirma-se com `POST /auth/v1/verify` (`{type:'recovery',email,token}`).
- `sbTratarHashAuth` trata **três formas**: `?token_hash=` (link novo), `#access_token=` (login Google e links à moda antiga) e `#error=`/`?error=` (link gasto). Lê query **e** hash — o link novo traz tudo na query.
- Mensagem de link falhado leva o `error_code` entre parênteses de propósito: é o que distingue "gasto pelo scanner" (`otp_expired`) de um problema de rede.
- O hash/query é tratado no **arranque, antes da sessão guardada** (`sbTratarHashAuth`): quem clica no link costuma já ter sessão neste dispositivo e o token de recuperação era ignorado. Recovery mostra o ecrã `page-nova-pass`; qualquer outro `access_token` (Google) segue direto para o `sbAposLogin()`, como antes.
- **O token de recuperação dá sessão mas não troca a password** — sem o ecrã da password nova ele voltava a ficar de fora no arranque seguinte. A troca é um `PUT /auth/v1/user` (`sbTrocarPassword`, partilhado com Definições › Conta).
- **PWA:** no iOS o link do email abre no Safari, não na app instalada. A password fica na mesma trocada (é servidor), mas a sessão fica do lado do browser — por isso o ecrã de sucesso diz-lhe para voltar à app e entrar com a password nova.
- Falha de rede a tratar o hash **não pode pendurar o arranque no splash**: cai no login com aviso (`sbInit` apanha).
- Não se diz se o email existe (a resposta é sempre a mesma) e o 429 do Supabase tem frase própria — o SMTP de defeito deixa passar poucos emails por hora.

## Password temporária dada pelo admin (Definições › Utilizadores & Casais)
Rede de segurança para quando a recuperação por email não serve — e não serve sempre: o serviço de email de defeito do Supabase manda meia dúzia de mensagens por hora e **não deixa editar os templates sem SMTP próprio**, que é o que trava o link com `token_hash`. O admin gera uma password, dita-a pelo telefone, e a pessoa troca-a em Definições › Conta.
- **A app nunca escreve em `auth.users`** — nem podia: a chave é a `anon` pública. Quem faz o trabalho é `festasbv.admin_pass_temp` (SECURITY DEFINER), chamada por RPC. **A verificação é do lado do servidor** (`is_admin()`), não da UI: esconder o botão não era proteção nenhuma.
- A função recusa: quem não é admin, contas fora de `allowed_users`, passwords com menos de 8, e **a conta do próprio admin** (essa muda-se no Supabase, para um admin com a sessão roubada não se poder trancar sozinho lá dentro).
- `crypt(..., gen_salt('bf', 10))` — bcrypt custo 10 **explícito**, que é o do GoTrue; o defeito do `gen_salt` é 6 e daria um hash mais fraco do que o das outras contas.
- Fica no `historico` (`tipo:'conta'`, `accao:'pass_temp'`) porque mudar a password de outra pessoa tem de deixar rasto — e o Telegram avisa, como em tudo o resto.
- Migração: `db/admin_pass_temp.sql`. Tolerante: sem ela, o botão diz que falta correr o ficheiro e mais nada muda.

## Pagar dívida sem ser o admin (🕓 pagamentos pendentes)
Registar um pagamento de dívida continua a ser um ato do admin — o que mudou é quem o **desencadeia**. Um membro declara o pagamento dele (ou do cônjuge) e a linha fica em `pagamentos_pendentes`; só quando o admin valida é que a app cria o cash-flow em `pagamentos`.
- **Pendente não é dinheiro.** Nada disto entra no `calcular()`: as dívidas não baixam, os saldos não mexem, o resultado do grupo não muda. Se mexeres nas contas, os pendentes não têm de aparecer lá — só o aviso 🕓 por baixo do saldo (`rs-pend`) e o bloco à cabeça dos Cash Flows.
- A tabela `pagamentos` **não passou a aceitar escrita de não-admins** e não pode passar: a app grava o ano a substituir as tabelas filhas todas (`sbGuardarEvento`), o que só o admin pode fazer. É por isso que existe uma tabela à parte em vez de uma coluna "aprovado" nos pagamentos.
- Guarda-se **o que foi pedido**, não o que se calcula na hora: as dívidas mudam com as despesas que forem entrando e o admin tem de aprovar exatamente o que viu. `valor` = dívida, `extra` = arredondamento para a poupança, `ref` = as mesmas chaves `own:`/`conv:` dos pagamentos (vazio = adiantamento).
- **Aprovar marca primeiro, lança depois** (`aprovarPagPend`): pela ordem inversa, uma falha a meio deixava o dinheiro lançado e o pedido na fila, pronto a ser aprovado outra vez. O `estado=eq.pendente` no PATCH é a trava contra dois toques; se o ano não gravar, o pedido volta à fila.
- O membro só vê e só paga **dívidas suas e do cônjuge** (`updateSdChips` filtra por `_relatedNames`). Pagar a dívida de terceiros continua a ser do admin.
- Rejeitar pede o motivo **no próprio cartão** (`_ppRejId`), não em `prompt()` — a app não usa `prompt` em lado nenhum.
- Aprovado **não se apaga** aqui: já é um cash-flow, e mexer nele é matéria do editor de cash-flows. O membro pode cancelar enquanto está pendente e dispensar o que foi rejeitado.
- O admin é avisado pelo Telegram porque o pedido escreve no `historico` (`tipo:'pagamento'`); as Edge Functions não foram tocadas — a frase vem redigida da app, como todas.
- Migração: `db/pagamentos_pendentes.sql`. Tolerante: sem ela, `PAGPEND_TABLE=false` e a opção volta a ser só do admin.

## Artigos de despensa (🫙)
Há **dois tipos de artigo** na lista de compras e antes disto eram tratados como um só:
- **Consumível** — a procura escala com as refeições (carne, batatas, ovos). Dois pedidos para dias diferentes **não são duplicados** — é por isso que o passo dos Pedidos Repetidos se recusa a juntar entre refeições (`shopRepFusiveis`). Não mexer nisso.
- **Despensa** — uma embalagem chega para o evento todo (azeite, sal, pimenta, louro, orégãos, colorau). Cada cozinheiro escreve-o na lista da sua refeição e faz bem; o que não pode é quem compra ver três "Azeite".

A marca é **por nome** (`ART_DESP`, chave = `shopArtKey`, tal como o `ART_CATS`) e **global** — o azeite é despensa em todos os anos. **Nada disto apaga nem funde pedidos**: é agregação.
- **Lista da refeição** — a linha fica, marcada 🫙. Se já houver lote comprado, aparece no bloco Comprado com "🧺 em stock" (mesmo que o lote esteja alocado a outra refeição — ver `despCoberto` em `mealShopSection`, sem isso a linha desaparecia do cartão).
- **Compras** — os pedidos colapsam numa linha só, em secção própria **à cabeça** de cada bloco de estado e **fora da ordenação escolhida** (loja/refeição/artigo/categoria). Quantidade = **máximo, nunca soma** (`shopDespQty`) — somar era o erro a corrigir. As contagens do topo contam **grupos**, não pedidos.
- **Ações em bloco** — ＋🛒/✓/✕ valem para o grupo todo (um PATCH `id=in.(…)`). Sem isto o colapso resolvia o ver e devolvia o problema no carrinho. Só tocam nos pedidos do **mesmo dono** (`despMesmoDono`).
- **Custo → sempre Gerais.** Uma embalagem serve o evento todo, por isso não se reparte por refeições: `compraProporDestino` força `destino='Gerais'` num artigo de despensa (sem isto, um artigo pedido por UMA só refeição colava-lhe o custo, por causa do `keys.length===1`). **Não tentar repartir por partes iguais** — já foi tentado e está errado: ninguém mede quanto azeite levou cada refeição, e a alocação a refeições nunca foi um ato de custo.
- **Cobertura** — havendo lote comprado do artigo, todos os pedidos ficam cobertos, sem exigir alocação refeição a refeição. É a única exceção à regra de `shopIsCovered`. **É isto que "responde" ao pedido de cada refeição** — o vínculo à refeição é de resposta à lista, não de dinheiro. Por isso não é preciso alocar nada, e o modal do lote di-lo por escrito (`lote-desp-nota`).
- **Deteção** — local e determinística: repetido em ≥2 refeições e sem quantidade indicada. A AI (`despensa:true` no `fatura-ocr`) acrescenta o que escapa, mas é opcional. **Confirmação do admin é obrigatória**: a heurística marca salsa/coentros/hortelã, que são fresco e se compram por refeição.
- Migração: `db/despensa.sql`. Tolerante: sem ela, `DESP_TABLE=false` e tudo fica escondido.

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
- **Trancar a encomenda** (`eventos.tshirts_trancadas`, `db/tshirts_trancar.sql`): quando a encomenda já seguiu, o admin fecha-a em Definições › T-shirts e a partir daí só ele mexe. É **por ano** e independente do fecho de contas. Imposto no servidor: as policies "self" exigem `tshirts_abertas()`. Sem a migração, `TS_LOCK_COL=false` e o interruptor fica escondido.
- **Quem pede** só é escolhível pelo admin; para os outros o campo fica trancado no próprio nome (a editar, mantém quem lá está — pode ser o cônjuge).
- Relatório PDF próprio (`buildTshirtsReport`): pedidos por pessoa (colunas de largura fixa, iguais em todos os quadros) + total por tipologia/tamanho, e o "Por conta de" a fechar.
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
