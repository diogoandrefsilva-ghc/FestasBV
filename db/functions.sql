-- =====================================================================
-- FestasBV — Funções (festasbv)
-- Fonte de verdade. Reconstruído a partir do estado real da BD.
--
-- Ordem de execução geral: schema.sql -> functions.sql -> policies.sql
-- (as policies dependem destas funções; estas funções dependem das
--  tabelas em schema.sql, por isso este ficheiro fica no meio.)
--
-- Nota de segurança: a maioria corre como o utilizador chamador (sem
-- SECURITY DEFINER), apoiando-se no RLS das próprias tabelas. As que
-- precisam de ver para lá do RLS — meu_amigo() e guard_fecho() — são
-- SECURITY DEFINER com search_path fixo.
-- =====================================================================

-- Admin? (compara email autenticado com o admin fixo)
CREATE OR REPLACE FUNCTION festasbv.is_admin()
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT auth.email() = 'diogo.andre.f.silva@gmail.com';
$$;

-- Utilizador tem acesso? (email consta em allowed_users)
CREATE OR REPLACE FUNCTION festasbv.is_allowed()
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT auth.email() IN (SELECT email FROM festasbv.allowed_users);
$$;

-- Conjunto de amigos do utilizador autenticado: o seu próprio amigo
-- (user_amigos) + os cônjuges associados (conjuges, nos dois sentidos).
CREATE OR REPLACE FUNCTION festasbv.meus_amigos()
  RETURNS SETOF text LANGUAGE sql STABLE
AS $$
  WITH meu AS (
    SELECT amigo FROM festasbv.user_amigos WHERE email = auth.email()
  )
  SELECT amigo FROM meu
  UNION
  SELECT c.amigo_b FROM festasbv.conjuges c JOIN meu m ON c.amigo_a = m.amigo
  UNION
  SELECT c.amigo_a FROM festasbv.conjuges c JOIN meu m ON c.amigo_b = m.amigo;
$$;

-- Este membro (por id) é um dos meus amigos? (depende de meus_amigos())
CREATE OR REPLACE FUNCTION festasbv.membro_meu(p_membro_id bigint)
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM festasbv.membros m
    WHERE m.id = p_membro_id
      AND m.nome IN (SELECT festasbv.meus_amigos())
  );
$$;

-- Este nome de amigo é meu? (direto ou via cônjuge). SECURITY DEFINER
-- para conseguir ler user_amigos/conjuges independentemente do RLS.
CREATE OR REPLACE FUNCTION festasbv.meu_amigo(p_amigo text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'festasbv', 'public'
AS $$
  WITH meu AS (
    SELECT amigo FROM festasbv.user_amigos WHERE email = auth.email()
  )
  SELECT
    EXISTS (SELECT 1 FROM meu WHERE meu.amigo = p_amigo)
    OR EXISTS (
      SELECT 1
      FROM meu
      JOIN festasbv.conjuges c
        ON (c.amigo_a = meu.amigo AND c.amigo_b = p_amigo)
        OR (c.amigo_b = meu.amigo AND c.amigo_a = p_amigo)
    );
$$;

-- Dia (refeição) ainda aberto para um evento? (data >= hoje)
CREATE OR REPLACE FUNCTION festasbv.dia_aberto_evento(p_evento_id bigint, p_dia text)
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM festasbv.refeicoes_def rd
    WHERE rd.evento_id = p_evento_id
      AND rd.dia = p_dia
      AND rd.data >= CURRENT_DATE
  );
$$;

-- Dia ainda aberto, a partir de um membro (resolve o evento via membros).
CREATE OR REPLACE FUNCTION festasbv.dia_aberto_membro(p_membro_id bigint, p_dia text)
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM festasbv.membros m
    JOIN festasbv.refeicoes_def rd
      ON rd.evento_id = m.evento_id AND rd.dia = p_dia
    WHERE m.id = p_membro_id
      AND rd.data >= CURRENT_DATE
  );
$$;

-- Trigger function: impede não-admins de fechar/reabrir contas de um evento.
-- (O CREATE TRIGGER que a invoca está em triggers — ver nota no fim.)
CREATE OR REPLACE FUNCTION festasbv.guard_fecho()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'festasbv', 'public'
AS $$
BEGIN
  IF ( NEW.contas_fechadas     IS DISTINCT FROM OLD.contas_fechadas
    OR NEW.contas_fechadas_em  IS DISTINCT FROM OLD.contas_fechadas_em
    OR NEW.contas_fechadas_por IS DISTINCT FROM OLD.contas_fechadas_por )
     AND NOT festasbv.is_admin() THEN
    RAISE EXCEPTION 'Apenas o administrador pode fechar ou reabrir contas';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- TRIGGERS
-- ---------------------------------------------------------------------

-- Protege o fecho/reabertura de contas (BEFORE UPDATE em eventos).
DROP TRIGGER IF EXISTS trg_guard_fecho ON festasbv.eventos;
CREATE TRIGGER trg_guard_fecho
  BEFORE UPDATE ON festasbv.eventos
  FOR EACH ROW EXECUTE FUNCTION festasbv.guard_fecho();

-- Database Webhook: AFTER INSERT em historico -> chama a Edge Function
-- notif-festas. Este trigger é GERIDO PELO DASHBOARD (Database -> Webhooks);
-- normalmente NÃO se cria à mão e NÃO precisa de viver no repo.
--
-- ⚠️ SEGURANÇA: a definição real contém a SERVICE_ROLE_KEY em texto-limpo no
-- header Authorization. A service_role ignora todo o RLS (acesso total).
-- NUNCA commitar a chave real num repo público — fica REDIGIDA abaixo.
-- A chave verdadeira vive só no Supabase, não no GitHub.
--
-- CREATE TRIGGER festasbv_historico
--   AFTER INSERT ON festasbv.historico
--   FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request(
--     'https://gjweqwfbnkgnibhajldc.supabase.co/functions/v1/notif-festas',
--     'POST',
--     '{"Content-type":"application/json","Authorization":"Bearer <SERVICE_ROLE_KEY>"}',
--     '{}',
--     '5000'
--   );
-- ---------------------------------------------------------------------
