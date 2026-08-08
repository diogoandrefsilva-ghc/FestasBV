-- =====================================================================
-- FestasBV — Migração: convidados que SÓ BEBEM
-- festasbv.convidados.modo + festasbv.refeicoes_def.min_conv_bebe/.extra_conv_bebe
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql -> filhos.sql
--             -> convidados_acompanhantes.sql
--
-- O QUE É: um membro já podia vir só ao copo ('bebe' nas presenças). Um
-- convidado não — ou comia, ou não existia. Passa a poder: a linha do
-- convidado diz o que vem fazer.
--
--   modo = 'come'  (defeito, e é o que todas as linhas antigas são)
--          'bebe'  só veio ao copo — não conta como boca na cozinha e
--                  paga a quota de bebida, não a da refeição.
--
-- PREÇO: o convidado que só bebe NÃO paga o mesmo que o membro que só
-- bebe — é o ponto de toda esta migração. O membro paga o custo
-- (bebida + indiretos da refeição, sem mínimo); o convidado paga esse
-- custo arredondado para cima MAIS um extra, e nunca abaixo de um
-- mínimo. É a mesma forma da quota do convidado que come
-- (min_conv / extra_conv), com parâmetros PRÓPRIOS por refeição:
--
--   Qbebe = max(min_conv_bebe, arredonda_p_cima(Pbebe) + extra_conv_bebe)
--
-- As colunas nascem a ZERO de propósito: ninguém sabe por ti quanto é
-- que um copo vale nesta festa. Enquanto estiverem a zero, o convidado
-- que só bebe paga o custo arredondado para cima e mais nada — o admin
-- põe o extra e o mínimo em cada refeição (Refeições › toca na refeição).
--
-- Sem esta migração a app funciona à mesma: as sondas falham,
-- CONV_BEBE_COLS=false, a opção "só bebe" do convidado fica escondida e
-- nunca se grava nada — como era antes.
--
-- RLS: as políticas de festasbv.convidados e festasbv.refeicoes_def
-- (policies.sql) são por LINHA, não por coluna, por isso as colunas
-- novas já ficam cobertas.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) O que o convidado vem fazer
-- ---------------------------------------------------------------------
ALTER TABLE festasbv.convidados
  ADD COLUMN IF NOT EXISTS modo text NOT NULL DEFAULT 'come';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.convidados'::regclass
      AND conname  = 'convidados_modo_check'
  ) THEN
    ALTER TABLE festasbv.convidados
      ADD CONSTRAINT convidados_modo_check CHECK (modo IN ('come','bebe'));
  END IF;
END $$;

-- Uma criança ou come ou não conta — não há "só bebe" (é a mesma regra
-- dos filhos dos membros, cuja linha de presença nem tem coluna `modo`).
-- Por isso uma linha de convidado que só bebe é só de adultos.
-- Só se cria a restrição se a coluna `criancas` já existir
-- (convidados_acompanhantes.sql); sem ela não há nada a restringir.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'festasbv' AND table_name = 'convidados'
      AND column_name = 'criancas'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.convidados'::regclass
      AND conname  = 'convidados_bebe_sem_criancas_check'
  ) THEN
    ALTER TABLE festasbv.convidados
      ADD CONSTRAINT convidados_bebe_sem_criancas_check
      CHECK (modo <> 'bebe' OR criancas = 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2) Quanto custa o copo ao convidado, refeição a refeição
-- ---------------------------------------------------------------------
ALTER TABLE festasbv.refeicoes_def
  ADD COLUMN IF NOT EXISTS min_conv_bebe   numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_conv_bebe numeric(10,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.refeicoes_def'::regclass
      AND conname  = 'refeicoes_def_conv_bebe_check'
  ) THEN
    ALTER TABLE festasbv.refeicoes_def
      ADD CONSTRAINT refeicoes_def_conv_bebe_check
      CHECK (min_conv_bebe >= 0 AND extra_conv_bebe >= 0);
  END IF;
END $$;
