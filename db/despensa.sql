-- =====================================================================
-- FestasBV — Migração: Artigos de despensa (festasbv.artigos_despensa)
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: functions.sql (is_allowed/is_admin).
-- Ordem: schema.sql -> functions.sql -> policies.sql -> shoplist.sql ->
--        stock.sql -> categorias.sql -> ESTE.
--
-- O QUE É: há dois tipos de artigo na lista de compras e a app tratava-os
-- como um só:
--
--   CONSUMÍVEL   a procura escala com o número de refeições. Três jantares
--                com carne precisam de três vezes a carne. Dois pedidos para
--                refeições diferentes NÃO são duplicados.
--
--   DESPENSA     compra-se UMA embalagem e ela chega para o evento todo:
--                azeite, sal, pimenta, louro, orégãos, colorau. Cada cozinheiro
--                escreve-o na lista da SUA refeição (e faz bem — precisa de
--                saber que o prato leva azeite), mas quem vai às compras não
--                pode ver três linhas de "Azeite" e trazer três garrafas.
--
-- Esta tabela é a memória de QUAIS os nomes que são de despensa. É GLOBAL
-- (sem evento_id — o azeite é despensa em todos os anos) e a chave é o nome
-- NORMALIZADO (minúsculas, sem acentos — o shopArtKey da app), tal como no
-- artigo_categorias, por isso "Azeite" e "azeite" são o mesmo artigo.
--
-- É A MESMA DISTINÇÃO NO 🧺 STOCK, e é lá que ela hoje se usa: um artigo de
-- despensa NÃO SE ESGOTA por alocação. E isso muda tudo o que a app pode dizer
-- sobre ele:
--
--   10 pacotes de batatas fritas   alocar 3 ao almoço de sábado deixa 7. A
--                                  conta faz-se, e sábado passado foram-se 3.
--   1 frasco de pimenta            serve os jantares todos e ainda sobra para
--                                  o ano seguinte. Alocá-lo a uma refeição não
--                                  gasta nada — e dizer "25%" é inventar um
--                                  número que ninguém sabe medir.
--
-- Por isso, num artigo marcado aqui:
--   · a app DESLIGA a derivação do consumo (stock_consumo.sql): uma refeição
--     passada já não o dá por gasto, que seria mentira;
--   · o consumo passa a ser um INTERRUPTOR — ainda há / acabou —, que é a
--     única pergunta a que se sabe responder olhando para a prateleira;
--   · o cartão do stock troca as contas de quantidade por esse estado.
--
-- A alocação (o eixo do CUSTO) fica na mesma e continua livre: o frasco pode
-- estar em Gerais ou repartido por refeições, como sempre esteve.
--
-- origem='heur' marca o que a deteção local propôs (o artigo é pedido em duas
-- ou mais refeições e nenhuma escreve quantidade — o padrão do sal e do louro),
-- 'ai' o que veio do Gemini, 'manual' o que foi decidido por pessoas. A app só
-- SUGERE: nada fica gravado sem o admin confirmar, porque a deteção erra em
-- casos legítimos (salsa, coentros e hortelã repetem-se entre refeições mas são
-- fresco — compram-se por refeição e gastam-se).
--
-- Sem esta migração a app funciona à mesma: o fetch é tolerante
-- (DESP_TABLE=false) e tudo o que é despensa fica simplesmente escondido.
-- =====================================================================

CREATE TABLE IF NOT EXISTS festasbv.artigos_despensa (
  artigo_key    text PRIMARY KEY,                 -- shopArtKey(artigo): minúsculas, sem acentos
  origem        text NOT NULL DEFAULT 'manual',   -- 'manual' | 'ai' | 'heur'
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- GRANTs (sem isto: HTTP 403 / 42501)
GRANT ALL ON TABLE festasbv.artigos_despensa TO anon, authenticated;

-- RLS
ALTER TABLE festasbv.artigos_despensa ENABLE ROW LEVEL SECURITY;

-- Todos os membros leem (a marca 🫙 e o estado "há/acabou" são para toda a
-- gente — quem cozinha precisa de saber se ainda há sal); só o admin decide o
-- que é despensa, que é uma marca GLOBAL: muda como o artigo é lido em todos
-- os anos e para toda a gente.
DROP POLICY IF EXISTS artigos_despensa_sel   ON festasbv.artigos_despensa;
DROP POLICY IF EXISTS artigos_despensa_admin ON festasbv.artigos_despensa;

CREATE POLICY artigos_despensa_sel ON festasbv.artigos_despensa
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());

CREATE POLICY artigos_despensa_admin ON festasbv.artigos_despensa
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());
