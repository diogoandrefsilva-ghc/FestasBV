-- =====================================================================
-- FestasBV — RLS Policies (festasbv)
-- Fonte de verdade. Reconstruído a partir do estado real da BD.
--
-- PRÉ-REQUISITO: este ficheiro DEPENDE das funções em functions.sql
--   festasbv.is_admin(), festasbv.is_allowed(),
--   festasbv.meus_amigos(), festasbv.meu_amigo(text),
--   festasbv.membro_meu(bigint),
--   festasbv.dia_aberto_evento(bigint, text),
--   festasbv.dia_aberto_membro(bigint, text)
-- Correr functions.sql ANTES deste ficheiro, senão rebenta com
-- "function ... does not exist".
--
-- Ordem de execução geral: schema.sql -> functions.sql -> policies.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- access_requests
-- ---------------------------------------------------------------------
CREATE POLICY ar_insert ON festasbv.access_requests
  FOR INSERT TO authenticated
  WITH CHECK (email = auth.email());

CREATE POLICY ar_admin_sel ON festasbv.access_requests
  FOR SELECT TO authenticated
  USING (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

CREATE POLICY ar_admin_del ON festasbv.access_requests
  FOR DELETE TO authenticated
  USING (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

-- ---------------------------------------------------------------------
-- allowed_users
-- ---------------------------------------------------------------------
CREATE POLICY au_select ON festasbv.allowed_users
  FOR SELECT TO authenticated
  USING ((email = auth.email()) OR (auth.email() = 'diogo.andre.f.silva@gmail.com'::text));

CREATE POLICY au_admin_ins ON festasbv.allowed_users
  FOR INSERT TO authenticated
  WITH CHECK (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

CREATE POLICY au_admin_del ON festasbv.allowed_users
  FOR DELETE TO authenticated
  USING (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

-- ---------------------------------------------------------------------
-- conjuges
-- ---------------------------------------------------------------------
CREATE POLICY cj_sel ON festasbv.conjuges
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());

CREATE POLICY cj_admin ON festasbv.conjuges
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());

-- ---------------------------------------------------------------------
-- config  (leitura: qualquer autenticado; escrita: só admin)
-- ---------------------------------------------------------------------
CREATE POLICY cfg_sel ON festasbv.config
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY cfg_upd ON festasbv.config
  FOR UPDATE TO authenticated
  USING       (auth.email() = 'diogo.andre.f.silva@gmail.com')
  WITH CHECK  (auth.email() = 'diogo.andre.f.silva@gmail.com');

-- ---------------------------------------------------------------------
-- convidados
-- ---------------------------------------------------------------------
CREATE POLICY convidados_sel ON festasbv.convidados
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());

CREATE POLICY convidados_admin ON festasbv.convidados
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());

CREATE POLICY convidados_self_ins ON festasbv.convidados
  FOR INSERT TO authenticated
  WITH CHECK (festasbv.is_allowed()
    AND (membro IN (SELECT festasbv.meus_amigos()))
    AND festasbv.dia_aberto_evento(evento_id, dia));

CREATE POLICY convidados_self_upd ON festasbv.convidados
  FOR UPDATE TO authenticated
  USING (festasbv.is_allowed()
    AND (membro IN (SELECT festasbv.meus_amigos()))
    AND festasbv.dia_aberto_evento(evento_id, dia))
  WITH CHECK (festasbv.is_allowed()
    AND (membro IN (SELECT festasbv.meus_amigos()))
    AND festasbv.dia_aberto_evento(evento_id, dia));

CREATE POLICY convidados_self_del ON festasbv.convidados
  FOR DELETE TO authenticated
  USING (festasbv.is_allowed()
    AND (membro IN (SELECT festasbv.meus_amigos()))
    AND festasbv.dia_aberto_evento(evento_id, dia));

-- ---------------------------------------------------------------------
-- despesas
-- ---------------------------------------------------------------------
CREATE POLICY despesas_sel ON festasbv.despesas
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());

CREATE POLICY despesas_admin ON festasbv.despesas
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());

CREATE POLICY despesas_self_ins ON festasbv.despesas
  FOR INSERT TO authenticated
  WITH CHECK (festasbv.is_allowed()
    AND (quem IN (SELECT festasbv.meus_amigos())));

-- ---------------------------------------------------------------------
-- eventos
-- ---------------------------------------------------------------------
CREATE POLICY eventos_sel ON festasbv.eventos
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());

CREATE POLICY eventos_admin ON festasbv.eventos
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());

-- ---------------------------------------------------------------------
-- historico
-- ---------------------------------------------------------------------
CREATE POLICY hist_select ON festasbv.historico
  FOR SELECT TO authenticated
  USING (auth.email() IN (SELECT allowed_users.email FROM festasbv.allowed_users));

CREATE POLICY hist_insert ON festasbv.historico
  FOR INSERT TO authenticated
  WITH CHECK ((auth.email() IN (SELECT allowed_users.email FROM festasbv.allowed_users))
    AND (autor_email = auth.email()));

CREATE POLICY hist_admin_del ON festasbv.historico
  FOR DELETE TO authenticated
  USING (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

-- ---------------------------------------------------------------------
-- mealheiros
-- ---------------------------------------------------------------------
CREATE POLICY mealheiros_sel ON festasbv.mealheiros
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());

CREATE POLICY mealheiros_admin ON festasbv.mealheiros
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());

-- ---------------------------------------------------------------------
-- membros
-- ---------------------------------------------------------------------
CREATE POLICY membros_sel ON festasbv.membros
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());

CREATE POLICY membros_admin ON festasbv.membros
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());

-- ---------------------------------------------------------------------
-- pagamentos
-- ---------------------------------------------------------------------
CREATE POLICY pagamentos_sel ON festasbv.pagamentos
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());

CREATE POLICY pagamentos_admin ON festasbv.pagamentos
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());

-- ---------------------------------------------------------------------
-- presencas
-- ---------------------------------------------------------------------
CREATE POLICY presencas_sel ON festasbv.presencas
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());

CREATE POLICY presencas_admin ON festasbv.presencas
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());

CREATE POLICY presencas_self_ins ON festasbv.presencas
  FOR INSERT TO authenticated
  WITH CHECK (festasbv.is_allowed()
    AND festasbv.membro_meu(membro_id)
    AND festasbv.dia_aberto_membro(membro_id, dia));

CREATE POLICY presencas_self_upd ON festasbv.presencas
  FOR UPDATE TO authenticated
  USING (festasbv.is_allowed()
    AND festasbv.membro_meu(membro_id)
    AND festasbv.dia_aberto_membro(membro_id, dia))
  WITH CHECK (festasbv.is_allowed()
    AND festasbv.membro_meu(membro_id)
    AND festasbv.dia_aberto_membro(membro_id, dia));

CREATE POLICY presencas_self_del ON festasbv.presencas
  FOR DELETE TO authenticated
  USING (festasbv.is_allowed()
    AND festasbv.membro_meu(membro_id)
    AND festasbv.dia_aberto_membro(membro_id, dia));

-- ---------------------------------------------------------------------
-- refeicoes_def
-- ---------------------------------------------------------------------
CREATE POLICY refeicoes_def_sel ON festasbv.refeicoes_def
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());

CREATE POLICY refeicoes_def_admin ON festasbv.refeicoes_def
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());

-- ---------------------------------------------------------------------
-- user_amigos
-- ---------------------------------------------------------------------
CREATE POLICY ua_sel ON festasbv.user_amigos
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());

CREATE POLICY ua_admin ON festasbv.user_amigos
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());

-- ---------------------------------------------------------------------
-- validacoes  (NOTA: estas policies usam o role `public`, não `authenticated`)
-- ---------------------------------------------------------------------
CREATE POLICY validacoes_select ON festasbv.validacoes
  FOR SELECT TO public
  USING (festasbv.is_allowed()
    AND (festasbv.is_admin() OR festasbv.meu_amigo(amigo)));

CREATE POLICY validacoes_insert ON festasbv.validacoes
  FOR INSERT TO public
  WITH CHECK (festasbv.is_admin()
    OR (festasbv.meu_amigo(amigo) AND (validado_por_email = auth.email())));

CREATE POLICY validacoes_update ON festasbv.validacoes
  FOR UPDATE TO public
  USING (festasbv.is_admin() OR festasbv.meu_amigo(amigo))
  WITH CHECK (festasbv.is_admin()
    OR (festasbv.meu_amigo(amigo) AND (validado_por_email = auth.email())));

CREATE POLICY validacoes_delete ON festasbv.validacoes
  FOR DELETE TO public
  USING (festasbv.is_admin() OR festasbv.meu_amigo(amigo));
