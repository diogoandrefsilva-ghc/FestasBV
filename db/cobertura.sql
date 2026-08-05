-- Cobertura declarada à mão (db/cobertura.sql)
--
-- O PORQUÊ: a app deduz sozinha se um pedido da lista já está coberto pelo
-- stock — soma o que está alocado àquela refeição e compara com o que foi
-- pedido. Isso funciona enquanto os dois lados falarem a MESMA unidade.
--
--   pedido "3 kg de batata"  ·  lote de 5 kg alocado ao jantar   → coberto ✓
--   pedido "2 embalagens"    ·  lote de 5 kg alocado ao jantar   → ???
--
-- No segundo caso não há conta que se faça: ninguém sabe quantos kg tem uma
-- embalagem (e adivinhar seria pior do que não saber — daria uma lista a dizer
-- "está tratado" e uma cozinha sem batatas). Quem sabe é a pessoa. Esta coluna
-- é onde ela o diz.
--
--   NULL / ''   nada dito → vale o que a app deduzir do stock (como sempre)
--   'ok'        coberto, ponto final → o pedido aparece riscado na lista
--   outro texto o que AINDA FALTA, como a pessoa o escreve ("1 kg", "meia
--               caixa") → o pedido continua por comprar, com essa nota
--
-- É texto livre de propósito: a unidade do que falta pode não ser a do pedido
-- ("pedi 2 embalagens, falta 1 kg") e o objetivo aqui é justamente não obrigar
-- ninguém a converter nada.
--
-- Só se escreve à mão: nenhum caminho automático mexe nesta coluna, para que
-- uma alocação de stock nunca apague o que uma pessoa declarou.
--
-- Tolerante: sem esta migração, COB_COL=false, o bloco fica escondido e a
-- cobertura continua a ser só a que a app deduz.
--
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: shoplist.sql.

alter table festasbv.shoplist
  add column if not exists cobertura text;

comment on column festasbv.shoplist.cobertura is
  'Cobertura dita à mão: NULL/vazio = a app deduz do stock; ''ok'' = coberto; qualquer outro texto = o que ainda falta ("1 kg").';
