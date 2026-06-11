# FestasBV → Supabase — Guia de implementação

## Ordem dos passos

**1. Criar schema e tabelas**

- Abre `01_ddl_festasbv.txt` (ou `.sql`)
- Copia TODO o conteúdo
- No Supabase, SQL Editor, **cria uma query nova**, cola e corre
- Inclui GRANTs (crítico: sem isto dá erro 42501), RLS, e o seed do teu email em `allowed_users`

**2. Expor o schema**

- Project Settings > API > Data API > Exposed schemas
- **Marca a checkbox** ao lado de `festasbv`
- Sem isto, tudo fica com “sem acesso” silencioso

**3. Migrar os dados**

- Abre `02_migracao_dados.txt` (ou `.sql`)
- Copia TODO o conteúdo
- SQL Editor, **query nova**, cola e corre
- Gerado do `festasbv-data.json` real: 1 evento (MEO 2025), 19 membros, 85 presenças,
  7 refeições, 48 despesas, 45 convidados, 4 mealheiros, 23 pagamentos

**4. Redirect URL do OAuth**

- Auth > Providers > Google (deve estar ativado)
- Auth > URL Configuration
- Na lista de Redirect URLs, adiciona:
  
  ```
  https://diogoandrefsilva-ghc.github.io/FestasBV/
  ```
- (O cliente OAuth do Google já existe do SplitBill; só falta este URL)

**5. Publicar**

- Substitui `index.html` e `manifest.json` no repo FestasBV
- Commit & push

## Decisões de modelo (para validares)

- `quem`/`de`/`para`/`membro` ficaram como TEXT (nome) e não FK para `membros.id`,
  porque todo o motor de cálculo da app é baseado em nomes. `membros` tem
  UNIQUE(evento_id, nome). Se um dia quiseres renomear pessoas, é um UPDATE em várias tabelas.
- `presencas` é tabela filha de `membros` (FK com CASCADE), 1 linha por dia|refeição.
- `convidados.pagante` passou de ‘Sim’/‘Não’ para BOOLEAN no DB; a app converte nos dois sentidos.
- `desc` → `descricao` no DB (`desc` é palavra reservada em SQL).

## Como a app grava agora

A função `pushToGitHub()` mantém o nome (15 pontos de chamada intactos) mas grava no Supabase:
PATCH ao evento + replace das tabelas filhas (DELETE por evento_id + INSERT em bulk),
tudo serializado numa `_writeChain` (padrão do Expenses-Acc) para evitar race conditions.
São ~10-14 pedidos por gravação — réplica fiel da semântica antiga de “gravar o documento inteiro”.
Se mais tarde quiseres escritas granulares (1 INSERT por despesa nova), é uma evolução possível,
mas exigia mexer em todos os caminhos de escrita.

## Teste após implementação

1. Vai a <https://diogoandrefsilva-ghc.github.io/FestasBV/>
1. Login com Google ou email
1. Testa um toggle de presença (grava?)
1. Abre o separador “Cash-Flows” — toca num cartão de resumo para filtrar
1. Admin: clica em ⚙ Conta, verifica se mostra email e painel de pedidos (se fores admin)

Se algo não funcionar:

- Network inspector (F12 > Network): procura erros de HTTP status
- Console (F12 > Console): erros JS, mensagens de toast
- Supabase Dashboard > Logs: erros de auth / API

-----

**Ficheiros neste folder:**

- `LEIA-ME.md` — este guia
- `01_ddl_festasbv.txt` / `.sql` — schema e RLS (copia inteira para SQL Editor)
- `02_migracao_dados.txt` / `.sql` — 232 registos do JSON (copia inteira para SQL Editor)
- `index.html` — app migrada (publica no GitHub)
- `manifest.json` — PWA manifest com paleta atualizada
- `gerar_migracao.py` — script que gerou o SQL de migração (para documentação)