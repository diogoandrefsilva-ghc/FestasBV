-- =====================================================================
-- FestasBV — Migração: alocação ORIGINAL do lote (stock_lotes.aloc_original)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: stock.sql.
-- Ordem: schema.sql -> functions.sql -> policies.sql -> shoplist.sql ->
--        stock.sql -> ESTE.
--
-- O PORQUÊ: comprei 9 bifes do acém PARA o jantar de sábado. Sobraram 2, e dei-os
-- ao almoço de domingo — o custo vai com eles, e é isso que está certo. Mas ao
-- mover a alocação perdia-se a única coisa que dizia para que é que aquilo tinha
-- sido comprado: o lote passava a dizer "7 no jantar, 2 no almoço" e mais nada,
-- como se tivesse sido isso desde o princípio.
--
-- Não se podia ir buscar essa informação à lista de compras: meter os
-- ingredientes na lista é um passo OPCIONAL, e faz-se uma compra para uma
-- refeição sem nunca lá passar. Quem sabe o objetivo é a própria compra.
--
-- AS DUAS COLUNAS RESPONDEM A PERGUNTAS DIFERENTES:
--
--   aloc_original   PARA QUE É QUE ISTO FOI COMPRADO. Escrita pelo editor da
--                   compra (o campo "Comprado para"), e só por ele.
--   alocacoes       DE QUEM É O CUSTO HOJE. Escrita pelo separador Stock.
--                   É esta, e só esta, que o calcular() lê.
--
-- Ao registar a compra, `alocacoes` HERDA `aloc_original` — são iguais e ninguém
-- nota a diferença. Enquanto ninguém mexer no stock, editar a compra continua a
-- mover as duas (senão corrigir um destino errado na compra passava a exigir
-- duas edições, e a compra ficava a dizer "Jantar de sábado" com o custo noutro
-- sítio, calada). A partir do momento em que divergem, separam-se: o editor da
-- compra mexe só no objetivo e avisa que a alocação real é outra.
--
-- "DIVERGIU" COMPARA-SE, NÃO SE MARCA: se `alocacoes` ≠ `aloc_original`, alguém
-- mexeu. Sem flag para poder mentir — é o mesmo raciocínio do `consumido`
-- (NULL = a app deriva, valor = a mão manda).
--
-- NULL É DIFERENTE DE '[]', e a diferença é importante:
--   NULL   objetivo DESCONHECIDO — os lotes todos que já existiam antes desta
--          migração. Deles não se conta história nenhuma: sem original não há
--          "sobra" nem "realocado", e a app comporta-se exactamente como antes.
--   '[]'   comprado SEM destino declarado (ficou por alocar). É uma resposta.
-- Por isso a coluna é anulável e não tem DEFAULT: pôr '[]' de defeito fazia cada
-- lote antigo parecer "comprado para nada" e cada alocação existente parecer uma
-- realocação, enchendo os cartões das refeições de sobras que nunca houve.
--
-- NÃO ENTRA EM CONTA NENHUMA. O calcular() não sabe que esta coluna existe e não
-- pode passar a saber: o dinheiro segue `alocacoes`, ponto. Se um dia isto
-- entrar numa conta, deixa de ser o registo de um objetivo e passa a ser um
-- segundo eixo de custo — que é precisamente o que esta separação evita.
--
-- Sem esta migração a app funciona à mesma: a sonda é tolerante
-- (STOCK_ALOCORIG_COL=false), a coluna nunca é lida nem escrita e o editor da
-- compra volta a mexer directamente na alocação real, como sempre fez.
-- =====================================================================

ALTER TABLE festasbv.stock_lotes
  ADD COLUMN IF NOT EXISTS aloc_original jsonb;

COMMENT ON COLUMN festasbv.stock_lotes.aloc_original IS
  'Para que refeição/tipo é que este lote foi COMPRADO — a alocação tal como a compra a declarou. Mesma forma de `alocacoes` [{tipo,data,qtd,bebida?}]. NULL = desconhecido (lotes anteriores à migração); [] = comprado sem destino. Só o editor da compra escreve aqui; não entra no calcular().';

-- Sem policies novas: a coluna vive na stock_lotes e herda as dela (ver
-- stock.sql). Quem registra e edita a compra é quem escreve o objetivo dela.
