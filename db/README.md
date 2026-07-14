# FestasBV — Base de dados (Supabase)

Fonte de verdade do schema `festasbv` no Supabase
(projeto `diogoandrefsilva-personalapps-database`,
`https://gjweqwfbnkgnibhajldc.supabase.co`).

## Regra de ouro

**O repo é a fonte; o Supabase segue atrás.** Quando há uma alteração ao
schema, funções ou policies, edita-se primeiro o ficheiro `.sql` aqui e só
depois se cola no SQL Editor do Supabase. Nunca o contrário — assim estes
ficheiros nunca ficam desatualizados em relação à BD real.

## Ordem de execução

Numa BD limpa, correr por esta ordem (há dependências entre eles):

1. `schema.sql` — schema, tabelas, constraints, GRANTs e `ENABLE ROW LEVEL SECURITY`
2. `functions.sql` — funções de acesso + triggers (dependem das tabelas)
3. `policies.sql` — RLS policies (dependem das funções)
4. `shoplist.sql` — lista de compras partilhada (`shoplist` + `despesas.compra_id`)
5. `stock.sql` — stock por refeição (`stock_lotes`); só necessário para a gestão de stock

Os passos 4–5 são migrações add-on idempotentes: correr uma vez cada.

## Conteúdo

- **schema.sql** — 15 tabelas (`eventos` e dependentes via `ON DELETE CASCADE`,
  tabelas de acesso e `config`). IDs `bigint` SEM sequence: atribuídos pela app
  (sequenciais, nunca `Date.now()`).
- **functions.sql** — `is_admin`, `is_allowed`, `meus_amigos`, `membro_meu`,
  `meu_amigo`, `dia_aberto_evento`, `dia_aberto_membro`, `guard_fecho`, mais os
  triggers `trg_guard_fecho` (protege fecho de contas) e o webhook do histórico.
- **policies.sql** — leitura para `is_allowed()`, escrita total para `is_admin()`,
  e regras "self" (cada amigo só mexe no que é seu, e só com o dia aberto).

## Modelo de permissões

Imposto no Postgres via RLS (a UI esconde o que não se pode, mas mesmo pela
consola do browser o Supabase recusa). Resumo do que está em `policies.sql`:

| Ação                                          | Admin    | Amigo ligado                          | Conta não ligada |
|-----------------------------------------------|----------|---------------------------------------|------------------|
| Ver tudo (saldos, cash-flows, relatórios)     | ✅        | ✅                                     | ✅                |
| Marcar presenças                              | ✅ sempre | ✅ próprias + cônjuge, até à data do dia | ❌              |
| Convidados (adicionar/editar/remover)         | ✅ sempre | ✅ próprios + cônjuge, até à data do dia | ❌              |
| Registar despesas                             | ✅        | ✅ próprias + cônjuge (só inserir)      | ❌               |
| Validar contas (`validacoes`)                 | ✅        | ✅ próprias + cônjuge                   | ❌               |
| Editar/apagar cash-flows                      | ✅        | ❌                                     | ❌               |
| Mealheiros, reembolsos, pagamentos            | ✅        | ❌                                     | ❌               |
| Fechar/reabrir contas (trigger `guard_fecho`) | ✅        | ❌                                     | ❌               |
| Parametrizações, plantel, refeições, novo ano | ✅        | ❌                                     | ❌               |
| Config (`notif_telegram`), aprovar acessos    | ✅        | ❌                                     | ❌               |

Quem pode mexer no quê resolve-se por nome via `user_amigos` (conta → amigo) +
`conjuges` (casais, nos dois sentidos) — ver `meus_amigos()` / `meu_amigo()`.
A regra "até à data" usa `CURRENT_DATE` no servidor (`dia_aberto_*`).

## ⚠️ Segredos — nunca commitar

- A **service_role key** (JWT com `role: service_role`) ignora todo o RLS.
  Vive só no Supabase e nos secrets das Edge Functions. No `functions.sql` o
  webhook do histórico está com a chave **redigida** de propósito.
- A **anon key** também não entra nestes ficheiros SQL.
- O webhook (`festasbv_historico`) é gerido pelo dashboard (Database → Webhooks);
  ao rodar a chave, reconfigura-se aí e o trigger é regenerado — nada muda no repo.

## Recriar do zero

```bash
# no SQL Editor do Supabase, por ordem:
#   1) schema.sql
#   2) functions.sql   (preencher o webhook pelo dashboard, não à mão)
#   3) policies.sql
```

Antes: expor o schema em Project Settings → API → Data API → Exposed schemas
(senão os GRANTs não chegam e dá HTTP 403 / código 42501).
