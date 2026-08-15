-- =====================================================================
-- FestasBV — Migração: validacoes.tipo ('contas' | 'presencas' | 'convidados')
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql.
--
-- O QUE É: a tabela `validacoes` só sabia validar uma coisa — as contas
-- apuradas, e só depois de fechadas. Ganha DOIS checks novos: as PRESENÇAS
-- (as refeições do próprio membro) e os CONVIDADOS (os que ele trouxe) —
-- separados porque vivem em sítios diferentes da app (Presenças e
-- Convidados, respetivamente), não numa lista à parte nos Saldos. Os três
-- esperam a mesma coisa antes de se poderem validar: presenças/convidados
-- a última refeição (podem mudar até lá); contas, o fecho.
--
-- É a MESMA tabela e o MESMO mecanismo — quem pode validar o quê não muda:
-- cada amigo valida por si e pelo cônjuge (`meu_amigo`); o admin, também
-- pelos amigos sem utilizador. A única coisa nova é a coluna `tipo`, que
-- distingue as linhas que agora podem existir para o mesmo amigo no mesmo
-- ano — uma por check.
--
-- Linhas antigas (todas anteriores a esta migração) só podiam ser da
-- validação de contas — por isso `tipo` nasce com DEFAULT 'contas' e não
-- outra coisa: sem isto, todo o histórico de validações já feitas passava
-- a ler-se como se fosse de presenças/convidados, o que é falso.
--
-- A unique constraint (evento_id, amigo) tinha de mudar para
-- (evento_id, amigo, tipo): sem isso um amigo não podia ter mais do que
-- uma validação no mesmo ano — a segunda a gravar rebentava a primeira.
--
-- Sem esta migração a app funciona à mesma: VAL_TIPO_COL=false, os checks
-- de Presenças/Convidados ficam escondidos e o de Contas continua
-- exatamente como sempre foi (a `tipo` nunca é escrita nem pedida).
--
-- RLS: as policies de `validacoes` (policies.sql) são por LINHA e olham
-- só para `amigo`/`validado_por_email` — não sabem que `tipo` existe e não
-- precisam de mudar; a coluna nova já fica coberta por elas.
-- =====================================================================

ALTER TABLE festasbv.validacoes
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'contas';

-- O CHECK compara-se pela DEFINIÇÃO, não só pelo nome: quem já tinha corrido
-- esta migração antes de existir 'convidados' fica com um constraint que só
-- deixa 'contas'/'presencas' — sem recriar, 'convidados' nunca entrava.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.validacoes'::regclass
      AND conname  = 'validacoes_tipo_check'
      AND pg_get_constraintdef(oid) = $q$CHECK ((tipo = ANY (ARRAY['contas'::text, 'presencas'::text, 'convidados'::text])))$q$
  ) THEN
    ALTER TABLE festasbv.validacoes DROP CONSTRAINT IF EXISTS validacoes_tipo_check;
    ALTER TABLE festasbv.validacoes
      ADD CONSTRAINT validacoes_tipo_check CHECK (tipo IN ('contas','presencas','convidados'));
  END IF;
END $$;

-- A UNIQUE antiga (evento_id, amigo) só permitia UMA validação por amigo e
-- ano; troca-se pela mesma ideia com o tipo a bordo, para caberem as três.
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
