-- =====================================================================
-- FestasBV — Migração: convidados que levam gente sem nome
-- ("levo 5 comigo") -> festasbv.convidados.adultos / .criancas
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql -> filhos.sql.
--
-- O QUE É: às vezes um convidado traz gente cujo nome não se sabe. Em vez
-- de se inventarem linhas ("Amigo do João 1", "Amigo do João 2", …),
-- regista-se UMA linha com o nome de quem se conhece e diz-se de quantas
-- bocas ela é feita, separando quem paga de quem não paga:
--
--   adultos   quantos adultos a linha vale, o próprio incluído quando é
--             adulto (1 = vem só ele; 3 = ele + 2 adultos sem nome).
--   criancas  quantas crianças vêm agarradas à mesma linha.
--
-- Contas: cada ADULTO come e, se a linha for pagante, paga a quota de
-- convidado da refeição (a app multiplica por aqui — não há linhas extra).
-- As CRIANÇAS comem mas não pagam nada, tal como os filhos dos membros:
-- entram só na contagem de bocas (compras, cozinha, mesas).
--
-- O flag `crianca` (de filhos.sql) mantém-se e passa a ser derivado:
-- fica true quando a linha não tem adultos nenhuns, ou seja, quando o
-- convidado que dá nome à linha é ele próprio uma criança.
--
-- Sem esta migração a app funciona à mesma: a sonda às colunas falha,
-- CONV_AC_COLS=false, os campos ficam escondidos e cada convidado vale
-- uma pessoa (adulto ou criança, conforme o flag) — como era antes.
--
-- RLS: as políticas de festasbv.convidados (policies.sql) são por linha,
-- não por coluna, por isso as colunas novas já ficam cobertas.
-- =====================================================================

ALTER TABLE festasbv.convidados
  ADD COLUMN IF NOT EXISTS adultos  integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS criancas integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------
-- Backfill. Duas origens possíveis:
--   a) já se correu a 1ª versão desta migração, que criou `pessoas`
--      (nº de bocas da linha, todas do mesmo tipo) -> reparte-se por
--      adultos/crianças conforme o flag `crianca` e larga-se a coluna;
--   b) nunca houve `pessoas` -> cada linha vale 1 boca, e as que têm
--      crianca=true passam a 0 adultos + 1 criança.
-- ---------------------------------------------------------------------
DO $$
DECLARE tem_pessoas boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'festasbv' AND table_name = 'convidados'
      AND column_name = 'pessoas'
  ) INTO tem_pessoas;

  IF tem_pessoas THEN
    EXECUTE $q$
      UPDATE festasbv.convidados
         SET adultos  = CASE WHEN crianca THEN 0 ELSE GREATEST(COALESCE(pessoas, 1), 1) END,
             criancas = CASE WHEN crianca THEN GREATEST(COALESCE(pessoas, 1), 1) ELSE 0 END
    $q$;
    ALTER TABLE festasbv.convidados DROP COLUMN pessoas;
  ELSE
    -- Só as que ainda estão no default (adultos=1, criancas=0): assim
    -- correr isto outra vez não estraga o que já foi editado na app.
    UPDATE festasbv.convidados
       SET adultos = 0, criancas = 1
     WHERE crianca AND adultos = 1 AND criancas = 0;
  END IF;
END $$;

-- Uma linha vale sempre pelo menos uma boca, e não há bocas negativas.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.convidados'::regclass
      AND conname  = 'convidados_bocas_check'
  ) THEN
    ALTER TABLE festasbv.convidados
      ADD CONSTRAINT convidados_bocas_check
      CHECK (adultos >= 0 AND criancas >= 0 AND adultos + criancas >= 1);
  END IF;
END $$;
