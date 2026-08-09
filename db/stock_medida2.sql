-- =====================================================================
-- FestasBV — Migração: 2.ª medida de um lote (festasbv.stock_lotes.qtd2)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: stock.sql.
-- Ordem: schema.sql -> functions.sql -> policies.sql -> shoplist.sql ->
--        stock.sql -> ESTE.
--
-- O PORQUÊ: há artigos que se compram numa medida e se cozinham noutra, e as
-- duas fazem falta ao mesmo tempo.
--
--   o talão diz          4,032 kg de bifes do acém        (é o que se pagou)
--   a cozinha diz        9 bifes                          (é o que se serve)
--
-- Até aqui só havia uma medida por lote (`qtd` + `unidade`), e ela tinha de ser
-- a do dinheiro — é com ela que o custo se reparte pelas refeições. Quem
-- quisesse alocar "os dois bifes que sobraram" ao jantar seguinte tinha de
-- fazer a regra de três de cabeça (2 de 9 → 0,896 kg) e escrever o resultado.
--
-- O QUE ESTAS COLUNAS SÃO: a MESMA quantidade do lote, contada de outra
-- maneira. `qtd2 = 9`, `unidade2 = 'bifes'` a par de `qtd = 4.032`,
-- `unidade = 'kg'` quer dizer *estes 4,032 kg são 9 bifes* — e é isso que dá à
-- app o fator de conversão DESTE lote (2,232 bifes por kg).
--
-- NUNCA SE ADIVINHA A CONVERSÃO — é a mesma regra da shoplist.cobertura. A app
-- não sabe (nem pode saber) quantos kg tem um bife: quem sabe é quem esteve no
-- talho, e é ele que o escreve. Sem estas colunas escritas, unidades diferentes
-- continuam a não se comparar nem a somar, como em todo o resto da app.
--
-- O QUE NÃO MUDA — e é preciso que assim continue:
--   · `alocacoes` continua em `unidade` (a do dinheiro). A 2.ª medida é só a
--     LÍNGUA em que se escreve e se lê o número; o que fica gravado é sempre a
--     quantidade canónica. O calcular() não sabe que estas colunas existem.
--   · o guarda-chuva do stock continua a ser ARTIGO + UNIDADE: 4 kg de bacalhau
--     e 3 postas dele são dois cartões, mesmo que um deles declare a 2.ª medida.
--   · a cobertura dos pedidos da lista continua a exigir a MESMA unidade. Um
--     pedido de "2 bifes" não passa a ser coberto por um lote em kg — para isso
--     há a cobertura dita à mão (db/cobertura.sql), que é onde essa afirmação
--     tem de ser de uma pessoa e não da app.
--
-- Sem esta migração a app funciona à mesma: a sonda é tolerante
-- (STOCK_MED2_COLS=false), as colunas nunca são lidas nem escritas e tudo se
-- comporta como antes.
-- =====================================================================

ALTER TABLE festasbv.stock_lotes
  ADD COLUMN IF NOT EXISTS qtd2     numeric,
  ADD COLUMN IF NOT EXISTS unidade2 text;

COMMENT ON COLUMN festasbv.stock_lotes.qtd2 IS
  'A mesma quantidade do lote contada noutra unidade (9 bifes para os 4,032 kg). NULL = não declarada. Dá o fator de conversão DESTE lote; não entra no calcular().';
COMMENT ON COLUMN festasbv.stock_lotes.unidade2 IS
  'Unidade da 2.ª medida (bifes, un, kg, …). Tem de ser diferente de `unidade` — a mesma unidade não é uma segunda medida.';

-- Sem policies novas: as colunas vivem na stock_lotes e herdam as dela (ver
-- stock.sql). Quem pode mexer nas alocações pode declarar a 2.ª medida — é a
-- mesma gestão de stock, e a app limita-a ao admin na UI pela mesma razão.
