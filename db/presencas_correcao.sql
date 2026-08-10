-- =====================================================================
-- FestasBV — Migração: corrigir presenças de dias já passados
-- (festasbv.eventos.pres_correcao)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql.
--
-- O QUE É: por defeito um não-admin só marca presenças de dias que ainda
-- não aconteceram (`data >= hoje`) — enganou-se um dia e já não há como
-- corrigir sozinho. O admin liga este interruptor, por ano, para deixar
-- corrigir também os dias passados DESSE evento.
--
-- É POR ANO (coluna em `eventos`), não global: abrir 2026 não mexe em
-- 2025 nem em nenhum outro ano — cada evento tem a sua própria coluna.
--
-- As contas fechadas TÊM DE CONTINUAR A TRANCAR TUDO, mesmo com isto
-- ligado — por isso as funções abaixo negam sempre que `contas_fechadas`
-- é verdadeiro, e não só quando o dia já passou.
--
-- Só o admin escreve em `eventos` (policy eventos_admin já exige
-- is_admin() para qualquer UPDATE), por isso não é preciso trigger para
-- proteger a própria coluna — o mesmo raciocínio de tshirts_trancadas.
--
-- Sem esta migração a app funciona à mesma: sonda a coluna
-- (PRES_CORR_COL=false), o interruptor fica escondido e o comportamento
-- é o de sempre (só dias futuros).
-- =====================================================================

ALTER TABLE festasbv.eventos
  ADD COLUMN IF NOT EXISTS pres_correcao boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------
-- Substituem dia_aberto_membro()/dia_aberto_evento() SÓ nas policies das
-- presenças (membros e filhos) — de propósito NÃO se toca nas funções
-- originais, que continuam a servir os convidados (`convidados_self_*`)
-- sem ganharem esta exceção, que não lhes foi pedida.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION festasbv.presenca_membro_aberta(p_membro_id bigint, p_dia text)
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM festasbv.membros m
    JOIN festasbv.refeicoes_def rd
      ON rd.evento_id = m.evento_id AND rd.dia = p_dia
    JOIN festasbv.eventos e ON e.id = m.evento_id
    WHERE m.id = p_membro_id
      AND (
        rd.data >= CURRENT_DATE
        OR (e.pres_correcao AND NOT e.contas_fechadas)
      )
  );
$$;

CREATE OR REPLACE FUNCTION festasbv.presenca_filho_aberta(p_evento_id bigint, p_dia text)
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM festasbv.refeicoes_def rd
    JOIN festasbv.eventos e ON e.id = rd.evento_id
    WHERE rd.evento_id = p_evento_id
      AND rd.dia = p_dia
      AND (
        rd.data >= CURRENT_DATE
        OR (e.pres_correcao AND NOT e.contas_fechadas)
      )
  );
$$;

-- ---------------------------------------------------------------------
-- presencas: as três policies "self" trocam dia_aberto_membro() por
-- presenca_membro_aberta(). O admin não passa por aqui (presencas_admin,
-- FOR ALL) — as contas fechadas já o travam do lado do cliente.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS presencas_self_ins ON festasbv.presencas;
DROP POLICY IF EXISTS presencas_self_upd ON festasbv.presencas;
DROP POLICY IF EXISTS presencas_self_del ON festasbv.presencas;

CREATE POLICY presencas_self_ins ON festasbv.presencas
  FOR INSERT TO authenticated
  WITH CHECK (festasbv.is_allowed()
    AND festasbv.membro_meu(membro_id)
    AND festasbv.presenca_membro_aberta(membro_id, dia));

CREATE POLICY presencas_self_upd ON festasbv.presencas
  FOR UPDATE TO authenticated
  USING (festasbv.is_allowed()
    AND festasbv.membro_meu(membro_id)
    AND festasbv.presenca_membro_aberta(membro_id, dia))
  WITH CHECK (festasbv.is_allowed()
    AND festasbv.membro_meu(membro_id)
    AND festasbv.presenca_membro_aberta(membro_id, dia));

CREATE POLICY presencas_self_del ON festasbv.presencas
  FOR DELETE TO authenticated
  USING (festasbv.is_allowed()
    AND festasbv.membro_meu(membro_id)
    AND festasbv.presenca_membro_aberta(membro_id, dia));

-- ---------------------------------------------------------------------
-- filho_presencas: mesma troca, com dia_aberto_evento() -> presenca_filho_aberta().
-- Só INSERT/DELETE existem aqui (a linha existir É o "come" — ver db/filhos.sql).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS filho_presencas_self_ins ON festasbv.filho_presencas;
DROP POLICY IF EXISTS filho_presencas_self_del ON festasbv.filho_presencas;

CREATE POLICY filho_presencas_self_ins ON festasbv.filho_presencas
  FOR INSERT TO authenticated
  WITH CHECK (festasbv.is_allowed()
    AND festasbv.filho_meu(filho_id)
    AND festasbv.presenca_filho_aberta(evento_id, dia));

CREATE POLICY filho_presencas_self_del ON festasbv.filho_presencas
  FOR DELETE TO authenticated
  USING (festasbv.is_allowed()
    AND festasbv.filho_meu(filho_id)
    AND festasbv.presenca_filho_aberta(evento_id, dia));
