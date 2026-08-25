-- =====================================================================
-- FestasBV — Migração: a FASE do ano (festasbv.eventos.fase / _em / _por)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql
--             -> pagamentos_autorizados.sql
--
-- O QUE É: o fim do ano era contado por DOIS booleanos independentes
-- (`contas_fechadas` e `pagamentos_autorizados`), e isso já não chegava.
-- Dois booleanos dão quatro combinações para descrever cinco momentos, e
-- havia dois momentos que ficavam com EXATAMENTE o mesmo par de valores:
-- um ano em pagamento e um ano acabado — 2026 e 2025 — eram
-- indistinguíveis para a app. Passa a haver UMA coluna, com os cinco
-- momentos por ordem:
--
--   aberto        → o ano em curso: tudo se edita
--   val_presencas → as festas acabaram; cada um confirma as suas
--                   presenças e os seus convidados (ainda se corrigem)
--   val_contas    → o apuramento parou; ninguém mexe em presenças,
--                   convidados, despesas nem mealheiros. Confirmam-se as
--                   contas. NÃO SE PAGA AINDA.
--   pagamento     → contas dadas por validadas: o dinheiro pode andar
--   fechado       → acabou. Nem pagamentos se registam.
--
-- OS DOIS BOOLEANOS CONTINUAM A EXISTIR E A SER ESCRITOS pela app, em
-- sincronia com a fase (val_contas+ ⇒ contas_fechadas; pagamento+ ⇒
-- pagamentos_autorizados). Não são redundância por preguiça: são o que
-- um separador aberto com o app.js velho em cache continua a ler, e o que
-- as policies/funções do servidor podem vir a querer. A `fase` é que manda,
-- e a app deriva os dois predicados dela (contasFechadas / pagamentos-
-- Autorizados) — nunca ao contrário.
--
-- O BACKFILL é o que arruma o passado, e é onde a coluna nova ganha o que
-- os booleanos não sabiam dizer: um ano com pagamentos autorizados que JÁ
-- NÃO É o ano mais recente não está "em pagamento" — está acabado. É
-- assim que 2025 aterra em 'fechado' e 2026 em 'pagamento', que é o
-- estado real dos dois. O admin move qualquer um deles no slider dos
-- Saldos, se a regra não acertar num caso.
--
-- Só o admin escreve: `eventos` já só aceita escrita de is_admin()
-- (policy eventos_admin), por isso não é preciso trigger nenhum — a mesma
-- razão de db/tshirts_trancar.sql e db/pagamentos_autorizados.sql.
--
-- Sem esta migração a app funciona à mesma: sonda a coluna
-- (faseCol=false), a fase deriva-se dos dois booleanos como sempre
-- (aberto / val_contas / pagamento — 'val_presencas' e 'fechado' ficam
-- inalcançáveis) e o slider fica em leitura, com a nota a dizer que falta
-- correr este ficheiro.
-- =====================================================================

ALTER TABLE festasbv.eventos
  ADD COLUMN IF NOT EXISTS fase     text NOT NULL DEFAULT 'aberto',
  ADD COLUMN IF NOT EXISTS fase_em  timestamptz,
  ADD COLUMN IF NOT EXISTS fase_por text;

-- O CHECK compara-se pela DEFINIÇÃO, não só pelo nome: se um dia a lista
-- de fases crescer, recorrer o ficheiro tem de recriar o constraint em vez
-- de o dar por feito (a lição de db/validacoes_tipo.sql).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.eventos'::regclass
      AND conname  = 'eventos_fase_check'
      AND pg_get_constraintdef(oid) = $q$CHECK ((fase = ANY (ARRAY['aberto'::text, 'val_presencas'::text, 'val_contas'::text, 'pagamento'::text, 'fechado'::text])))$q$
  ) THEN
    ALTER TABLE festasbv.eventos DROP CONSTRAINT IF EXISTS eventos_fase_check;
    ALTER TABLE festasbv.eventos
      ADD CONSTRAINT eventos_fase_check
      CHECK (fase IN ('aberto','val_presencas','val_contas','pagamento','fechado'));
  END IF;
END $$;

-- Backfill. Só toca em linhas que ainda estão no DEFAULT ('aberto') mas
-- que os booleanos dizem estar mais à frente — por isso recorrer o
-- ficheiro não desfaz uma fase que o admin tenha escolhido à mão (essa
-- vem sempre com os booleanos em sincronia).
UPDATE festasbv.eventos e
   SET fase = CASE
     WHEN e.pagamentos_autorizados
      AND e.ano < (SELECT MAX(ano) FROM festasbv.eventos) THEN 'fechado'
     WHEN e.pagamentos_autorizados                        THEN 'pagamento'
     WHEN e.contas_fechadas                               THEN 'val_contas'
     ELSE 'aberto'
   END,
   fase_em = COALESCE(e.fase_em, e.pagamentos_autorizados_em, e.contas_fechadas_em),
   fase_por = COALESCE(e.fase_por, e.pagamentos_autorizados_por, e.contas_fechadas_por)
 WHERE e.fase = 'aberto'
   AND (e.contas_fechadas OR e.pagamentos_autorizados);
