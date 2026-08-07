-- =====================================================================
-- FestasBV — Migração: Consumo do stock (festasbv.stock_lotes.consumido)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: stock.sql.
-- Ordem: schema.sql -> functions.sql -> policies.sql -> shoplist.sql ->
--        stock.sql -> ESTE.
--
-- O PORQUÊ: até aqui a app tinha UM eixo só — a alocação — e fazia-o responder
-- a duas perguntas diferentes:
--
--   ALOCAÇÃO   para onde vai o CUSTO deste artigo (que refeição o paga, ou
--              que bolsa comum: Gerais, Bebidas, Cerveja).
--   CONSUMO    o que já se GASTOU — o que ainda está cá para cozinhar.
--
-- Nas batatas fritas as duas coincidem e ninguém dá pela diferença: aloco 3
-- pacotes ao almoço de sábado, sábado passa, foram-se 3. Mas:
--
--   · 100 cervejas em "Bebidas" (tipo puro, sem data) ficavam ALOCADAS para
--     sempre — nunca consumidas, e a app também não as contava como stock
--     disponível. Eram um buraco: nem cá, nem gastas.
--   · um frasco de pimenta serve os jantares todos e ainda sobra para o ano
--     seguinte. Alocá-lo a uma refeição não o gasta — mas a app dava-o por
--     consumido mal essa refeição passasse. (Ver db/despensa.sql.)
--
-- O QUE ESTA COLUNA É: a quantidade do lote que JÁ SE GASTOU.
--
--   consumido IS NULL   → DERIVADO (o comportamento de sempre): conta-se o que
--                         está alocado a refeições cuja data já passou. É o
--                         caso normal e não obriga a escrever nada.
--   consumido = <n>     → DITO À MÃO: é este o valor, ponto — a app deixa de
--                         adivinhar para este lote ("bebemos 40, não sei de que
--                         refeição"). Volta ao automático pondo NULL outra vez.
--
-- Nos artigos de despensa (db/despensa.sql) a derivação está desligada — seria
-- mentira — e a coluna vale como interruptor: NULL = ainda há, = qtd = acabou.
--
-- O QUE NÃO MUDA: `alocacoes` fica exatamente como estava e o calcular() não
-- lhe toca. O consumo é leitura de despensa/cozinha, NÃO entra em conta
-- nenhuma: não mexe em quotas, saldos, rateios nem no custo das refeições.
-- Marcar cerveja como bebida não muda um cêntimo — só diz que já não está cá.
--
-- Sem esta migração a app funciona à mesma: a sonda é tolerante
-- (STOCK_CONS_COL=false), o consumo volta a ser só o derivado e o que se
-- escreve à mão fica escondido.
-- =====================================================================

ALTER TABLE festasbv.stock_lotes
  ADD COLUMN IF NOT EXISTS consumido numeric;

COMMENT ON COLUMN festasbv.stock_lotes.consumido IS
  'Quantidade já gasta deste lote. NULL = derivado das alocações a refeições passadas; número = dito à mão. Não entra no calcular().';

-- Sem policies novas: a coluna vive na stock_lotes e herda as dela (ver
-- stock.sql). Quem pode mexer nas alocações pode mexer no consumo — é a mesma
-- gestão de stock, e a app limita-a ao admin na UI pela mesma razão.
