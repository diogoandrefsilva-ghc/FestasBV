# FestasBV — Permissões v2 (Utilizadores ↔ Membros, Casais, RLS granular)

## O que muda

|Ação                                         |Admin   |Membro ligado                          |Conta não ligada|
|---------------------------------------------|--------|---------------------------------------|----------------|
|Ver tudo (saldos, cash-flows, relatórios)    |✅       |✅                                      |✅               |
|Marcar presenças                             |✅ sempre|✅ próprias + cônjuge, até à data do dia|❌               |
|Convidados (adicionar/remover)               |✅ sempre|✅ próprios + cônjuge, até à data do dia|❌               |
|Registar despesas                            |✅       |✅ próprias + cônjuge (só inserir)      |❌               |
|Editar/apagar cash-flows                     |✅       |❌                                      |❌               |
|Mealheiros, reembolsos, pagar dívidas        |✅       |❌                                      |❌               |
|Parametrizações, plantel, refeições, novo ano|✅       |❌                                      |❌               |
|Aprovar acessos, ligar contas e casais       |✅       |❌                                      |❌               |

Tudo isto é imposto **no Postgres via RLS** — a UI esconde o que não se pode,
mas mesmo pela consola do browser o Supabase recusa.

## Passos

**1. Correr `03_permissoes_membros.sql`** no SQL Editor (query nova, colar tudo).
É idempotente. Cria `user_amigos` + `conjuges`, as funções auxiliares e
substitui as policies “tudo para todos” pelo modelo acima.

**2. Publicar o novo `index.html`** no repo FestasBV (commit & push).

**3. Na app (⚙ → Utilizadores & Casais)**, como admin:

- Liga cada conta aprovada ao respetivo membro do plantel
- Liga os casais (por membro, independente de terem conta)
- Liga já a tua conta ao teu nome 😉

## Notas técnicas

- A escrita dos não-admin é **cirúrgica** (INSERT/DELETE de linhas individuais),
  não o replace completo — necessário para a RLS e de quebra mais rápido.
  Presenças, convidados e despesas usam este caminho para todos (admin incluído).
- O replace completo do admin agora devolve `return=representation` e refresca
  os ids locais — sem isto, os ids ficavam obsoletos após cada gravação.
- Inserts de presenças usam `Prefer: resolution=ignore-duplicates`
  (`ON CONFLICT DO NOTHING`) — `merge-duplicates` faria `DO UPDATE`, que a RLS
  dos não-admin recusaria.
- A regra “até à data” usa `CURRENT_DATE` no servidor (UTC) e a data local na UI.
- Se um membro mudar de nome no plantel, atualiza também `user_amigos`/`conjuges`
  (a ligação é por nome, o identificador estável entre anos).

## UI

- Botão **＋ Adicionar Convidado** movido para imediatamente abaixo da grelha.
- Grelha: coluna de **hoje** destacada a dourado; dias passados com 🔒 para
  não-admin; ponto dourado nos nomes que cada utilizador pode gerir;
  células fora de alcance aparecem esbatidas e não clicáveis.
- Modal de cash-flow para não-admin mostra apenas **Despesa**, com “quem pagou”
  limitado ao próprio/cônjuge.
- Quem tem conta aprovada mas ainda não ligada vê um aviso na aba Presenças.

## Teste rápido

1. Como admin: liga uma conta de teste a um membro, define um casal.
1. Com essa conta: marca presença própria e do cônjuge ✓; tenta noutro membro
   (célula bloqueada) ✗; adiciona convidado ✓; regista despesa ✓;
   confirma que não vês Parametrizações/Plantel nem botões de editar cash-flows.
1. Cria uma refeição com data de ontem e confirma que esse dia fica 🔒 para o teste.