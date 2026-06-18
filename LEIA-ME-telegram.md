# FestasBV — Notificações no Telegram (via histórico)

Recebes uma mensagem no Telegram **sempre que outra pessoa** (não tu, o admin)
marca/altera uma presença ou mexe num convidado. Não há spam: a notificação
dispara da tabela `festasbv.historico`, onde cada linha é **uma ação real**.

```
Ação na app  →  INSERT em festasbv.historico  →  Database Webhook  →  Edge Function  →  Telegram
```

A app já escreve no histórico (função `sbLog`) e mostra-o no bloco **Definições →
Histórico**. Só falta ligar o Telegram. 6 passos.

---

## 1. Correr o SQL

Abre o **SQL Editor** do Supabase e corre o ficheiro `04 historico festasbv.sql`.
Cria a tabela `historico` + RLS + GRANTs. (Não precisas mexer em "Exposed schemas".)

---

## 2. Criar o bot e apanhar o teu chat_id

1. No Telegram, fala com **@BotFather** → `/newbot` → dá-lhe nome → ele dá-te um
   **token** tipo `123456:ABC-DEF...`. Guarda.
2. Carrega em **Start** / envia uma mensagem qualquer ao teu novo bot.
3. Abre no browser (mete o teu token):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. No JSON, procura `result[].message.chat.id` — esse número é o teu **chat_id**.

---

## 3. Guardar os segredos no Supabase

Em **Edge Functions → Secrets** (ou via CLI):

```
supabase secrets set TELEGRAM_BOT_TOKEN=123456:ABC-DEF... TELEGRAM_CHAT_ID=987654321
```

---

## 4. A Edge Function

Cria `supabase/functions/notif-festas/index.ts`:

```ts
const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TG_CHAT  = Deno.env.get("TELEGRAM_CHAT_ID")!;
const ADMIN    = "diogo.andre.f.silva@gmail.com";

Deno.serve(async (req) => {
  try {
    const { type, record } = await req.json();
    if (type !== "INSERT" || !record) return new Response("skip", { status: 200 });
    // não me notificar a mim próprio (mas o histórico regista na mesma)
    if ((record.autor_email ?? "") === ADMIN) return new Response("skip-admin", { status: 200 });

    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: formatar(record), parse_mode: "HTML" }),
    });
    return new Response("ok", { status: 200 });
  } catch (e) {
    // 200 de propósito: evita o webhook entrar em loop de re-tentativas
    return new Response("err: " + (e as Error).message, { status: 200 });
  }
});

function formatar(r: any): string {
  // A frase em linguagem natural já vem pronta da app, gravada em detalhe.frase.
  // (Mantém-se um fallback simples para linhas antigas sem frase.)
  const icon = r.tipo === "presenca" ? "✋" : "👥";
  const frase = (r.detalhe && r.detalhe.frase)
    || `${r.autor_amigo || r.autor_email} alterou ${r.alvo}`;
  return `${icon} ${frase}`;
}
```

Deploy:

```
supabase functions deploy notif-festas
```

(Se preferires sem CLI: cria a função pelo dashboard em **Edge Functions → Deploy
a new function**, cola o código e os secrets do passo 3.)

---

## 5. O Database Webhook

No dashboard: **Database → Webhooks → Create a new hook**.

- **Table:** `festasbv` → `historico`
- **Events:** só **Insert** (deixa Update/Delete desligados)
- **Type:** **Supabase Edge Functions** → escolhe `notif-festas`
  (assim a autenticação fica tratada; se usares "HTTP Request" genérico, mete o
  header `Authorization: Bearer <ANON_KEY>` e o URL da função)

Guarda.

---

## 6. Testar

Pede a alguém (ou usa outra conta que não a tua de admin) para marcar uma presença.
Em segundos deves receber algo como:

> ✋ **Barrona** marcou presença de **Barrona** — Sáb · Jantar

Se não chegar: **Edge Functions → notif-festas → Logs** mostra o que aconteceu.

---

## Notas

- **A ti não te chega nada**, de propósito (és o ADMIN). Mas as **tuas** ações
  ficam à mesma no histórico — vês tudo no bloco Definições → Histórico.
- **Plano free:** o projeto adormece ao fim de ~1 semana sem uso, mas no(s) dia(s)
  do evento vais estar a usá-lo, por isso os webhooks correm normalmente.
- **(Opcional) Só notificar no dia do evento:** dá para filtrar na Edge Function
  comparando a data da refeição com hoje, mas exige ler a `refeicoes_def`. Como a
  malta só mexe perto das festas, deixei a notificar sempre. Diz se queres o filtro.
