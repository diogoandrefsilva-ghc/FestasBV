-- =====================================================================
-- FestasBV — Migração: desconto no preço da refeição para as mulheres
-- (festasbv.eventos.desconto_sexo)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql -> functions.sql -> policies.sql.
--
-- O QUE É: o preço da refeição (direto + bebida + indireto por cabeça)
-- era igual para toda a gente. Passa a poder ter DOIS preços — um para
-- os homens, outro para as mulheres —, com a percentagem a dizer quanto
-- é que elas pagam MENOS DO QUE ELES.
--
-- UM PARÂMETRO SÓ, e é o que faz as contas fecharem. O agravamento dos
-- homens não se escreve: DERIVA da contagem daquela refeição.
--
--     W  = Nh + Nm*(1-d)         soma dos pesos de quem come
--     Ph = L * Ncomem / W        homem
--     Pm = Ph * (1-d)            mulher
--
-- O total continua a ser exatamente L * Ncomem — nem um cêntimo a mais
-- nem a menos. Só muda quem o põe: com 8 homens e 4 mulheres a 20%,
-- L=14,00 € dá 15,00 € e 12,00 € (8*15 + 4*12 = 168 = 14*12).
--
-- `d` é a distância ENTRE ELES, não o desconto face ao preço de hoje.
-- É de propósito, e por duas razões: a frase "elas pagam menos 20% do
-- que eles" fica verdadeira seja qual for a mistura; e uma refeição só
-- de mulheres fecha sozinha (todas pagam L), sem caso especial nenhum.
-- Definido face ao preço neutro, essa refeição cobrava 80% do custo e
-- faltava o resto.
--
-- SÓ UM SEXO NA REFEIÇÃO → preço único, e é o L de sempre. Não é um
-- atalho: com nF=0 a fórmula daria Pf = L*(1-d), um preço que ninguém
-- paga e que nem sequer é o que uma mulher pagaria se aparecesse — com
-- ela presente o split recalcula-se todo (nH=5, nF=1, d=20% dá 1,034L e
-- 0,827L, não L e 0,8L). O cartão mostra dois preços sempre que eles
-- diferem, logo estaria a anunciar uma ficção.
--
-- O MÍNIMO (min_meo) aplica-se aos DOIS preços, depois do split: é um
-- piso ("ninguém paga menos que X por uma refeição") que não tem
-- exceção feminina. Quando morde, cobra-se a mais e o excedente vai
-- para o saldo do grupo — que é o que já acontecia antes desta coluna.
--
-- O ARREDONDAMENTO deixa um resíduo, e é intrínseco: com um preço por
-- sexo expresso em cêntimos, a soma do que os membros pagam afasta-se
-- do custo da refeição em no máximo (nH+nF)*0,005 (medido: máx. 0,14 €
-- numa refeição de 350 €, média 0,025 €). Não se corrige dando o
-- cêntimo à parcela maior, como na fatura, porque aqui todos os homens
-- pagam O MESMO preço — é isso uma tabela de preços. Vai para o saldo
-- do grupo, ao lado de dois resíduos da mesma família e bem maiores: o
-- excedente do min_meo e o arredondamento PARA CIMA da quota do
-- convidado (roundup + extra).
--
-- OS CONVIDADOS FICAM DE FORA: a linha de convidado é "n adultos", sem
-- nome nem sexo, logo não há por onde. A quota (Q/Qbebe) continua a
-- derivar do preço NEUTRO, exatamente como sempre.
--
-- O sexo já vivia em festasbv.membros.sexo (schema.sql), onde já
-- descontava no fator variável. Esta coluna não lhe toca: são bolsas
-- diferentes — o fator reparte o que é de todos, isto é o prato.
--
-- SÓ EM ANOS ABERTOS: a app impede o ajuste (campo desativado) quando
-- `contas_fechadas` é verdadeiro. É uma trava do lado do cliente, como
-- a % dos Indiretos e a Missão Poupança — só o admin escreve em
-- `eventos` (policy eventos_admin, FOR ALL), por isso não é preciso
-- trigger para proteger a própria coluna.
--
-- Sem esta migração a app funciona à mesma: sonda a coluna
-- (DESC_SEXO_COL=false), o campo fica escondido e o preço da refeição é
-- um só, como sempre foi. A 0 o comportamento é igualmente o de sempre.
-- =====================================================================

ALTER TABLE festasbv.eventos
  ADD COLUMN IF NOT EXISTS desconto_sexo numeric NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'festasbv.eventos'::regclass
      AND conname  = 'eventos_desconto_sexo_check'
  ) THEN
    -- Tecto em 0.9: a 1 (100%) as mulheres pagavam zero e todo o custo
    -- caía nos homens — que é uma decisão diferente desta, e que a
    -- fórmula do rácio não sabe exprimir (W colapsava em Nh).
    ALTER TABLE festasbv.eventos
      ADD CONSTRAINT eventos_desconto_sexo_check
      CHECK (desconto_sexo >= 0 AND desconto_sexo <= 0.9);
  END IF;
END $$;

COMMENT ON COLUMN festasbv.eventos.desconto_sexo IS
  'Fração (0–0.9) que as mulheres pagam a menos que os homens no preço da refeição (come e só bebe). O agravamento deles deriva da contagem de cada refeição, pelo que o total cobrado não muda. Convidados ficam de fora (quota derivada do preço neutro). Defeito 0 = preço único, o comportamento de sempre.';
