-- =====================================================================
-- FestasBV — Migração: notificações Web Push (sem ser por Telegram)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql.
--
-- Irmã da migração homónima do SplitBill (mesmo projeto Supabase, schema
-- diferente): guarda a "push subscription" que o browser gera quando o
-- utilizador ativa notificações (Definições → 🔔 Notificações → Ativar
-- notificações push). Cada linha é um par endpoint+chaves ligado à conta
-- (email) que o gerou — o mesmo utilizador pode ter várias linhas (um por
-- telemóvel/instalação da PWA).
--
-- QUEM ENVIA: a Edge Function `push-notificar` (service role, bypassa RLS),
-- chamada pela app em três momentos — ver o cabeçalho de push-notificar.ts.
-- Resolve amigo→email via `user_amigos` (mesma tabela já usada nas outras
-- políticas) e manda o push a cada subscription dessa pessoa.
--
-- Sem esta migração a app funciona à mesma: PUSH_COL fica false, o botão
-- "Ativar notificações push" esconde-se, e a consola avisa. Nada rebenta —
-- as notificações Telegram (notif-festas/notif-pessoais) não dependem disto.
-- =====================================================================

CREATE TABLE IF NOT EXISTS festasbv.push_subscriptions (
  endpoint   text PRIMARY KEY,
  email      text NOT NULL,
  p256dh     text NOT NULL,
  auth_key   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_email_idx
  ON festasbv.push_subscriptions (lower(email));

-- GRANTs (sem isto: HTTP 403 / 42501)
GRANT ALL ON TABLE festasbv.push_subscriptions TO anon, authenticated;

-- A service_role (usada pela Edge Function push-notificar) precisa de acesso
-- ao schema — a RLS ela ignora, mas os GRANTs de schema/tabela não.
GRANT USAGE ON SCHEMA festasbv TO service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA festasbv TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA festasbv TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA festasbv GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA festasbv GRANT ALL ON SEQUENCES TO service_role;

ALTER TABLE festasbv.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Cada um só vê/gere as próprias subscriptions (a Edge Function usa a
-- service role e não passa por aqui).
DROP POLICY IF EXISTS push_subscriptions_select_propria ON festasbv.push_subscriptions;
CREATE POLICY push_subscriptions_select_propria ON festasbv.push_subscriptions
  FOR SELECT TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- INSERT/UPDATE cobrem o upsert que a app faz (Prefer: resolution=merge-duplicates
-- pela PK `endpoint`) sempre que subscreve neste dispositivo.
DROP POLICY IF EXISTS push_subscriptions_insert_propria ON festasbv.push_subscriptions;
CREATE POLICY push_subscriptions_insert_propria ON festasbv.push_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

DROP POLICY IF EXISTS push_subscriptions_update_propria ON festasbv.push_subscriptions;
CREATE POLICY push_subscriptions_update_propria ON festasbv.push_subscriptions
  FOR UPDATE TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
  WITH CHECK (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

DROP POLICY IF EXISTS push_subscriptions_delete_propria ON festasbv.push_subscriptions;
CREATE POLICY push_subscriptions_delete_propria ON festasbv.push_subscriptions
  FOR DELETE TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
-- =====================================================================
