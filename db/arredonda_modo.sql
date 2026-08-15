-- =====================================================================
-- FestasBV — Migração: MOMENTO do arredondamento total
-- (festasbv.eventos.arredonda_modo)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql.
--
-- O QUE É: "Arredonda Total" (arredonda_total, coluna já existente e
-- sempre ativa desde o schema base) arredonda o total a pagar de cada
-- membro à unidade acima e a diferença vira poupança do grupo. Até aqui
-- só sabia arredondar num MOMENTO — a despesa própria (refeições + quota
-- extra), antes de somar convidados. Esta coluna acrescenta um segundo
-- momento, mais tarde no cálculo: a dívida a liquidar no final (própria
-- + convidados + t-shirts + stock sobrante, já líquida de adiantamentos,
-- mealheiro e reembolsos) — mas SEM contar pagamentos que saldam a
-- própria dívida (🤝), que continuam a comparar-se DEPOIS contra o valor
-- já arredondado. É o que faz "pagar só o valor exato, sem arredondar"
-- deixar o cêntimo em aberto em vez do arredondamento desaparecer.
--
-- Não precisa de tabela nem coluna de estado nova: a base do arredondamento
-- (adiantamentos, mealheiro, reembolsos, refeições, convidados, t-shirts,
-- stock) nunca inclui pagamentos de dívida, por isso a "colagem" ao
-- cêntimo em falta já sai de graça da mesma fórmula que o modo antigo já
-- usava — só muda o que entra na soma antes de arredondar. Ver app.js,
-- dentro de calcular(), a variável `arredondaModo`.
--
-- O TESOUREIRO fica sempre no modo 'despesa', mesmo com 'saldo'
-- escolhido: o saldo dele inclui o saldoGrupo do evento inteiro, que só
-- fecha depois de todos os outros membros já terem o arredondamento
-- calculado — arredondar o dele pela mesma fórmula seria circular.
--
-- Sem esta migração a app funciona à mesma: sonda a coluna
-- (arredondaModoCol=false), o seletor de modo fica escondido e o
-- comportamento é sempre o modo 'despesa' (o de sempre). Com a migração
-- corrida, TODOS os eventos — incluindo anos já fechados — nascem com
-- 'despesa' por DEFAULT: nada muda a menos que o admin escolha 'saldo'
-- explicitamente, ano a ano.
-- =====================================================================

ALTER TABLE festasbv.eventos
  ADD COLUMN IF NOT EXISTS arredonda_modo text NOT NULL DEFAULT 'despesa';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.eventos'::regclass
      AND conname  = 'eventos_arredonda_modo_check'
  ) THEN
    ALTER TABLE festasbv.eventos
      ADD CONSTRAINT eventos_arredonda_modo_check
      CHECK (arredonda_modo IN ('despesa','saldo'));
  END IF;
END $$;

COMMENT ON COLUMN festasbv.eventos.arredonda_modo IS
  'Momento em que "Arredonda Total" arredonda o total a pagar de cada membro: ''despesa'' (defeito) = despesa própria (refeições + quota extra), antes de convidados — o comportamento original; ''saldo'' = dívida a liquidar no final (própria + convidados + t-shirts + stock, líquida de adiantamentos/mealheiro/reembolsos, mas antes de pagamentos de dívida). Só tem efeito com arredonda_total=true. O tesoureiro fica sempre no modo despesa.';
