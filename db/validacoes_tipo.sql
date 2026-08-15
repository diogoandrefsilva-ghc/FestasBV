-- =====================================================================
-- FestasBV — Migração: validacoes.tipo ('contas' | 'presencas')
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql.
--
-- O QUE É: a tabela `validacoes` só sabia validar uma coisa — as contas
-- apuradas, e só depois de fechadas. Passa a haver um SEGUNDO check, as
-- PRESENÇAS (as refeições do próprio membro e dos convidados que ele
-- trouxe), disponível a qualquer momento, sem esperar pelo fecho.
--
-- É a MESMA tabela e o MESMO mecanismo — quem pode validar o quê não muda:
-- cada amigo valida por si e pelo cônjuge (`meu_amigo`); o admin, também
-- pelos amigos sem utilizador. A única coisa nova é a coluna `tipo`, que
-- distingue as duas linhas que agora podem existir para o mesmo amigo no
-- mesmo ano — uma por check.
--
-- Linhas antigas (todas anteriores a esta migração) só podiam ser da
-- validação de contas — por isso `tipo` nasce com DEFAULT 'contas' e não
-- 'presencas': sem isto, todo o histórico de validações já feitas passava
-- a ler-se como se fosse de presenças, o que é falso.
--
-- A unique constraint (evento_id, amigo) tinha de mudar para
-- (evento_id, amigo, tipo): sem isso um amigo não podia ter as duas
-- validações no mesmo ano — a segunda a gravar rebentava a primeira.
--
-- Sem esta migração a app funciona à mesma: VAL_TIPO_COL=false, a
-- Validação de Presenças fica escondida e a Validação de Contas continua
-- exatamente como sempre foi (a `tipo` nunca é escrita nem pedida).
--
-- RLS: as policies de `validacoes` (policies.sql) são por LINHA e olham
-- só para `amigo`/`validado_por_email` — não sabem que `tipo` existe e não
-- precisam de mudar; a coluna nova já fica coberta por elas.
-- =====================================================================

ALTER TABLE festasbv.validacoes
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'contas';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.validacoes'::regclass
      AND conname  = 'validacoes_tipo_check'
  ) THEN
    ALTER TABLE festasbv.validacoes
      ADD CONSTRAINT validacoes_tipo_check CHECK (tipo IN ('contas','presencas'));
  END IF;
END $$;

-- A UNIQUE antiga (evento_id, amigo) só permitia UMA validação por amigo e
-- ano; troca-se pela mesma ideia com o tipo a bordo, para caberem as duas.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.validacoes'::regclass
      AND conname  = 'validacoes_evento_id_amigo_key'
  ) THEN
    ALTER TABLE festasbv.validacoes
      DROP CONSTRAINT validacoes_evento_id_amigo_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.validacoes'::regclass
      AND conname  = 'validacoes_evento_id_amigo_tipo_key'
  ) THEN
    ALTER TABLE festasbv.validacoes
      ADD CONSTRAINT validacoes_evento_id_amigo_tipo_key UNIQUE (evento_id, amigo, tipo);
  END IF;
END $$;
