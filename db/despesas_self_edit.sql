-- =====================================================================
-- FestasBV — Migração: quem inseriu uma despesa/compra pode editá-la/apagá-la
-- Correr no SQL Editor do Supabase (projeto festasbv).
-- É IDEMPOTENTE: pode ser corrido mais que uma vez sem erro.
-- Depende de: schema.sql, functions.sql, policies.sql, stock.sql.
-- Ordem: ... -> stock.sql -> (stock_alocacao_original.sql, opcional) -> ESTE.
--
-- ATÉ AQUI: editar ou apagar uma despesa era só do admin (`despesas_admin`,
-- FOR ALL) — a tabela só tinha `despesas_self_ins`, para CRIAR. Isso obrigava
-- a pedir ao admin para corrigir um erro de digitação numa despesa própria.
--
-- Passa a poder-se, mas só em DUAS condições (as outras continuam do admin):
--
--   1) Despesas SOLTAS — sem `compra_id`. Não mexem em stock nenhum: editar
--      não pode estragar trabalho de mais ninguém.
--   2) Despesas de uma COMPRA (`compra_id`) cujo stock ainda está tal como a
--      compra o deixou — nenhum lote foi realocado no separador Stock desde
--      então (`aloc_original` == `alocacoes`, o mesmo "divergiu" que já se
--      mostra no editor da compra, ver stock_alocacao_original.sql). Se o
--      admin já foi lá mexer, editar a compra reescrevia-a toda por cima
--      (`saveCompra` apaga e reinsere) e desfazia o que ele fez — por isso
--      esse caso continua fechado ao admin, com aviso na app.
--
-- Nos dois casos exige-se também que a despesa seja da PRÓPRIA pessoa (ou do
-- cônjuge) — a mesma regra do `despesas_self_ins`. Numa despesa paga por
-- vários (`grupo_pag`) isto testa-se LINHA A LINHA: um pagador que não seja
-- meu/do cônjuge bloqueia a linha dele, e a app já só deixa gravar o grupo
-- inteiro de uma vez.
--
-- NÃO SE TESTAM contas fechadas aqui — nem a policy do admin o faz (é regra
-- só da app, `contasFechadas()`), e não fazia sentido o próprio ficar mais
-- travado do que o admin. A app aplica-a na mesma para os dois.
--
-- Sem esta migração a app funciona à mesma: RLS continua a bloquear a
-- escrita e quem não é admin não vê o ✏️/Apagar nestas despesas/compras.
-- =====================================================================

-- Redundante se stock_alocacao_original.sql já correu; sem essa migração
-- fica a coluna cá na mesma (sempre NULL), e `compra_stock_intacto` trata
-- NULL como "sem história para contar" — a compra dá-se sempre por intacta.
ALTER TABLE festasbv.stock_lotes ADD COLUMN IF NOT EXISTS aloc_original jsonb;

-- ---------------------------------------------------------------------
-- Comparar duas alocações (mesma forma de `alocsIguais` no app.js): agrupa
-- por DESTINO (não por linha — a mesma refeição pode vir em duas entradas) e
-- compara as quantidades somadas, com a mesma tolerância do JS (0.0005).
-- A chave do destino espelha `alocToDestino`: pessoa (🎒) manda sobre tudo;
-- senão, Almoço/Jantar com data é a refeição (+ 'b' se for a bebida dela);
-- senão é o tipo puro (Gerais/Bebidas/...).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION festasbv._aloc_dest_key(elem jsonb)
  RETURNS text LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(elem->>'pessoa','') <> '' THEN 'pessoa|'||(elem->>'pessoa')
    WHEN (elem->>'tipo') IN ('Almoço','Jantar') AND COALESCE(elem->>'data','') <> ''
      THEN (elem->>'tipo')||'|'||(elem->>'data')
        ||(CASE WHEN COALESCE((elem->>'bebida')::boolean,false) THEN '|b' ELSE '' END)
    ELSE COALESCE(elem->>'tipo','')
  END;
$$;

CREATE OR REPLACE FUNCTION festasbv._alocs_por_dest(arr jsonb)
  RETURNS TABLE(k text, q numeric) LANGUAGE sql IMMUTABLE
AS $$
  SELECT festasbv._aloc_dest_key(elem) AS k,
         SUM(COALESCE((elem->>'qtd')::numeric,0)) AS q
  FROM jsonb_array_elements(COALESCE(arr,'[]'::jsonb)) elem
  WHERE COALESCE((elem->>'qtd')::numeric,0) > 0.0005
  GROUP BY 1;
$$;

CREATE OR REPLACE FUNCTION festasbv._alocs_iguais(a jsonb, b jsonb)
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(bool_and(ABS(COALESCE(x.q,0)-COALESCE(y.q,0))<=0.0005), true)
  FROM festasbv._alocs_por_dest(a) x
  FULL JOIN festasbv._alocs_por_dest(b) y USING (k);
$$;

-- Um lote continua "tal como a compra o deixou"? NULL em aloc_original =
-- objetivo desconhecido (lote anterior à migração da coluna, ou sem ela) —
-- não se conta história nenhuma, dá-se por intacto (mesmo raciocínio do
-- `loteDivergiu` no app.js: só diverge quando HÁ objetivo e ele discorda).
CREATE OR REPLACE FUNCTION festasbv.stock_lote_intacto(p_alocacoes jsonb, p_aloc_original jsonb)
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT p_aloc_original IS NULL OR festasbv._alocs_iguais(p_aloc_original, p_alocacoes);
$$;

-- A compra toda continua intacta? Sem compra_id (despesa solta) não há lotes
-- a testar, e a condição dá-se por cumprida por vacuidade.
CREATE OR REPLACE FUNCTION festasbv.compra_stock_intacto(p_compra_id text)
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM festasbv.stock_lotes l
    WHERE l.compra_id = p_compra_id
      AND NOT festasbv.stock_lote_intacto(l.alocacoes, l.aloc_original)
  );
$$;

-- ---------------------------------------------------------------------
-- despesas — self UPDATE/DELETE (só faltavam estas; despesas_self_ins já
-- existe em policies.sql). despesas_admin (FOR ALL) continua a mandar em tudo.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS despesas_self_upd ON festasbv.despesas;
DROP POLICY IF EXISTS despesas_self_del ON festasbv.despesas;

CREATE POLICY despesas_self_upd ON festasbv.despesas
  FOR UPDATE TO authenticated
  USING (festasbv.is_allowed()
    AND (quem IN (SELECT festasbv.meus_amigos()))
    AND festasbv.compra_stock_intacto(compra_id))
  WITH CHECK (festasbv.is_allowed()
    AND (quem IN (SELECT festasbv.meus_amigos()))
    AND festasbv.compra_stock_intacto(compra_id));

CREATE POLICY despesas_self_del ON festasbv.despesas
  FOR DELETE TO authenticated
  USING (festasbv.is_allowed()
    AND (quem IN (SELECT festasbv.meus_amigos()))
    AND festasbv.compra_stock_intacto(compra_id));
