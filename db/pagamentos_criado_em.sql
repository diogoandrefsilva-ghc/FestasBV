-- Hora a que um pagamento foi registado (db/pagamentos_criado_em.sql)
--
-- O PORQUÊ: `pagamentos.data` é só a DATA que se escreveu no formulário
-- (quando o dinheiro mudou de mãos, ao dia) — nunca teve hora, porque
-- ninguém a escreve. O "✓ Saldado em…" dos Saldos queria mostrar a hora,
-- como já acontece no "✓ Contas validadas em…", e não há onde ir buscá-la.
-- Esta coluna é a hora a que o REGISTO foi gravado (equivalente ao
-- `criado_em` que outras tabelas já têm), não a hora do pagamento em si.
--
-- DEFAULT now(): os pagamentos já existentes ganham a hora da migração, não
-- a hora real (essa nunca se guardou) — é aproximação aceitável, o mesmo
-- raciocínio tolerante do resto da app.
--
-- Tolerante: sem esta migração, PAG_CRIADO_EM_COL=false e o "✓ Saldado em…"
-- continua a mostrar só a data, como sempre mostrou.

alter table festasbv.pagamentos
  add column if not exists criado_em timestamptz not null default now();

comment on column festasbv.pagamentos.criado_em is
  'Hora a que o pagamento foi gravado (não a data que se escreveu no formulário).';
