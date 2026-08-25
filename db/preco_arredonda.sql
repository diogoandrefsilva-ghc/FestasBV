-- =====================================================================
-- FestasBV — Migração: ARREDONDAMENTO do preço unitário da refeição
-- (festasbv.eventos.preco_arredonda)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql.
--
-- O QUE É: o custo de uma refeição divide-se por quem lá esteve em três
-- parcelas por pessoa — direto (Fdir/Ncomem), bebida (Fbeb/Ndiv) e
-- indireto (I/Ndiv). Cada uma tem de aterrar num número de cêntimos, e
-- há duas maneiras de o fazer:
--   'cent' — arredonda ao cêntimo mais próximo (rnd). O grupo pode ficar
--            a cobrar um cêntimo a menos do que gastou nessa refeição.
--   'cima' — arredonda ao cêntimo ACIMA (roundup). O grupo nunca fica a
--            perder; o que sobra do arredondamento vai para a sobra.
--
-- POR QUE É QUE ISTO É POR ANO, e não uma regra global: um ano cujas
-- contas já fecharam tem de continuar a dar os MESMOS números para
-- sempre. A app não guarda o apuramento — recalcula-o ao vivo a partir
-- dos dados —, por isso mudar a regra de arredondamento mexia, em
-- silêncio, na sobra de todos os anos já fechados. Foi o que aconteceu:
-- 2025 fechou a 03/08/2026 com 126,45 € de sobra e passou a mostrar
-- 129,45 € quando o unitário passou a arredondar para cima (17/08/2026),
-- enquanto 2026 fechou já com a regra nova e tem de continuar nos
-- 208,20 €. Com a coluna, cada ano guarda a regra com que fechou.
--
-- DEFEITO 'cima': é o comportamento em vigor, logo nada muda em lado
-- nenhum só por se correr esta migração. O UPDATE a seguir é que repõe
-- 'cent' nos eventos que JÁ ESTAVAM FECHADOS antes de a regra ter
-- mudado — e só nesses. Um ano por fechar, ou fechado depois, fica como
-- está.
--
-- Sem esta migração a app funciona à mesma: sonda a coluna
-- (precoArredondaCol=false), o seletor fica escondido e o unitário
-- arredonda sempre para cima, como hoje.
-- =====================================================================

ALTER TABLE festasbv.eventos
  ADD COLUMN IF NOT EXISTS preco_arredonda text NOT NULL DEFAULT 'cima';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.eventos'::regclass
      AND conname  = 'eventos_preco_arredonda_check'
  ) THEN
    ALTER TABLE festasbv.eventos
      ADD CONSTRAINT eventos_preco_arredonda_check
      CHECK (preco_arredonda IN ('cima','cent'));
  END IF;
END $$;

-- Anos que já tinham as contas fechadas ANTES de o unitário passar a
-- arredondar para cima (commit a2f96e8, 17/08/2026 19:11 WEST = 18:11
-- UTC) foram apurados com 'cent' e é assim que se têm de manter. O
-- `preco_arredonda = 'cima'` na condição faz disto um no-op quando se
-- volta a correr o ficheiro depois de alguém ter escolhido outra coisa
-- à mão.
UPDATE festasbv.eventos
   SET preco_arredonda = 'cent'
 WHERE contas_fechadas
   AND contas_fechadas_em IS NOT NULL
   AND contas_fechadas_em < timestamptz '2026-08-17 18:11:00+00'
   AND preco_arredonda = 'cima';

COMMENT ON COLUMN festasbv.eventos.preco_arredonda IS
  'Como se arredonda cada parcela do preço unitário de uma refeição (direto, bebida, indireto): ''cima'' (defeito) = cêntimo acima, o grupo nunca fica a perder e o resto vai para a sobra; ''cent'' = cêntimo mais próximo, o comportamento anterior a 17/08/2026. É por ANO porque o apuramento é recalculado ao vivo: um ano fechado tem de continuar a dar os números com que fechou.';
