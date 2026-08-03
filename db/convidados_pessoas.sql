-- =====================================================================
-- FestasBV — Migração: convidados que levam acompanhantes sem nome
-- ("levo 5 comigo") -> festasbv.convidados.pessoas
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql.
--
-- O QUE É: às vezes um convidado traz gente cujo nome não se sabe. Em vez
-- de se inventarem linhas ("Amigo do João 1", "Amigo do João 2", …),
-- regista-se UMA linha com o nome de quem se conhece e diz-se quantas
-- BOCAS essa linha vale.
--
--   pessoas = total de pessoas que aquela linha representa, o próprio
--             INCLUÍDO. 1 = vem só ele. 6 = ele + 5 acompanhantes.
--
-- Contas: cada uma das `pessoas` come e (se pagante) paga a quota de
-- convidado da refeição. A app multiplica por aqui — não há linhas extra.
-- Convidado-criança com pessoas > 1 continua a não pagar nada; só conta
-- bocas, como qualquer criança.
--
-- Sem esta migração a app funciona à mesma: a sonda à coluna falha,
-- CONV_PESSOAS_COL=false, o campo fica escondido e todo o convidado vale
-- 1 pessoa — exatamente como antes.
--
-- RLS: as políticas de festasbv.convidados (policies.sql) são por linha,
-- não por coluna, por isso a coluna nova já fica coberta. Nada a mudar.
-- =====================================================================

ALTER TABLE festasbv.convidados
  ADD COLUMN IF NOT EXISTS pessoas integer NOT NULL DEFAULT 1;

-- Uma linha vale sempre pelo menos uma boca (a do próprio).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.convidados'::regclass
      AND conname  = 'convidados_pessoas_check'
  ) THEN
    ALTER TABLE festasbv.convidados
      ADD CONSTRAINT convidados_pessoas_check CHECK (pessoas >= 1);
  END IF;
END $$;
