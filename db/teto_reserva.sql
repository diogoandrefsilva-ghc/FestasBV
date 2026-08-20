-- =====================================================================
-- FestasBV — Migração: Teto da sobra do grupo (eventos.teto_reserva)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Ordem: schema.sql -> functions.sql -> policies.sql -> ESTE.
--
-- O PORQUÊ: no fim do evento sobra sempre alguma coisa (`saldoGrupo`) — o
-- excedente do mínimo por refeição, a margem da quota do convidado, o
-- arredondamento, o Fundo de Reserva cobrado de propósito. Essa sobra fica
-- guardada com o tesoureiro e vai engordando de ano para ano. Só que a
-- partir de certo ponto guardar mais deixa de fazer sentido: o grupo não
-- precisa de 2000 € parados, precisa de uma almofada.
--
-- O QUE ESTA COLUNA É: o TETO da sobra DESTE evento. `saldoGrupo` acima
-- dele não se guarda — devolve-se aos membros, proporcionalmente ao que
-- cada um paga, como um desconto no que tem a liquidar.
--
--   teto = 200 €, o evento sobrava 340 €  ->  devolvem-se 140 € aos
--   membros (proporcional ao `m.Sown` de cada um — o que gastou nas
--   refeições, incluindo aquelas em que só bebeu) e a sobra fica em 200 €.
--
-- NÃO É UM TETO SOBRE A POUPANÇA ACUMULADA (a de todos os anos, ver
-- `poupancaAcumuladaAte`). É de propósito: o `calcular()` é uma função pura
-- de UM ano, e a acumulada é a soma dos `saldoGrupo` de todos eles — um teto
-- sobre o pote obrigaria o cálculo de um ano a chamar o dos anteriores, e
-- como o `saldoDoAno()` chama o próprio `calcular()`, isso abre uma recursão
-- entre anos que hoje não existe. O pote continua a controlar-se pelo lado
-- que já existia: "usar sobras de anos anteriores" (`sobras_aplicadas`).
--
-- NULL ou vazio = SEM TETO, que é o comportamento de sempre e o de cada ano
-- novo. Zero é um teto a sério ("não guardar nada"), e não é o mesmo que
-- não ter teto — daí a coluna ser nullable e não ter DEFAULT 0.
--
-- Sem esta migração a app funciona à mesma: a sonda é tolerante
-- (`tetoReservaCol`, lida do próprio `select=*` como as outras colunas do
-- evento), o campo fica escondido em Parametrizações e nada se devolve.
-- =====================================================================

ALTER TABLE festasbv.eventos
  ADD COLUMN IF NOT EXISTS teto_reserva numeric;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='festasbv.eventos'::regclass AND conname='eventos_teto_reserva_check'
  ) THEN
    ALTER TABLE festasbv.eventos
      ADD CONSTRAINT eventos_teto_reserva_check
      CHECK (teto_reserva IS NULL OR teto_reserva >= 0);
  END IF;
END $$;

COMMENT ON COLUMN festasbv.eventos.teto_reserva IS
  'Teto da sobra do grupo (saldoGrupo) DESTE evento. O que passar daqui é devolvido aos membros, proporcional ao que cada um gastou em refeições (m.Sown). NULL = sem teto (o comportamento de sempre); 0 = teto a sério, não guardar nada.';

-- Sem policies novas: a coluna vive na `eventos` e herda as dela — só o
-- `is_admin()` escreve, como em todas as parametrizações do ano.
