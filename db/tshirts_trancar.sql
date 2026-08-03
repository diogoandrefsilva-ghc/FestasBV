-- =====================================================================
-- FestasBV — Migração: trancar as encomendas de t-shirts do ano
-- (festasbv.eventos.tshirts_trancadas)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql -> tshirts.sql.
--
-- O QUE É: chega uma altura em que a encomenda segue para o fornecedor e
-- não pode continuar a mudar. O admin tranca as encomendas desse ano e, a
-- partir daí, só ele acrescenta, edita ou remove t-shirts.
--
-- É POR ANO (coluna em `eventos`), não global: trancar 2026 não afeta o
-- ano seguinte. É independente do fecho de contas — as contas podem estar
-- abertas e a encomenda já fechada.
--
-- Só o admin liga/desliga o interrogador: `eventos` já só aceita escrita
-- de is_admin() (policy eventos_admin), por isso não é preciso trigger.
-- As policies "self" das t-shirts é que passam a olhar para o flag — sem
-- isso o trancar era só cosmética da UI.
--
-- Sem esta migração a app funciona à mesma: sonda a coluna
-- (TS_LOCK_COL=false) e o interruptor fica escondido.
-- =====================================================================

ALTER TABLE festasbv.eventos
  ADD COLUMN IF NOT EXISTS tshirts_trancadas boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------
-- As encomendas deste ano ainda estão abertas?
-- SECURITY DEFINER pelo mesmo motivo de filho_meu(): é chamada de dentro
-- de uma policy e não pode depender do que o RLS deixa ver em `eventos`.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION festasbv.tshirts_abertas(p_evento_id bigint)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'festasbv', 'public'
AS $$
  SELECT NOT COALESCE(
    (SELECT e.tshirts_trancadas FROM festasbv.eventos e WHERE e.id = p_evento_id),
    false);
$$;

-- ---------------------------------------------------------------------
-- Policies "self" das t-shirts: iguais às de db/tshirts.sql, mais a
-- condição de as encomendas do ano continuarem abertas. O admin não passa
-- por aqui (tem a policy tshirts_admin, FOR ALL), logo continua a mexer
-- em tudo mesmo com o ano trancado.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS tshirts_self_ins ON festasbv.tshirts;
DROP POLICY IF EXISTS tshirts_self_upd ON festasbv.tshirts;
DROP POLICY IF EXISTS tshirts_self_del ON festasbv.tshirts;

CREATE POLICY tshirts_self_ins ON festasbv.tshirts
  FOR INSERT TO authenticated
  WITH CHECK (festasbv.is_allowed()
    AND festasbv.meu_amigo(membro)
    AND festasbv.tshirts_abertas(evento_id));

CREATE POLICY tshirts_self_upd ON festasbv.tshirts
  FOR UPDATE TO authenticated
  USING (festasbv.is_allowed()
    AND festasbv.meu_amigo(membro)
    AND festasbv.tshirts_abertas(evento_id))
  WITH CHECK (festasbv.is_allowed()
    AND festasbv.meu_amigo(membro)
    AND festasbv.tshirts_abertas(evento_id));

CREATE POLICY tshirts_self_del ON festasbv.tshirts
  FOR DELETE TO authenticated
  USING (festasbv.is_allowed()
    AND festasbv.meu_amigo(membro)
    AND festasbv.tshirts_abertas(evento_id));
