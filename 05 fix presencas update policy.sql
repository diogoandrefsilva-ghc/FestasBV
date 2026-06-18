-- ============================================================
-- FestasBV — FIX: política de UPDATE em falta nas presenças
-- Correr no SQL Editor do Supabase (idempotente).
--
-- Porquê: o script "03 permissoes membros.sql" criou para não-admins
-- as políticas presencas_self_INS e presencas_self_DEL, mas NÃO a de
-- UPDATE. Resultado: marcar e remover funcionavam, mas mudar uma
-- presença para "só bebida" (UPDATE do campo modo) era bloqueado pela
-- RLS — silenciosamente (0 linhas, sem erro) com PATCH, ou com erro
-- 42501 com o upsert idempotente. Esta policy alinha a BD com a regra
-- da app (canTouchPresenca): próprio ou cônjuge, enquanto o dia não passou.
-- ============================================================

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

-- Depois disto: o ciclo completo (vazio → come → só bebida → vazio)
-- funciona para a Margarida nas presenças dela e do cônjuge, em dias
-- ainda abertos. O admin continua a poder tudo via presencas_admin.
