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
--   'cobre:<n>' quanto deste pedido é que o stock cobre, NA UNIDADE DO PEDIDO
--               ("cobre:0,5" num pedido de 1 kg → falta meio quilo). Cobrindo
--               tudo, o pedido aparece riscado na lista.
--   'ok'        coberto, ponto final → para pedidos SEM quantidade (louro, sal),
--               onde não há número para repartir
--   outro texto FORMATO ANTIGO: o que AINDA FALTA, escrito à mão ("1 kg", "meia
--               caixa"). Continua a ler-se; nada precisa de ser convertido.
--
-- O `cobre:` à frente do número não é enfeite: sem ele, um "1" gravado à moda
-- antiga (= falta 1) passaria a ler-se ao contrário (= cobre 1). É o que deixa
-- mudar o vocabulário da coluna sem migração nenhuma.
--
-- Só se escreve à mão: nenhum caminho automático mexe nesta coluna. O número
-- que a app deduz aparece JÁ PREENCHIDO no modal do artigo (não é preciso
-- escrever nada no caso normal), mas enquanto ninguém lhe tocar a coluna fica
-- NULL e a cobertura continua a acompanhar as alocações — tira-se o stock e o
-- pedido volta sozinho ao "Em falta". Gravar o palpite congelava-o.
--
-- Tolerante: sem esta migração, COB_COL=false, o bloco fica escondido e a
-- cobertura continua a ser só a que a app deduz.
--
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: shoplist.sql.

alter table festasbv.shoplist
  add column if not exists cobertura text;

comment on column festasbv.shoplist.cobertura is
  'Cobertura dita à mão: NULL/vazio = a app deduz do stock; ''cobre:<n>'' = quanto o stock cobre, na unidade do pedido; ''ok'' = coberto (pedidos sem quantidade); qualquer outro texto = formato antigo, o que ainda falta ("1 kg").';
