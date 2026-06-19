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

## Notas

- A ti não te chega nada, de propósito (és o ADMIN); mas as tuas ações ficam
  no histórico na mesma.
- Plano free: o projeto adormece após ~1 semana sem uso; nos dias do evento está
  a ser usado, por isso corre normal.
- Filtro "só no dia do evento": possível na Edge Function comparando com a
  `refeicoes_def`, mas como a malta só mexe perto das festas, fica a notificar sempre.
