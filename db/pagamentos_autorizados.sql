-- =====================================================================
-- FestasBV — Migração: autorizar os pagamentos do ano
-- (festasbv.eventos.pagamentos_autorizados / _em / _por)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql.
--
-- O QUE É: o fim do ano passa a ter DUAS fases, não uma. Fechar as contas
-- deixou de querer dizer "paguem" e passa a querer dizer "confiram" — as
-- validações de cada um ainda podem obrigar a acertos, e quem pagasse
-- pelo número de hoje podia estar a pagar o número errado. Só quando o
-- admin dá as contas por validadas é que se autorizam os pagamentos.
--
-- Cada fase manda o seu aviso (push + email): o fecho diz "em validação,
-- não pagues ainda"; a autorização diz "já podes pagar". É o único efeito
-- desta coluna — NÃO tranca nada. Registar um pagamento continua a ser
-- possível a quem já podia (ver podeSaldar no app.js): a fase é um aviso
-- ao grupo, não uma trava. Se um dia se quiser mesmo travar, é aqui que
-- nasce a condição, e é uma decisão à parte.
--
-- É POR ANO (coluna em `eventos`), como o fecho de contas. Reabrir as
-- contas retira a autorização (a app fá-lo no mesmo PATCH): se o ano
-- voltou a mexer, os números que se mandou pagar já não são os finais.
--
-- Só o admin liga/desliga: `eventos` já só aceita escrita de is_admin()
-- (policy eventos_admin), por isso não é preciso trigger nenhum — a mesma
-- razão de db/tshirts_trancar.sql.
--
-- Sem esta migração a app funciona à mesma: sonda a coluna
-- (pagAutorizCol=false), o cartão dos pagamentos fica escondido e o fecho
-- de contas continua a mandar só o seu aviso.
-- =====================================================================

ALTER TABLE festasbv.eventos
  ADD COLUMN IF NOT EXISTS pagamentos_autorizados     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pagamentos_autorizados_em  timestamptz,
  ADD COLUMN IF NOT EXISTS pagamentos_autorizados_por text;
