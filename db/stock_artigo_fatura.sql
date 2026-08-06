-- Nome original da fatura (db/stock_artigo_fatura.sql)
--
-- O PORQUÊ: o nome que o talão imprime e o nome por que a pessoa conhece o
-- artigo são coisas diferentes, e as duas fazem falta.
--
--   talão:  "Qj Prato Pequeno Casteloes Un"     ← o que se pagou
--   stock:  "Queijo Castelões"                  ← o que se procura na despensa
--
-- Até aqui só havia um sítio para os dois: `artigo`. Quem renomeasse o artigo
-- para o poder encontrar depois perdia a única ligação ao que estava escrito na
-- fatura — e é essa que responde a "isto foi mesmo o que comprámos?" quando se
-- vai conferir uma despesa meses depois.
--
-- As três colunas dizem coisas diferentes e nenhuma substitui as outras:
--
--   artigo         o nome de trabalho, editável, o que se vê no 🧺 Stock
--   lista_artigo   o PEDIDO da lista a que este lote responde
--   artigo_fatura  o que a fatura dizia, tal como foi lido. Não se edita.
--
-- Só se escreve uma vez, no registo da compra, e só quando o artigo veio mesmo
-- de uma fatura importada: um artigo escrito à mão não tem nome de fatura
-- nenhum, e inventar-lhe um seria mentir sobre a origem. Fica NULL.
--
-- TOLERANTE: sem esta migração a app corre na mesma (STOCK_FAT_COL=false) —
-- a coluna nunca é escrita nem lida e tudo se comporta como antes.

alter table festasbv.stock_lotes
  add column if not exists artigo_fatura text;

comment on column festasbv.stock_lotes.artigo_fatura is
  'Nome do artigo tal como foi lido da fatura importada. Não editável; NULL nos artigos escritos à mão.';
