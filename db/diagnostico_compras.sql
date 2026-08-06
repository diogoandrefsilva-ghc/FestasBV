-- DIAGNÓSTICO (db/diagnostico_compras.sql) — SÓ LEITURA, não altera nada.
--
-- A invariante que se está a verificar: numa compra registada com artigos, o
-- valor dos lotes de stock entra nas despesas numa ÚNICA linha, de tipo
-- 'Gerais' e com as observações '🧺 Stock'. Logo, para cada compra:
--
--     essa linha  ==  soma de festasbv.stock_lotes.valor da mesma compra
--
-- Quando não bate, a compra lançou dinheiro que não tem artigos por baixo (ou
-- ao contrário) — que é o que o aviso vermelho do detalhe da compra apanha.


-- ─────────────────────────────────────────────────────────────────────────
-- 1) RECONCILIAÇÃO POR COMPRA (as que não batem aparecem primeiro)
-- ─────────────────────────────────────────────────────────────────────────
with ev as (
  select id from festasbv.eventos order by ano desc, id desc limit 1
),
d as (
  select compra_id,
         min(descricao)  as loja,
         min(data_desp)  as data,
         round(sum(valor), 2) as total_despesas,
         round(coalesce(sum(valor) filter (where observacoes = '🧺 Stock'), 0), 2) as linha_stock
  from festasbv.despesas
  where evento_id = (select id from ev) and compra_id is not null
  group by compra_id
),
s as (
  select compra_id,
         count(*) as n_lotes,
         round(sum(valor), 2) as total_lotes
  from festasbv.stock_lotes
  where evento_id = (select id from ev) and compra_id is not null
  group by compra_id
)
select coalesce(d.compra_id, s.compra_id) as compra_id,
       d.loja, d.data,
       d.total_despesas,
       d.linha_stock,
       s.n_lotes,
       s.total_lotes,
       round(coalesce(d.linha_stock, 0) - coalesce(s.total_lotes, 0), 2) as descasa
from d
full outer join s on s.compra_id = d.compra_id
order by abs(round(coalesce(d.linha_stock, 0) - coalesce(s.total_lotes, 0), 2)) desc,
         d.data desc nulls last;


-- ─────────────────────────────────────────────────────────────────────────
-- 2) OS LOTES DAS BATATAS FRITAS — em que compra está cada um
-- ─────────────────────────────────────────────────────────────────────────
select s.id,
       s.compra_id,
       s.artigo,
       s.lista_artigo,
       s.qtd,
       s.valor,
       s.criado_em,
       (select min(d.descricao) from festasbv.despesas d
         where d.compra_id = s.compra_id) as compra_existe_com_descritivo
from festasbv.stock_lotes s
where s.evento_id = (select id from festasbv.eventos order by ano desc, id desc limit 1)
  and (s.artigo ilike '%bat%' or s.lista_artigo ilike '%batata%')
order by s.criado_em, s.artigo;


-- ─────────────────────────────────────────────────────────────────────────
-- 3) ÓRFÃOS NOS DOIS SENTIDOS
--    A. lotes cuja compra já não tem despesas nenhumas (a compra foi apagada
--       mas os lotes ficaram — apagar despesas e apagar lotes são dois passos
--       e o segundo pode ter falhado);
--    B. compras com linha '🧺 Stock' mas sem lote nenhum (o inverso).
-- ─────────────────────────────────────────────────────────────────────────
select 'A · lotes sem compra' as caso,
       s.compra_id,
       count(*)::text          as n,
       round(sum(s.valor), 2)::text as eur
from festasbv.stock_lotes s
where s.evento_id = (select id from festasbv.eventos order by ano desc, id desc limit 1)
  and s.compra_id is not null
  and not exists (select 1 from festasbv.despesas d where d.compra_id = s.compra_id)
group by s.compra_id

union all

select 'B · compra sem lotes' as caso,
       d.compra_id,
       count(*)::text,
       round(sum(d.valor), 2)::text
from festasbv.despesas d
where d.evento_id = (select id from festasbv.eventos order by ano desc, id desc limit 1)
  and d.observacoes = '🧺 Stock'
  and not exists (select 1 from festasbv.stock_lotes s where s.compra_id = d.compra_id)
group by d.compra_id;
