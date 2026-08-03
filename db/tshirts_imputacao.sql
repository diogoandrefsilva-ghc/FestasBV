-- =====================================================================
-- FestasBV — Migração: a quem se COBRA cada t-shirt (tshirts.imputado_a)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql -> tshirts.sql.
--
-- O QUE É: `tshirts.membro` diz quem PEDIU a t-shirt. Isso nem sempre é
-- quem a PAGA — as dos filhos, por exemplo, dividem-se pelos dois pais.
-- `imputado_a` é a lista de membros a quem a despesa é imputada, em
-- partes iguais:
--
--   []                        -> fica na conta de quem pediu (o defeito;
--                                é o que evita o admin ter de tocar em
--                                todas as linhas — só mexe nas exceções)
--   ["Ana"]                   -> a conta é toda da Ana
--   ["Ana","Diogo"]           -> metade para cada um
--
-- Só o ADMIN imputa. Como a coluna vive na mesma linha que o dono da
-- t-shirt pode editar (nome/tipo/tamanho), o RLS por si só não chega:
-- o trigger abaixo é que garante que ninguém sem ser o admin lhe mexe,
-- mesmo pela consola do browser.
--
-- Isto continua a NÃO ENTRAR EM NENHUMA CONTA da app: é o levantamento
-- de quanto cobrar a cada um, não mexe em quotas, saldos nem cash-flows.
--
-- Sem esta migração a app funciona à mesma: sonda a coluna
-- (TS_IMPUT_COL=false) e a imputação fica simplesmente escondida.
-- =====================================================================

ALTER TABLE festasbv.tshirts
  ADD COLUMN IF NOT EXISTS imputado_a jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Só array JSON (a app guarda uma lista de nomes de membros)
ALTER TABLE festasbv.tshirts DROP CONSTRAINT IF EXISTS tshirts_imputado_a_check;
ALTER TABLE festasbv.tshirts
  ADD CONSTRAINT tshirts_imputado_a_check CHECK (jsonb_typeof(imputado_a) = 'array');

-- ---------------------------------------------------------------------
-- Guarda: só o admin imputa.
-- Não precisa de SECURITY DEFINER — só olha para auth.email() via
-- is_admin(), não lê tabelas por trás do RLS.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION festasbv.tshirts_guard_imputacao()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path TO 'festasbv', 'public'
AS $$
BEGIN
  IF festasbv.is_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Quem não é admin nunca imputa a ninguém: nasce sempre na conta de
    -- quem pediu (silenciosamente — a app nem mostra o campo)
    NEW.imputado_a := '[]'::jsonb;
  ELSIF NEW.imputado_a IS DISTINCT FROM OLD.imputado_a THEN
    RAISE EXCEPTION 'Apenas o administrador pode alterar a quem se cobra a t-shirt';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tshirts_imputacao ON festasbv.tshirts;
CREATE TRIGGER trg_tshirts_imputacao
  BEFORE INSERT OR UPDATE ON festasbv.tshirts
  FOR EACH ROW EXECUTE FUNCTION festasbv.tshirts_guard_imputacao();
