-- =====================================================================
-- FestasBV — Migração: Alocação de STOCK (festasbv.stock_lotes.aloc_stock)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: stock.sql, stock_alocacao_original.sql.
-- Ordem: schema.sql -> functions.sql -> policies.sql -> shoplist.sql ->
--        stock.sql -> stock_alocacao_original.sql -> ESTE.
--
-- O TERCEIRO EIXO. O stock passa a responder a três perguntas, cada uma na
-- sua coluna, e cada uma editável NUM SÍTIO SÓ:
--
--   1. aloc_original  PARA QUE É QUE FOI COMPRADO
--      Escreve-a só o editor da COMPRA. É o que o cartão da refeição mostra
--      em "🧺 Comprado" — comprei 5 pacotes para o jantar de sexta.
--
--   2. alocacoes      DE QUEM É O CUSTO
--      Escreve-a só o separador STOCK. É a ÚNICA que o calcular() lê. Sem
--      ajuste nenhum vale o que a compra disse (a app copia-a ao gravar a
--      compra); feito o ajuste, a compra deixa de lhe tocar.
--
--   3. aloc_stock     ONDE É QUE A MERCADORIA FOI PARAR   ← esta migração
--      Escreve-a só o separador STOCK. NULL = herda a de cima (o caso
--      normal, e por isso não obriga a escrever nada). Preenchida, é ela que
--      diz o que se consumiu, onde, e o que se DEITOU FORA.
--
-- PORQUÊ UM TERCEIRO: porque "quem paga" e "onde foi parar" deixaram de ser a
-- mesma pergunta. Compraram-se 5 pacotes de batata palha para o jantar de
-- sexta, gastaram-se 3,5 e o 1,5 que sobrou não se aproveita — deita-se fora.
-- O custo é todo da sexta (foi ela que os comprou, eixo 2 intacto), mas a
-- mercadoria repartiu-se: 3,5 comidos na sexta, 1,5 para o lixo. Sem este
-- eixo, dizer isso obrigava a mexer na alocação do CUSTO — que é exatamente
-- o que não se quer.
--
-- O DESPERDÍCIO É UM DESTINO DAQUI, não uma coluna própria: `{"tipo":
-- "Desperdicio","qtd":1.5}`, ao lado das refeições, dos tipos puros e do 🎒
-- de uma pessoa. É o que o torna repartível ("1,5 para o lixo, 3,5 para a
-- sexta") e o que o mantém fora das contas — o calcular() lê `alocacoes` e
-- mais nada.
--
-- FORMA: a mesma de `alocacoes`/`aloc_original` — array de
--   {tipo, data, qtd, bebida?, pessoa?} —, para o vocabulário todo da app
-- (destinoAloc/alocToDestino/destKeyCmp) servir os três eixos sem exceções.
--
-- NULL ≠ []: NULL = não há ajuste, herda-se o eixo 2; [] = ajustou-se para
-- "nada alocado", que é uma resposta (está tudo na garagem por gastar). É a
-- mesma distinção do aloc_original, e pela mesma razão.
--
-- Sem esta migração a app funciona à mesma: a sonda é tolerante
-- (STOCK_ALOCSTK_COL=false), a coluna nunca é lida nem escrita e o consumo
-- volta a derivar-se da alocação do custo, como antes.
-- =====================================================================

ALTER TABLE festasbv.stock_lotes
  ADD COLUMN IF NOT EXISTS aloc_stock jsonb;

COMMENT ON COLUMN festasbv.stock_lotes.aloc_stock IS
  'Onde a MERCADORIA foi parar (3.º eixo): refeições onde se consumiu, 🗑 Desperdicio, 🎒 pessoa. NULL = herda alocacoes. Não entra no calcular() — o custo é sempre alocacoes.';

-- A coluna `desperdicio` (db/stock_desperdicio.sql, de uma tentativa anterior)
-- deixou de ser usada: o desperdício passou a ser um destino desta. Se ela
-- chegou a ser criada, pode largar-se — nada a lê nem a escreve:
--   ALTER TABLE festasbv.stock_lotes DROP COLUMN IF EXISTS desperdicio;

-- Sem policies novas: a coluna vive na stock_lotes e herda as dela (ver
-- stock.sql). Quem pode mexer na alocação do custo pode mexer nesta — é a
-- mesma gestão de stock, e a app limita-a ao admin na UI pela mesma razão.
