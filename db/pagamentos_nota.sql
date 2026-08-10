-- Nota de um pagamento livre / adiantamento (db/pagamentos_nota.sql)
--
-- O PORQUÊ: "Pagar Dívida" sem nenhuma dívida selecionada regista-se como
-- pagamento livre / adiantamento — o valor fica como crédito da pessoa. Ao
-- contrário de um acerto de dívida (que já se explica pelas dívidas que
-- saldou), um adiantamento não diz nada sobre si próprio: é só um número.
-- A coluna dá ao admin onde escrever o quê e o porquê ("adiantou para as
-- t-shirts do ano que vem", "trouxe 50€ a mais por engano").
--
-- Só se usa no pagamento LIVRE — um acerto de dívida continua a explicar-se
-- pelas dívidas que a `ref` já lista.
--
-- Tolerante: sem esta migração, PAG_NOTA_COL=false, a caixa de observações
-- não aparece e nunca se grava nada.

alter table festasbv.pagamentos
  add column if not exists nota text not null default '';

comment on column festasbv.pagamentos.nota is
  'Observação de um pagamento livre / adiantamento (sem dívida associada).';
