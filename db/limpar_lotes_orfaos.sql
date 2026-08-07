-- LIMPEZA (db/limpar_lotes_orfaos.sql) — arrumação, não correção de contas.
--
-- ÓRFÃO = lote de stock cuja compra já não tem despesa nenhuma. Nasce de uma
-- compra apagada em que o segundo passo falhou: `deleteCompra` apagava primeiro
-- as despesas e só depois os lotes, sem transação a uni-los. (A partir da v240
-- a ordem é a inversa, precisamente para o destroço de uma falha ser o visível.)
--
-- NÃO MEXEM NAS CONTAS, e convém saber-se antes de mexer:
--   · `aplicarStock` procura a linha '🧺 Stock' da compra e, não a achando,
--     salta o lote — "compra apagada → lotes órfãos não contam";
--   · `stockBacked` exclui-os do separador 🧺 Stock, das coberturas e das
--     dicas da lista de compras.
-- São entulho invisível. Apagá-los é higiene, não urgência.
--
-- NÃO SÃO ÓRFÃOS os `x-oferta-*` e `x-anterior-*`: stock oferecido e sobras do
-- ano passado existem de propósito sem compra (loteSemCompra), contam para as
-- refeições e TÊM de ficar. Por isso o filtro exclui o prefixo `x-`.


-- ─────────────────────────────────────────────────────────────────────────
-- 1) VER PRIMEIRO — o que seria apagado, artigo a artigo
-- ─────────────────────────────────────────────────────────────────────────
select s.id, s.compra_id, s.artigo, s.lista_artigo, s.qtd, s.unidade, s.valor,
       jsonb_array_length(coalesce(s.alocacoes, '[]'::jsonb)) as n_alocacoes,
       s.criado_em
from festasbv.stock_lotes s
where s.evento_id = (select id from festasbv.eventos order by ano desc, id desc limit 1)
  and s.compra_id is not null
  and s.compra_id not like 'x-%'
  and not exists (select 1 from festasbv.despesas d where d.compra_id = s.compra_id)
order by s.criado_em, s.id;


-- ─────────────────────────────────────────────────────────────────────────
-- 2) APAGAR — só depois de olhar para a lista de cima
-- ─────────────────────────────────────────────────────────────────────────
delete from festasbv.stock_lotes s
where s.evento_id = (select id from festasbv.eventos order by ano desc, id desc limit 1)
  and s.compra_id is not null
  and s.compra_id not like 'x-%'
  and not exists (select 1 from festasbv.despesas d where d.compra_id = s.compra_id);


-- ─────────────────────────────────────────────────────────────────────────
-- 3) CONFIRMAR — deve devolver zero linhas
-- ─────────────────────────────────────────────────────────────────────────
select count(*) as orfaos_restantes
from festasbv.stock_lotes s
where s.evento_id = (select id from festasbv.eventos order by ano desc, id desc limit 1)
  and s.compra_id is not null
  and s.compra_id not like 'x-%'
  and not exists (select 1 from festasbv.despesas d where d.compra_id = s.compra_id);
