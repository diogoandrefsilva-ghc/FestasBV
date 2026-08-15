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
6. `categorias.sql` — categorias de artigos (`categorias` + `artigo_categorias`,
   globais/sem evento); alimentam os agrupadores no Stock/Compras e o prompt
   da AI no `fatura-ocr`
7. `notifs.sql` — responsáveis das refeições + avisos Telegram
8. `filhos.sql` — filhos dos membros (`filhos` + `filho_presencas`) e
   `convidados.crianca`; crianças não pagam, só contam bocas
9. `convidados_acompanhantes.sql` — `convidados.adultos` / `.criancas`: uma linha
   de convidado pode valer várias bocas ("levo 5 comigo"), sem se inventarem
   nomes; só os adultos pagam quota
10. `tshirts.sql` — encomenda de t-shirts (`tshirt_tamanhos` globais + `tshirts`
    por evento); levantamento de pedidos, não mexe em nenhuma conta
11. `tshirts_imputacao.sql` — `tshirts.imputado_a`: a quem se cobra cada t-shirt
    (um ou vários membros, em partes iguais). Vazio = quem pediu. Só o admin
    imputa — garantido por trigger, não só pelo RLS
12. `tshirts_trancar.sql` — `eventos.tshirts_trancadas`: fechar a encomenda do
    ano. Trancada, só o admin acrescenta/edita/remove t-shirts (as policies
    "self" passam a exigir `tshirts_abertas()`)
13. `pagamentos_pendentes.sql` — caixa de entrada dos pagamentos de dívida
    declarados pelos membros. Ficam à espera; quando o admin valida, a app
    cria o cash-flow em `pagamentos`. Enquanto esperam não entram em conta
    nenhuma
14. `tshirts_cashflow.sql` — `eventos.tshirt_preco_homem/mulher/crianca` +
    `tshirt_desconto`: a fatura das t-shirts passa a entrar nas contas. Cada
    t-shirt é cobrada a quem lhe está imputada, ao preço da tipologia; o
    desconto fica como crédito do MEO

15. `despesas_pagadores.sql` — `despesas.grupo_pag`: uma despesa pode ter sido
    paga por várias pessoas. Continua a ser uma linha por pagador (é o que as
    contas leem); o token diz que são a mesma despesa, para aparecerem num
    cartão só e se editarem/apagarem juntas
16. `stock_consumo.sql` — `stock_lotes.consumido`: o 2.º eixo do stock. A
    *alocação* diz para onde vai o custo, o *consumo* diz o que já se gastou.
    `NULL` = derivar das refeições que já passaram (o comportamento de sempre);
    número = dito à mão. **Não entra em conta nenhuma** — é leitura de despensa
17. `despensa.sql` — `artigos_despensa`: os artigos que **não se esgotam** por
    alocação (sal, pimenta, louro). Uma embalagem serve o evento todo, por isso
    neles a derivação do consumo desliga-se e vale um interruptor: ainda há /
    acabou. Marca global por nome normalizado, como as categorias
18. `convidados_bebe.sql` — `convidados.modo` + `refeicoes_def.min_conv_bebe` /
    `.extra_conv_bebe`: o convidado que **só vem ao copo**. Não conta como boca
    na cozinha e paga quota **própria** — o que o membro que só bebe paga,
    arredondado para cima, mais um extra e nunca abaixo de um mínimo. Depende
    de `convidados_acompanhantes.sql` (a restrição "linha de bebida é só de
    adultos" precisa da coluna `criancas`)
19. `stock_equivalencia.sql` — `stock_lotes.qtd_equiv` / `.unidade_equiv`: a
    **2.ª medida** de um lote, o mesmo stock contado de outra maneira (os
    4,032 kg de acém que são 9 bifes). Declarada por quem arrumou as compras — a app **nunca** adivinha uma
    conversão —, é ela que deixa alocar e dar baixa a contar peças. As alocações
    continuam a gravar-se na unidade da compra: **não entra em conta nenhuma**

20. `stock_alocacao_original.sql` — `stock_lotes.aloc_original`: **para que é que
    o lote foi comprado**, à parte de **de quem é o custo hoje** (`alocacoes`).
    Comprei 9 bifes para o jantar de sábado, sobraram 2 e foram para o almoço de
    domingo: o custo vai com eles e o objetivo da compra não se apaga. O editor
    da compra escreve o objetivo, o separador Stock escreve o custo, e `NULL`
    (lotes anteriores) = objetivo desconhecido. **Não entra em conta nenhuma**
21. `validacoes_tipo.sql` — `validacoes.tipo` ('contas' | 'presencas'): um
    segundo check, ao lado da validação de contas — as PRESENÇAS (as
    refeições do próprio membro e dos convidados que trouxe). Espera só pela
    ÚLTIMA REFEIÇÃO, não pelo fecho de contas: ninguém valida a meio das
    festas, enquanto as presenças ainda podem mudar. Mesma tabela, mesmo
    mecanismo (cada amigo valida por si e pelo cônjuge); linhas antigas
    nascem `tipo='contas'` por DEFAULT, para não reescrever o histórico

Os passos 4–21 são migrações add-on idempotentes: correr uma vez cada. A app é
tolerante a qualquer uma delas faltar — sonda a coluna/tabela e esconde o que
ainda não existe. (Há mais add-ons no diretório que nunca entraram nesta lista —
`cobertura.sql`, `bebida_refeicao.sql`, `stock_artigo_fatura.sql`,
`admin_pass_temp.sql`, `frac_indireta_ref.sql` — e valem a mesma regra:
idempotentes e opcionais.)

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
| T-shirts (encomendar/editar/remover)          | ✅ sempre | ✅ próprias + cônjuge                   | ❌               |
| Tamanhos e preços das t-shirts                | ✅        | ❌                                     | ❌               |
| Imputar a t-shirt à conta de membros          | ✅        | ❌ (trigger recusa)                    | ❌               |
| Trancar/reabrir a encomenda de t-shirts       | ✅        | ❌                                     | ❌               |
| Fatura das t-shirts (preços + desconto)       | ✅        | ❌                                     | ❌               |
| Validar contas/presenças (`validacoes`)       | ✅        | ✅ próprias + cônjuge                   | ❌               |
| Editar/apagar cash-flows                      | ✅        | ❌                                     | ❌               |
| Mealheiros, reembolsos, pagamentos            | ✅        | ❌                                     | ❌               |
| Registar pagamento de dívida (a validar)      | ✅ direto | ✅ próprios + cônjuge, fica pendente    | ❌               |
| Validar/rejeitar pagamentos pendentes         | ✅        | ❌ (só cancelar os seus)               | ❌               |
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
