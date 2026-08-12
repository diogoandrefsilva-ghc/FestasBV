-- =====================================================================
-- FestasBV — Migração: fração parametrizável da bolsa indireta alocada
-- às refeições (festasbv.eventos.frac_indireta_ref)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql.
--
-- O QUE É: das despesas que não são diretas de uma refeição (Gerais,
-- Bebidas, Cerveja, Renda, …) — a "bolsa indireta" —, só uma fração
-- entra no preço de cada refeição (F20); o resto é recuperado depois
-- pela Quota Extra, repartida por todos os membros pelo fator. Essa
-- fração estava fixa em 50% no código; passa a ser parametrizável por
-- ano em Definições › Parametrizações.
--
-- T-shirts e Stock Sobrante NÃO SÃO TOCADOS por esta fração — já saíam
-- da bolsa indireta antes de qualquer percentagem se aplicar (são
-- cobrados à parte, a quem lhes está imputado) e continuam a sair.
--
-- SÓ EM ANOS ABERTOS: a app impede o ajuste (campo desativado) quando
-- `contas_fechadas` é verdadeiro. É uma trava do lado do cliente, como a
-- Missão Poupança e o Fundo de Reserva — só o admin escreve em `eventos`
-- (policy eventos_admin, FOR ALL), por isso não é preciso trigger para
-- proteger a própria coluna.
--
-- Sem esta migração a app funciona à mesma: sonda a coluna
-- (FRAC_INDIRETA_REF_COL=false), o campo fica escondido e o cálculo usa
-- sempre 50%, como sempre foi.
-- =====================================================================

ALTER TABLE festasbv.eventos
  ADD COLUMN IF NOT EXISTS frac_indireta_ref numeric NOT NULL DEFAULT 0.5;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.eventos'::regclass
      AND conname  = 'eventos_frac_indireta_ref_check'
  ) THEN
    ALTER TABLE festasbv.eventos
      ADD CONSTRAINT eventos_frac_indireta_ref_check
      CHECK (frac_indireta_ref >= 0 AND frac_indireta_ref <= 1);
  END IF;
END $$;

COMMENT ON COLUMN festasbv.eventos.frac_indireta_ref IS
  'Fração (0–1) da bolsa indireta (Gerais/Bebidas/Cerveja/…) alocada ao preço das refeições. O resto é recuperado pela Quota Extra. Defeito 0.5 (50%, o comportamento de sempre). T-shirts e Stock Sobrante nunca entram nesta bolsa.';
