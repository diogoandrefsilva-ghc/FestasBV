-- Bebida alocada a uma refeição (db/bebida_refeicao.sql)
--
-- O PORQUÊ: uma despesa alocada a uma refeição é, até aqui, comida — divide-se
-- só por quem come (Fdir ÷ Ncomem). Mas há bebidas compradas para uma noite
-- específica e bebidas depois do jantar, por quem jantou E por quem só veio ao
-- copo. Alocá-las como comida deixava de fora quem só bebe; deixá-las na bolsa
-- indireta fazia-as pagar por toda a gente do ano, mesmo quem não lá esteve.
--
-- A coluna marca a despesa como BEBIDA daquela refeição: continua um custo
-- direto (não vai à bolsa indireta), mas o calcular() divide-a por
-- Ncomem + Nbebe em vez de só por Ncomem. A refeição continua identificada
-- como sempre — tipo (Almoço/Jantar) + data_valor — por isso a coluna é só o
-- interruptor, não mexe em como se aloca.
--
-- Tolerante: sem esta migração, DESP_BEBIDA_COL=false, a marca nunca se grava
-- e tudo se comporta como antes.
--
-- No stock a marca não precisa de coluna nenhuma: vive no JSON das alocações
-- (stock_lotes.alocacoes → {tipo, data, qtd, bebida:true}).

alter table festasbv.despesas
  add column if not exists bebida boolean not null default false;

comment on column festasbv.despesas.bebida is
  'Despesa de refeição que conta como bebida: reparte-se por quem come + quem só bebe.';
