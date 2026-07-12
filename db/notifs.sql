-- =====================================================================
-- FestasBV — Migração: Notificações pessoais no Telegram
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql (refeicoes_def/config) e functions.sql (is_allowed/is_admin).
-- Ordem: schema.sql -> functions.sql -> policies.sql -> shoplist.sql -> ESTE ficheiro.
--
-- O que acrescenta:
--   1) refeicoes_def.resp_cozinha / resp_compras — responsáveis nomeados
--      pelo admin para cada refeição (nomes de membros, como o resto da app)
--      — e refeicoes_def.menu, detalhe adicional do menu (texto livre).
--   2) festasbv.notif_prefs — preferências pessoais: cada utilizador liga a
--      sua conta ao bot do Telegram (chat_id) e liga/desliga os avisos.
--   3) config 'telegram_bot' — username do bot (sem @), para a app montar o
--      link t.me/<bot>?start=<codigo>. Preencher à mão depois de correr:
--        UPDATE festasbv.config SET valor='OTeuBot' WHERE chave='telegram_bot';
--
-- Setup completo das notificações pessoais: ver db/telegram.md.
-- =====================================================================

-- 1) Responsáveis por refeição (quem cozinha / quem vai às compras)
--    + detalhe do menu (texto livre, além do prato principal)
ALTER TABLE festasbv.refeicoes_def ADD COLUMN IF NOT EXISTS resp_cozinha text;
ALTER TABLE festasbv.refeicoes_def ADD COLUMN IF NOT EXISTS resp_compras text;
ALTER TABLE festasbv.refeicoes_def ADD COLUMN IF NOT EXISTS menu text;

-- 2) Preferências pessoais de notificação
CREATE TABLE IF NOT EXISTS festasbv.notif_prefs (
  user_email text PRIMARY KEY,               -- conta Google do utilizador
  chat_id    text,                           -- chat do Telegram (preenchido pela Edge Function no /start)
  codigo     text UNIQUE,                    -- código de ligação (gerado pela app, usado no deep-link)
  ativo      boolean NOT NULL DEFAULT true,  -- interruptor pessoal
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- GRANTs (sem isto: HTTP 403 / 42501)
GRANT ALL ON TABLE festasbv.notif_prefs TO anon, authenticated;

-- RLS: cada um só vê e mexe na SUA linha; admin vê tudo. O chat_id é
-- escrito pela Edge Function (service_role, ignora RLS).
ALTER TABLE festasbv.notif_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notif_prefs_sel   ON festasbv.notif_prefs;
DROP POLICY IF EXISTS notif_prefs_ins   ON festasbv.notif_prefs;
DROP POLICY IF EXISTS notif_prefs_upd   ON festasbv.notif_prefs;
DROP POLICY IF EXISTS notif_prefs_del   ON festasbv.notif_prefs;
DROP POLICY IF EXISTS notif_prefs_admin ON festasbv.notif_prefs;

CREATE POLICY notif_prefs_sel ON festasbv.notif_prefs
  FOR SELECT TO authenticated
  USING (user_email = auth.email() OR festasbv.is_admin());

CREATE POLICY notif_prefs_ins ON festasbv.notif_prefs
  FOR INSERT TO authenticated
  WITH CHECK (user_email = auth.email() AND festasbv.is_allowed());

CREATE POLICY notif_prefs_upd ON festasbv.notif_prefs
  FOR UPDATE TO authenticated
  USING (user_email = auth.email())
  WITH CHECK (user_email = auth.email());

CREATE POLICY notif_prefs_del ON festasbv.notif_prefs
  FOR DELETE TO authenticated
  USING (user_email = auth.email() OR festasbv.is_admin());

CREATE POLICY notif_prefs_admin ON festasbv.notif_prefs
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());

-- 3) Username do bot (a app lê via cfg_sel, que já permite leitura a todos
--    os autenticados). Preencher com o username real, SEM o @.
INSERT INTO festasbv.config (chave, valor)
VALUES ('telegram_bot', '')
ON CONFLICT (chave) DO NOTHING;
