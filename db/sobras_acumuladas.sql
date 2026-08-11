-- ═══════════════════════════════════════════════════════════════════════════
-- POUPANÇA ACUMULADA — quanto usar das sobras de anos anteriores
-- ═══════════════════════════════════════════════════════════════════════════
-- Cada ano guarda o montante da reserva acumulada que decidiu aplicar. 0 = não
-- usa nada. O valor é refletido no mealheiro com subtipo 'sobras_ano_anterior',
-- para continuar a entrar nos cash-flows e na conta do tesoureiro.

ALTER TABLE festasbv.eventos
  ADD COLUMN IF NOT EXISTS sobras_aplicadas numeric(10,2) NOT NULL DEFAULT 0;

-- Preserva o comportamento e os dados já existentes: as entradas automáticas
-- de sobras passam a ser a escolha gravada desse ano.
UPDATE festasbv.eventos e
SET sobras_aplicadas = COALESCE((
  SELECT SUM(m.valor)
  FROM festasbv.mealheiros m
  WHERE m.evento_id = e.id
    AND m.subtipo = 'sobras_ano_anterior'
), 0)
WHERE e.sobras_aplicadas = 0;
