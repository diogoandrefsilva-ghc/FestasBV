# FestasBV — Notificações no Telegram

Recebes uma mensagem no Telegram **sempre que outra pessoa** (não tu, o admin)
marca/altera uma presença ou mexe num convidado. Sem spam: dispara da tabela
`festasbv.historico`, onde cada linha é **uma ação real**.

```
Ação na app → INSERT em festasbv.historico → Database Webhook → Edge Function → Telegram
```

A app escreve no histórico (`sbLog`) e mostra-o em Definições → Histórico.
O switch on/off vive em `festasbv.config` (chave `notif_telegram`): a `false`,
o histórico continua a registar; só o envio é que para.

## Onde está cada peça (fonte de verdade)

- Tabelas `historico` e `config`, GRANTs e RLS → `db/schema.sql` + `db/policies.sql`
- Trigger do webhook (`festasbv_historico`, AFTER INSERT em `historico`) → `db/functions.sql`
  (a definição real tem a service_role key; no repo está **redigida** — o webhook
  é gerido pelo dashboard, não à mão)
- Código da Edge Function → `notif-festas.ts` (lê o switch, ignora o admin,
  fail-open se a leitura da flag falhar)

## Setup (uma vez)

1. **SQL** — garante que `schema.sql` + `functions.sql` + `policies.sql` correram
   (criam `historico`, `config` e o resto). Não é preciso mexer em "Exposed schemas".
2. **Bot** — no Telegram, `@BotFather` → `/newbot` → guarda o **token**. Envia uma
   mensagem ao bot e abre `https://api.telegram.org/bot<TOKEN>/getUpdates`;
   `result[].message.chat.id` é o teu **chat_id**.
3. **Secrets** — Edge Functions → Secrets:
   `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`.
   (`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são injetados automaticamente.)
4. **Deploy** da função `notif-festas` (dashboard ou `supabase functions deploy notif-festas`).
5. **Webhook** — Database → Webhooks → Create: Table `festasbv.historico`,
   Events só **Insert**, Type **Supabase Edge Functions** → `notif-festas`
   (assim a auth fica tratada e o trigger é gerado pelo dashboard).
6. **Testar** — pede a outra conta (não a de admin) para marcar presença; em
   segundos deves receber algo como: `✋ Barrona marcou presença — Sáb · Jantar`.
   Se não chegar: Edge Functions → notif-festas → Logs.

## Notificações PESSOAIS (por utilizador) — Edge Function `notif-pessoais`

Além do aviso ao admin (acima, intocado), cada utilizador pode ligar o SEU
Telegram na app (Definições → 🔔 Notificações) e recebe avisos dirigidos:

- **Responsável de refeição** — o admin nomeia no detalhe da refeição
  (👨‍🍳 cozinha / 🛒 compras). O nomeado recebe a nomeação **com a lista de
  quem vai e os totais**, e depois é avisado sempre que alguém mexe nas
  presenças/convidados dessa refeição.
- **Compras** — quem adiciona um artigo indica se «Eu trato de comprar»;
  se NÃO ficar a tratar, todos os inscritos (menos o autor) são avisados.

```
Ação na app → INSERT em festasbv.historico → Webhook → notif-pessoais → Telegram (por pessoa)
        Ligação da conta: t.me/<bot>?start=<codigo> → webhook do bot → notif-pessoais → notif_prefs.chat_id
```

O interruptor global (`config.notif_telegram`) manda em tudo; cada pessoa tem
ainda o seu interruptor em `notif_prefs.ativo`. O admin nunca é avisado pela
`notif-pessoais` (já recebe tudo pela `notif-festas`), nem ninguém é avisado
das próprias ações.

### Setup (uma vez)

1. **SQL** — correr `db/notifs.sql` (colunas `resp_cozinha`/`resp_compras`,
   tabela `notif_prefs`, config `telegram_bot`).
2. **Bot** — preencher o username do bot (sem @):
   `UPDATE festasbv.config SET valor='OTeuBot' WHERE chave='telegram_bot';`
3. **Deploy** — `supabase functions deploy notif-pessoais --no-verify-jwt`
   (código em `notif-pessoais.ts`; usa o mesmo secret `TELEGRAM_BOT_TOKEN`).
   O `--no-verify-jwt` é preciso porque o Telegram não manda JWT.
4. **Webhook do bot** — apontar o bot para a função (e opcionalmente definir
   o secret `TELEGRAM_WEBHOOK_SECRET` nos Secrets e no `secret_token`):
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://gjweqwfbnkgnibhajldc.supabase.co/functions/v1/notif-pessoais&secret_token=<SEGREDO>`
   (⚠️ isto desativa o `getUpdates` manual, que já não é preciso.)
5. **Database Webhook** — Database → Webhooks → Create: Table
   `festasbv.historico`, Events só **Insert**, Type **Supabase Edge
   Functions** → `notif-pessoais` (fica um segundo webhook, ao lado do da
   `notif-festas`).
6. **Testar** — na app: Definições → 🔔 Notificações → «Ligar ao Telegram»
   → Start no bot → «Verificar» deve mostrar ✅. Depois pede a outra conta
   para te nomear responsável ou adicionar um artigo sem «Eu trato».

## Notas

- A ti não te chega nada, de propósito (és o ADMIN); mas as tuas ações ficam
  no histórico na mesma.
- Plano free: o projeto adormece após ~1 semana sem uso; nos dias do evento está
  a ser usado, por isso corre normal.
- Filtro "só no dia do evento": possível na Edge Function comparando com a
  `refeicoes_def`, mas como a malta só mexe perto das festas, fica a notificar sempre.
