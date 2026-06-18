-- ============================================================
-- FestasBV — Permissões v2
-- Utilizadores ↔ Membros, Casais e RLS granular
-- Correr no SQL Editor (idempotente — pode correr-se mais de 1x)
--
-- Modelo:
--   · Admin (diogo.andre.f.silva@gmail.com): tudo.
--   · Restantes (em allowed_users): leitura de tudo. Escrita apenas:
--       1) presenças próprias ou do cônjuge, até à data do dia
--       2) convidados próprios ou do cônjuge, até à data do dia
--       3) INSERIR despesas em nome próprio ou do cônjuge
--     Mealheiros, reembolsos, pagamentos, plantel, refeições,
--     parametrizações e novos anos: só admin.
-- ============================================================

-- ─── 1. Novas tabelas ────────────────────────────────────────

-- Equivalência utilizador (email) ↔ membro do plantel (nome).
-- 1 utilizador liga-se a 1 membro; o cônjuge vem da tabela conjuges.
CREATE TABLE IF NOT EXISTS festasbv.user_amigos (
  email TEXT PRIMARY KEY,
  amigo TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Casais — sempre por nome de membro, nunca por utilizador
-- (podem ambos não ter conta). 1 linha por casal.
CREATE TABLE IF NOT EXISTS festasbv.conjuges (
  amigo_a TEXT NOT NULL,
  amigo_b TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (amigo_a, amigo_b),
  CHECK (amigo_a <> amigo_b)
);

ALTER TABLE festasbv.user_amigos ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.conjuges    ENABLE ROW LEVEL SECURITY;

-- (GRANTs já cobertos pelos ALTER DEFAULT PRIVILEGES do script 01)

-- ─── 2. Funções auxiliares ───────────────────────────────────

CREATE OR REPLACE FUNCTION festasbv.is_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT auth.email() = 'diogo.andre.f.silva@gmail.com';
$$;

CREATE OR REPLACE FUNCTION festasbv.is_allowed()
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT auth.email() IN (SELECT email FROM festasbv.allowed_users);
$$;

-- Nomes que o utilizador atual pode gerir: o seu membro + cônjuge(s)
CREATE OR REPLACE FUNCTION festasbv.meus_amigos()
RETURNS SETOF TEXT LANGUAGE sql STABLE AS $$
  WITH meu AS (
    SELECT amigo FROM festasbv.user_amigos WHERE email = auth.email()
  )
  SELECT amigo FROM meu
  UNION
  SELECT c.amigo_b FROM festasbv.conjuges c JOIN meu m ON c.amigo_a = m.amigo
  UNION
  SELECT c.amigo_a FROM festasbv.conjuges c JOIN meu m ON c.amigo_b = m.amigo;
$$;

-- O membro deste id pertence ao utilizador (próprio ou cônjuge)?
CREATE OR REPLACE FUNCTION festasbv.membro_meu(p_membro_id BIGINT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM festasbv.membros m
    WHERE m.id = p_membro_id
      AND m.nome IN (SELECT festasbv.meus_amigos())
  );
$$;

-- O dia (rótulo) deste membro ainda não passou?
CREATE OR REPLACE FUNCTION festasbv.dia_aberto_membro(p_membro_id BIGINT, p_dia TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM festasbv.membros m
    JOIN festasbv.refeicoes_def rd
      ON rd.evento_id = m.evento_id AND rd.dia = p_dia
    WHERE m.id = p_membro_id
      AND rd.data >= CURRENT_DATE
  );
$$;

-- O dia (rótulo) deste evento ainda não passou?
CREATE OR REPLACE FUNCTION festasbv.dia_aberto_evento(p_evento_id BIGINT, p_dia TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM festasbv.refeicoes_def rd
    WHERE rd.evento_id = p_evento_id
      AND rd.dia = p_dia
      AND rd.data >= CURRENT_DATE
  );
$$;

-- ─── 3. Policies: user_amigos e conjuges ─────────────────────

DROP POLICY IF EXISTS ua_sel   ON festasbv.user_amigos;
DROP POLICY IF EXISTS ua_admin ON festasbv.user_amigos;
CREATE POLICY ua_sel ON festasbv.user_amigos
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());
CREATE POLICY ua_admin ON festasbv.user_amigos
  FOR ALL TO authenticated
  USING (festasbv.is_admin()) WITH CHECK (festasbv.is_admin());

DROP POLICY IF EXISTS cj_sel   ON festasbv.conjuges;
DROP POLICY IF EXISTS cj_admin ON festasbv.conjuges;
CREATE POLICY cj_sel ON festasbv.conjuges
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());
CREATE POLICY cj_admin ON festasbv.conjuges
  FOR ALL TO authenticated
  USING (festasbv.is_admin()) WITH CHECK (festasbv.is_admin());

-- ─── 4. Tabelas de dados: substituir o "tudo para todos" ─────
-- Remove as policies <t>_all do script 01 e cria:
--   <t>_sel   → leitura para allowed_users
--   <t>_admin → tudo para o admin

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['eventos','membros','presencas','refeicoes_def','despesas','convidados','mealheiros','pagamentos']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_all ON festasbv.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_sel ON festasbv.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_admin ON festasbv.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY %I_sel ON festasbv.%I FOR SELECT TO authenticated
         USING (festasbv.is_allowed());', t, t);
    EXECUTE format(
      'CREATE POLICY %I_admin ON festasbv.%I FOR ALL TO authenticated
         USING (festasbv.is_admin()) WITH CHECK (festasbv.is_admin());', t, t);
  END LOOP;
END $$;

-- ─── 5. Exceções para não-admin ──────────────────────────────

-- 5a) PRESENÇAS: marcar/desmarcar as próprias ou do cônjuge,
--     apenas enquanto a data do dia não passou.
DROP POLICY IF EXISTS presencas_self_ins ON festasbv.presencas;
DROP POLICY IF EXISTS presencas_self_del ON festasbv.presencas;
CREATE POLICY presencas_self_ins ON festasbv.presencas
  FOR INSERT TO authenticated
  WITH CHECK (
    festasbv.is_allowed()
    AND festasbv.membro_meu(membro_id)
    AND festasbv.dia_aberto_membro(membro_id, dia)
  );
CREATE POLICY presencas_self_del ON festasbv.presencas
  FOR DELETE TO authenticated
  USING (
    festasbv.is_allowed()
    AND festasbv.membro_meu(membro_id)
    AND festasbv.dia_aberto_membro(membro_id, dia)
  );
DROP POLICY IF EXISTS presencas_self_upd ON festasbv.presencas;
CREATE POLICY presencas_self_upd ON festasbv.presencas
  FOR UPDATE TO authenticated
  USING (
    festasbv.is_allowed()
    AND festasbv.membro_meu(membro_id)
    AND festasbv.dia_aberto_membro(membro_id, dia)
  )
  WITH CHECK (
    festasbv.is_allowed()
    AND festasbv.membro_meu(membro_id)
    AND festasbv.dia_aberto_membro(membro_id, dia)
  );

-- 5b) CONVIDADOS: adicionar/editar/remover convidados próprios
--     ou do cônjuge, apenas enquanto a data do dia não passou.
DROP POLICY IF EXISTS convidados_self_ins ON festasbv.convidados;
DROP POLICY IF EXISTS convidados_self_upd ON festasbv.convidados;
DROP POLICY IF EXISTS convidados_self_del ON festasbv.convidados;
CREATE POLICY convidados_self_ins ON festasbv.convidados
  FOR INSERT TO authenticated
  WITH CHECK (
    festasbv.is_allowed()
    AND membro IN (SELECT festasbv.meus_amigos())
    AND festasbv.dia_aberto_evento(evento_id, dia)
  );
CREATE POLICY convidados_self_upd ON festasbv.convidados
  FOR UPDATE TO authenticated
  USING (
    festasbv.is_allowed()
    AND membro IN (SELECT festasbv.meus_amigos())
    AND festasbv.dia_aberto_evento(evento_id, dia)
  )
  WITH CHECK (
    festasbv.is_allowed()
    AND membro IN (SELECT festasbv.meus_amigos())
    AND festasbv.dia_aberto_evento(evento_id, dia)
  );
CREATE POLICY convidados_self_del ON festasbv.convidados
  FOR DELETE TO authenticated
  USING (
    festasbv.is_allowed()
    AND membro IN (SELECT festasbv.meus_amigos())
    AND festasbv.dia_aberto_evento(evento_id, dia)
  );

-- 5c) DESPESAS: inserir despesas em nome próprio ou do cônjuge.
--     Só INSERT — editar/apagar continua só admin.
--     Mealheiros, reembolsos e pagamentos não têm exceção:
--     as tabelas mealheiros/pagamentos ficam só-admin pelo passo 4.
DROP POLICY IF EXISTS despesas_self_ins ON festasbv.despesas;
CREATE POLICY despesas_self_ins ON festasbv.despesas
  FOR INSERT TO authenticated
  WITH CHECK (
    festasbv.is_allowed()
    AND quem IN (SELECT festasbv.meus_amigos())
  );

-- ─── 6. Ligação inicial do admin (ajusta o nome se preciso) ──
-- INSERT INTO festasbv.user_amigos (email, amigo)
--   VALUES ('diogo.andre.f.silva@gmail.com', 'Diogo')
--   ON CONFLICT (email) DO UPDATE SET amigo = EXCLUDED.amigo;
-- (também podes fazer isto na app, no painel ⚙ → Utilizadores & Casais)
