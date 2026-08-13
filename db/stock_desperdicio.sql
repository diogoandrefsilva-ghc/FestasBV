-- =====================================================================
-- FestasBV — Migração: Desperdício (festasbv.stock_lotes.desperdicio)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: stock.sql, stock_consumo.sql.
-- Ordem: schema.sql -> functions.sql -> policies.sql -> shoplist.sql ->
--        stock.sql -> stock_consumo.sql -> ESTE.
--
-- O PORQUÊ: compraram-se 5 pacotes de batata palha para o jantar de sexta.
-- Gastaram-se 3,5. O 1,5 que sobrou não vai para outra refeição nem para o ano
-- seguinte — deita-se fora. E até aqui a app não tinha onde o dizer:
--
--   · deixá-lo "por gastar" era mentira: aquilo já não está cá, e ficava a
--     aparecer para sempre como stock disponível no separador e nas folhas;
--   · dar baixa dos 5 (consumo à mão) escondia o problema: passava a dizer que
--     se gastaram 5 quando se gastaram 3,5. Quem no ano seguinte fosse ver
--     quanto se consumiu comprava 5 outra vez;
--   · alocá-lo a outro sítio — a bolsa comum, uma pessoa (🎒) — mexia no CUSTO,
--     que é precisamente o que não se quer: a batata palha foi comprada para o
--     jantar de sexta e é ele que a paga, sobre ou não sobre.
--
-- O QUE ESTA COLUNA É: a quantidade do lote que se DEITOU FORA.
--
--   desperdicio IS NULL  → não se desperdiçou nada (o caso normal).
--   desperdicio = <n>    → deitaram-se fora n. Sai do stock disponível, mas
--                          NÃO conta como gasto: são duas leituras diferentes.
--
-- É o TERCEIRO estado do eixo do CONSUMO, ao lado do gasto e do por gastar:
--
--     qtd = gasto + desperdício + por gastar
--
-- e por isso o gasto derivado (o que está alocado a refeições passadas) passa a
-- ser limitado a `qtd - desperdicio`: num lote de 5 alocado a uma sexta que já
-- passou, marcar 1,5 de desperdício deixa o gasto em 3,5 sozinho, sem ninguém
-- ter de o escrever à mão.
--
-- O QUE NÃO MUDA — e é o ponto todo: `alocacoes` fica exatamente como estava e
-- o calcular() não sabe que esta coluna existe. Dizer que se deitou fora não
-- move um cêntimo: o custo continua na refeição para que a compra foi feita.
-- Desperdício é uma leitura de despensa (o que ainda cá está), NUNCA um destino
-- de custo — se um dia entrar nas contas, deixa de ser isto.
--
-- Sem esta migração a app funciona à mesma: a sonda é tolerante
-- (STOCK_PERDA_COL=false), a coluna nunca é lida nem escrita e o eixo do
-- consumo volta a ter dois estados, como antes.
-- =====================================================================

ALTER TABLE festasbv.stock_lotes
  ADD COLUMN IF NOT EXISTS desperdicio numeric;

COMMENT ON COLUMN festasbv.stock_lotes.desperdicio IS
  'Quantidade deste lote que se deitou fora. NULL = nenhuma. Sai do stock disponível mas não conta como gasto (é o 3.º estado do eixo do consumo). Não entra no calcular() — o custo fica na alocação que estiver.';

-- Sem policies novas: a coluna vive na stock_lotes e herda as dela (ver
-- stock.sql). Quem pode mexer nas alocações e no consumo pode marcar
-- desperdício — é a mesma gestão de stock, e a app limita-a ao admin na UI
-- pela mesma razão.
