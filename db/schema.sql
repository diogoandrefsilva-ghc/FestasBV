-- =====================================================================
-- FestasBV — Schema DDL (festasbv)
-- Projeto Supabase: diogoandrefsilva-personalapps-database
-- Fonte de verdade. Reconstruído a partir do estado real da BD.
-- Script de rebuild: correr numa BD limpa, por esta ordem.
--
-- NOTA sobre IDs: as colunas `id bigint` NÃO têm default (sem sequence).
-- Os IDs são atribuídos pela app/migração (sequenciais, nunca Date.now()).
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS festasbv;

-- ---------------------------------------------------------------------
-- Controlo de acesso
-- ---------------------------------------------------------------------

CREATE TABLE festasbv.allowed_users (
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allowed_users_pkey PRIMARY KEY (email)
);

CREATE TABLE festasbv.access_requests (
  email        text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_requests_pkey PRIMARY KEY (email)
);

CREATE TABLE festasbv.user_amigos (
  email      text NOT NULL,
  amigo      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_amigos_pkey PRIMARY KEY (email)
);

CREATE TABLE festasbv.conjuges (
  amigo_a    text NOT NULL,
  amigo_b    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conjuges_pkey PRIMARY KEY (amigo_a, amigo_b),
  CONSTRAINT conjuges_check CHECK (amigo_a <> amigo_b)
);

-- Configuração global (key-value). Chave atual: notif_telegram (on/off do
-- envio no Telegram). O historico NÃO é afetado por esta flag.
CREATE TABLE festasbv.config (
  chave text NOT NULL,
  valor text NOT NULL,
  CONSTRAINT config_pkey PRIMARY KEY (chave)
);

INSERT INTO festasbv.config (chave, valor)
VALUES ('notif_telegram', 'true')
ON CONFLICT (chave) DO NOTHING;

-- ---------------------------------------------------------------------
-- Núcleo: eventos e tudo o que dele depende (ON DELETE CASCADE)
-- ---------------------------------------------------------------------

CREATE TABLE festasbv.eventos (
  id                  bigint  NOT NULL,
  nome                text    NOT NULL,
  ano                 integer NOT NULL,
  tesoureiro          text    NOT NULL,
  arredonda_total     boolean NOT NULL DEFAULT true,
  missao_poupanca     numeric(10,2) NOT NULL DEFAULT 0,
  fundo_reserva       numeric(10,2) NOT NULL DEFAULT 0,
  contas_fechadas     boolean NOT NULL DEFAULT false,
  contas_fechadas_em  timestamptz,
  contas_fechadas_por text,
  fator_modo          text    NOT NULL DEFAULT 'fixo'::text,
  fator_threshold     numeric NOT NULL DEFAULT 0.70,
  CONSTRAINT eventos_pkey PRIMARY KEY (id),
  CONSTRAINT eventos_ano_key UNIQUE (ano)
);

CREATE TABLE festasbv.membros (
  id        bigint NOT NULL,
  evento_id bigint NOT NULL,
  nome      text   NOT NULL,
  fator     numeric(5,2) NOT NULL DEFAULT 1,
  sexo      text   NOT NULL DEFAULT 'M'::text,
  CONSTRAINT membros_pkey PRIMARY KEY (id),
  CONSTRAINT membros_evento_id_nome_key UNIQUE (evento_id, nome),
  CONSTRAINT membros_evento_id_fkey FOREIGN KEY (evento_id)
    REFERENCES festasbv.eventos(id) ON DELETE CASCADE
);

CREATE TABLE festasbv.convidados (
  id        bigint NOT NULL,
  evento_id bigint NOT NULL,
  membro    text   NOT NULL,
  nome      text   NOT NULL,
  data      date,
  dia       text   NOT NULL,
  ref       text   NOT NULL,
  pagante   boolean NOT NULL DEFAULT true,
  preco     numeric(10,2) NOT NULL DEFAULT 0,
  CONSTRAINT convidados_pkey PRIMARY KEY (id),
  CONSTRAINT convidados_evento_id_fkey FOREIGN KEY (evento_id)
    REFERENCES festasbv.eventos(id) ON DELETE CASCADE
);

CREATE TABLE festasbv.despesas (
  id          bigint NOT NULL,
  evento_id   bigint NOT NULL,
  quem        text   NOT NULL,
  data_desp   date,
  data_valor  date,
  descricao   text   NOT NULL DEFAULT ''::text,
  tipo        text   NOT NULL,
  valor       numeric(10,2) NOT NULL,
  observacoes text,
  CONSTRAINT despesas_pkey PRIMARY KEY (id),
  CONSTRAINT despesas_evento_id_fkey FOREIGN KEY (evento_id)
    REFERENCES festasbv.eventos(id) ON DELETE CASCADE
);

CREATE TABLE festasbv.mealheiros (
  id        bigint NOT NULL,
  evento_id bigint NOT NULL,
  quem      text   NOT NULL,
  data      date,
  valor     numeric(10,2) NOT NULL,
  subtipo   text   NOT NULL DEFAULT 'lata'::text,
  descricao text   NOT NULL DEFAULT ''::text,
  CONSTRAINT mealheiros_pkey PRIMARY KEY (id),
  CONSTRAINT mealheiros_evento_id_fkey FOREIGN KEY (evento_id)
    REFERENCES festasbv.eventos(id) ON DELETE CASCADE
);

CREATE TABLE festasbv.pagamentos (
  id        bigint NOT NULL,
  evento_id bigint NOT NULL,
  de        text   NOT NULL,
  para      text   NOT NULL,
  valor     numeric(10,2) NOT NULL,
  ref       text   NOT NULL DEFAULT ''::text,
  data      date,
  extra     numeric NOT NULL DEFAULT 0,
  CONSTRAINT pagamentos_pkey PRIMARY KEY (id),
  CONSTRAINT pagamentos_evento_id_fkey FOREIGN KEY (evento_id)
    REFERENCES festasbv.eventos(id) ON DELETE CASCADE
);

CREATE TABLE festasbv.refeicoes_def (
  id         bigint NOT NULL,
  evento_id  bigint NOT NULL,
  data       date   NOT NULL,
  dia        text   NOT NULL,
  ref        text   NOT NULL,
  peso       numeric(6,3)  NOT NULL DEFAULT 0,
  min_meo    numeric(10,2) NOT NULL DEFAULT 0,
  min_conv   numeric(10,2) NOT NULL DEFAULT 0,
  extra_conv numeric(10,2) NOT NULL DEFAULT 0,
  prato      text,
  CONSTRAINT refeicoes_def_pkey PRIMARY KEY (id),
  CONSTRAINT refeicoes_def_evento_id_dia_ref_key UNIQUE (evento_id, dia, ref),
  CONSTRAINT refeicoes_def_evento_id_fkey FOREIGN KEY (evento_id)
    REFERENCES festasbv.eventos(id) ON DELETE CASCADE
);

CREATE TABLE festasbv.presencas (
  id        bigint NOT NULL,
  membro_id bigint NOT NULL,
  dia       text   NOT NULL,
  ref       text   NOT NULL,
  modo      text   NOT NULL DEFAULT 'come'::text,
  CONSTRAINT presencas_pkey PRIMARY KEY (id),
  CONSTRAINT presencas_membro_id_dia_ref_key UNIQUE (membro_id, dia, ref),
  CONSTRAINT presencas_membro_id_fkey FOREIGN KEY (membro_id)
    REFERENCES festasbv.membros(id) ON DELETE CASCADE
);

CREATE TABLE festasbv.validacoes (
  id                 bigint NOT NULL,
  evento_id          bigint NOT NULL,
  amigo              text   NOT NULL,
  validado_por_email text   NOT NULL,
  validado_em        timestamptz NOT NULL DEFAULT now(),
  validado_por_amigo text,
  CONSTRAINT validacoes_pkey PRIMARY KEY (id),
  CONSTRAINT validacoes_evento_id_amigo_key UNIQUE (evento_id, amigo),
  CONSTRAINT validacoes_evento_id_fkey FOREIGN KEY (evento_id)
    REFERENCES festasbv.eventos(id) ON DELETE CASCADE
);

CREATE TABLE festasbv.historico (
  id          bigint NOT NULL,
  evento_id   bigint,
  ts          timestamptz NOT NULL DEFAULT now(),
  autor_email text   NOT NULL,
  autor_amigo text,
  tipo        text   NOT NULL,
  accao       text   NOT NULL,
  alvo        text   NOT NULL,
  detalhe     jsonb  NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT historico_pkey PRIMARY KEY (id),
  CONSTRAINT historico_evento_id_fkey FOREIGN KEY (evento_id)
    REFERENCES festasbv.eventos(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- Índices não-únicos (verificados via pg_indexes contra o estado real).
-- As PK e UNIQUE constraints já criam o seu próprio índice; estes cobrem
-- as FKs em evento_id/membro_id (aceleram deletes em cascata e lookups).
-- ---------------------------------------------------------------------

CREATE INDEX ON festasbv.membros       (evento_id);
CREATE INDEX ON festasbv.presencas     (membro_id);
CREATE INDEX ON festasbv.refeicoes_def (evento_id);
CREATE INDEX ON festasbv.despesas      (evento_id);
CREATE INDEX ON festasbv.convidados    (evento_id);
CREATE INDEX ON festasbv.mealheiros    (evento_id);
CREATE INDEX ON festasbv.pagamentos    (evento_id);
CREATE INDEX idx_validacoes_evento ON festasbv.validacoes (evento_id);
CREATE INDEX historico_evento_ts_idx ON festasbv.historico (evento_id, ts DESC);

-- ---------------------------------------------------------------------
-- GRANTs obrigatórios (sem isto: HTTP 403, código 42501)
-- Expor o schema no Data API NÃO concede permissões Postgres.
-- ---------------------------------------------------------------------

GRANT USAGE ON SCHEMA festasbv TO anon, authenticated;
GRANT ALL ON ALL TABLES    IN SCHEMA festasbv TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA festasbv TO anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA festasbv
  GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA festasbv
  GRANT ALL ON SEQUENCES TO anon, authenticated;

-- ---------------------------------------------------------------------
-- RLS: ativo em TODAS as tabelas (as policies estão em policies.sql)
-- ---------------------------------------------------------------------

ALTER TABLE festasbv.access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.allowed_users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.config          ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.conjuges        ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.convidados      ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.despesas        ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.eventos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.historico       ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.mealheiros      ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.membros         ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.pagamentos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.presencas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.refeicoes_def   ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.user_amigos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE festasbv.validacoes      ENABLE ROW LEVEL SECURITY;
