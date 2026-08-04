-- =====================================================================
-- FestasBV — Migração: a fatura das t-shirts entra nas contas
-- (preços por tipologia + desconto, em festasbv.eventos)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql -> tshirts.sql
--             -> tshirts_imputacao.sql.
--
-- O QUE É: até aqui as t-shirts eram só levantamento. Passam a ser dinheiro.
--
--   PREÇO POR TIPOLOGIA — Homem, Mulher e Criança. É este valor que vai ao
--   saldo de cada membro, t-shirt a t-shirt, segundo a imputação
--   (`tshirts.imputado_a`; vazio = conta de quem pediu).
--
--   DESCONTO — o que o fornecedor tirou à fatura. NÃO se abate a ninguém em
--   particular: os membros pagam o preço de tabela e a diferença fica como
--   saldo credor do MEO (entra no resultado do grupo e alivia a quota extra
--   de todos). É por isso que o desconto não aparece em conta nenhuma
--   individual — só na diferença entre o que se cobrou e o que se pagou.
--
--   A FATURA em si é um cash-flow normal: uma linha em `despesas` com
--   `tipo = 'T-shirts'` e `quem` = a pessoa que adiantou o dinheiro. Não
--   precisa de coluna nova (despesas.tipo é texto livre).
--
-- CONTAS (é isto que o calcular() faz):
--   cobrado  = Σ preço da tipologia de cada t-shirt, repartido pela imputação
--   pago     = Σ despesas de tipo 'T-shirts'
--   crédito do MEO = cobrado − pago  (= o desconto, quando bate certo)
-- A despesa das t-shirts fica FORA do rateio indireto das refeições e fora
-- da base da quota extra — senão o dinheiro das t-shirts espalhava-se por
-- toda a gente pela fórmula das quotas, que é exatamente o que não se quer.
--
-- Só o admin mexe nisto: `eventos` já só aceita escrita de is_admin()
-- (policy eventos_admin), por isso não é preciso trigger nenhum.
--
-- Sem esta migração a app funciona à mesma: sonda as colunas
-- (TS_CF_COLS=false), o cash-flow de t-shirts fica escondido e as t-shirts
-- continuam a não entrar em conta nenhuma.
-- =====================================================================

ALTER TABLE festasbv.eventos
  ADD COLUMN IF NOT EXISTS tshirt_preco_homem   numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tshirt_preco_mulher  numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tshirt_preco_crianca numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tshirt_desconto      numeric(10,2) NOT NULL DEFAULT 0;

-- Preços e desconto não são negativos (o desconto guarda-se em positivo)
ALTER TABLE festasbv.eventos DROP CONSTRAINT IF EXISTS eventos_tshirt_valores_check;
ALTER TABLE festasbv.eventos
  ADD CONSTRAINT eventos_tshirt_valores_check CHECK (
        tshirt_preco_homem   >= 0
    AND tshirt_preco_mulher  >= 0
    AND tshirt_preco_crianca >= 0
    AND tshirt_desconto      >= 0);
