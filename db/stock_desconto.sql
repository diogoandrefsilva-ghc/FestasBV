-- =====================================================================
-- FestasBV — Migração: Desconto num lote de stock (stock_lotes.desconto_*)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: stock.sql.
-- Ordem: schema.sql -> functions.sql -> policies.sql -> shoplist.sql ->
--        stock.sql -> ESTE.
--
-- O PORQUÊ: uma fatura (a da cerveja e sangria, por exemplo) vem muitas vezes
-- com um desconto — e o desconto pode querer dizer três coisas diferentes:
--
--   1) 'preco'   — o desconto baixa o PREÇO do artigo, a sério, para toda a
--                  gente (membros e convidados) em todas as refeições onde
--                  ele entra. É o caso normal: regista-se o valor já líquido
--                  e não precisa desta coluna para nada — `desconto_valor`
--                  fica só de nota (para não se esquecer que houve desconto).
--   2) 'membros' — o preço da refeição mantém-se ao preço de TABELA (sem
--                  desconto) para todos, membros e convidados; só que no
--                  fecho de contas os MEMBROS recuperam a sua parte do
--                  desconto (proporcional ao que consumiram) — convidados,
--                  não.
--   3) 'grupo'   — o preço mantém-se de tabela para todos (membros e
--                  convidados), e o desconto fica por cobrar a ninguém — é
--                  sobra do grupo (`saldoGrupo`), exatamente como já
--                  acontece com o desconto de uma fatura de t-shirts.
--
-- O QUE ESTAS COLUNAS SÃO: `desconto_valor` é a DISTÂNCIA entre o preço de
-- tabela e o que se pagou de facto — `stock_lotes.valor` continua a ser
-- sempre o que saiu da carteira (é ele que fecha com a despesa e entra no
-- totalDesp, sem exceção nenhuma). `desconto_modo` diz o que fazer com essa
-- distância. NULL/'preco' = nada a fazer (o valor já é o preço a sério).
--
-- Declara-se POR LOTE (a cerveja e a sangria da mesma fatura podem ter
-- descontos diferentes, ou só uma delas ter desconto nenhum) — a mesma
-- granularidade da 2.ª medida e da cobertura. Não se grava no editor da
-- compra: o desconto é uma leitura sobre o que já está comprado.
--
-- Sem esta migração a app funciona à mesma: a sonda é tolerante
-- (STOCK_DESC_COLS=false), as colunas nunca são lidas nem escritas e o preço
-- é sempre o gravado em `valor`, como sempre foi.
-- =====================================================================

ALTER TABLE festasbv.stock_lotes
  ADD COLUMN IF NOT EXISTS desconto_valor numeric,
  ADD COLUMN IF NOT EXISTS desconto_modo  text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='festasbv.stock_lotes'::regclass AND conname='stock_lotes_desconto_modo_check'
  ) THEN
    ALTER TABLE festasbv.stock_lotes
      ADD CONSTRAINT stock_lotes_desconto_modo_check
      CHECK (desconto_modo IS NULL OR desconto_modo IN ('preco','membros','grupo'));
  END IF;
END $$;

COMMENT ON COLUMN festasbv.stock_lotes.desconto_valor IS
  'Distância entre o preço de tabela e o que se pagou (stock_lotes.valor). NULL/0 = sem desconto declarado.';
COMMENT ON COLUMN festasbv.stock_lotes.desconto_modo IS
  'preco = já está no valor, sem efeito nenhum no cálculo (nota só) · membros = preço de tabela para todos, membros recuperam a sua parte no fecho · grupo = preço de tabela para todos, o desconto fica de sobra no saldoGrupo. NULL = como ''preco''.';

-- Sem policies novas: a coluna vive na stock_lotes e herda as dela (ver
-- stock.sql). Quem pode mexer nas alocações pode declarar o desconto — é a
-- mesma gestão de stock, e a app limita-a ao admin na UI pela mesma razão.
