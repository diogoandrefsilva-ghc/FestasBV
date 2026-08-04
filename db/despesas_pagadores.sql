-- =====================================================================
-- FestasBV — Migração: Despesa paga por VÁRIOS (festasbv.despesas.grupo_pag)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql (despesas).
-- Ordem: schema.sql -> functions.sql -> policies.sql -> ESTE (a qualquer altura).
--
-- O QUE É: às compras vão dois, e às vezes o dinheiro sai de dois bolsos —
-- "o João pôs 60, eu pus 40". Até aqui uma despesa tinha um dono só (`quem`),
-- e a única saída era registar duas despesas soltas com a mesma descrição.
--
-- O MODELO NÃO MUDA: continua a haver UMA LINHA POR PAGADOR, com o valor que
-- ESSE pagador pôs. É o que as contas precisam — o calcular() filtra as
-- despesas por `quem` para saber quanto cada um adiantou do bolso — e é a
-- verdade: saiu dinheiro de dois sítios. O que esta coluna acrescenta é dizer
-- que essas linhas são A MESMA DESPESA:
--
--   · nos Cash Flows aparecem num cartão só (um movimento, o valor da soma),
--     com a repartição "quem pagou" por baixo;
--   · editam-se e apagam-se juntas — mudar a data ou o tipo muda-o em todas;
--   · nada disto toca no calcular(), nos saldos ou nas quotas: são despesas
--     normais, como sempre foram.
--
-- O token é gerado pela app ('p' + timestamp), como o compra_id da lista de
-- compras. Uma despesa de um pagador só tem grupo_pag NULL — é o caso normal.
--
-- NÃO precisa de policies novas: a coluna vive na tabela `despesas`, que já
-- tem as suas (despesas_sel/despesas_admin/despesas_self_ins). Continua a
-- valer que um não-admin só insere linhas em nome dele ou do cônjuge — com
-- vários pagadores, a regra aplica-se a CADA linha.
--
-- Sem esta migração a app funciona à mesma: a sonda é tolerante
-- (DESP_GRUPO_COL=false), a opção "👥 Pagaram vários" fica escondida e a
-- coluna nunca é gravada.
-- =====================================================================

ALTER TABLE festasbv.despesas ADD COLUMN IF NOT EXISTS grupo_pag text;

COMMENT ON COLUMN festasbv.despesas.grupo_pag IS
  'Token partilhado pelas linhas da mesma despesa paga por várias pessoas (uma linha por pagador). NULL = despesa de um pagador só.';

-- A app lê o ano todo de uma vez e agrupa em memória; o índice é para as
-- consultas à mão (e é barato — a coluna é NULL na esmagadora maioria).
CREATE INDEX IF NOT EXISTS despesas_grupo_pag_idx
  ON festasbv.despesas (grupo_pag) WHERE grupo_pag IS NOT NULL;
