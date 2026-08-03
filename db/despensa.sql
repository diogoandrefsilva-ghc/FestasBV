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
-- O QUE MUDA NA APP (nada disto apaga pedidos — é agregação, não destruição):
--   · lista da refeição  — a linha fica, marcada 🫙 (o cozinheiro continua a
--                          ver que o prato leva azeite);
--   · separador Compras  — todos os pedidos do artigo colapsam numa ÚNICA
--                          linha, numa secção 🫙 Despensa, com as refeições
--                          que o pediram por baixo. Um toque no ＋🛒 leva o
--                          grupo todo;
--   · cobertura          — havendo lote comprado desse artigo, TODOS os
--                          pedidos ficam cobertos (é o que significa "uma
--                          embalagem serve tudo"), sem obrigar a alocar a
--                          cada refeição uma a uma.
--
-- origem='heur' marca o que a deteção local propôs (repetido em ≥2 refeições
-- e sem quantidade indicada), 'ai' o que veio do Gemini, 'manual' o que foi
-- decidido por pessoas. Em qualquer dos casos só fica gravado depois de o
-- admin confirmar no 3.º passo do 🔤 Normalizar.
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

-- Todos os membros leem (a marca 🫙 e o colapso da lista são para toda a
-- gente); só o admin decide o que é despensa — marcar um artigo muda a lista
-- de compras de todos, e a deteção erra em casos legítimos (salsa, coentros e
-- hortelã repetem-se entre refeições mas são fresco: compram-se por refeição).
DROP POLICY IF EXISTS artigos_despensa_sel   ON festasbv.artigos_despensa;
DROP POLICY IF EXISTS artigos_despensa_admin ON festasbv.artigos_despensa;

CREATE POLICY artigos_despensa_sel ON festasbv.artigos_despensa
  FOR SELECT TO authenticated
  USING (festasbv.is_allowed());

CREATE POLICY artigos_despensa_admin ON festasbv.artigos_despensa
  FOR ALL TO authenticated
  USING (festasbv.is_admin())
  WITH CHECK (festasbv.is_admin());
