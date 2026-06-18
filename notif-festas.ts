// supabase/functions/notif-festas/index.ts
// FestasBV — Notifica no Telegram quando alguém (que NÃO o admin) altera
// presenças ou convidados. Dispara do Database Webhook em festasbv.historico
// (evento INSERT). A frase já vem redigida da app, no campo detalhe.frase.
//
// Secrets necessários (Edge Functions -> Secrets):
//   TELEGRAM_BOT_TOKEN   token do @BotFather
//   TELEGRAM_CHAT_ID     o teu chat_id

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TG_CHAT  = Deno.env.get("TELEGRAM_CHAT_ID")!;
const ADMIN    = "diogo.andre.f.silva@gmail.com";

Deno.serve(async (req) => {
  try {
    const { type, record } = await req.json();

    // Só nos interessam inserções novas no histórico
    if (type !== "INSERT" || !record) {
      return new Response("skip", { status: 200 });
    }

    // Não me notificar a mim próprio (mas o histórico regista na mesma)
    if ((record.autor_email ?? "") === ADMIN) {
      return new Response("skip-admin", { status: 200 });
    }

    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: formatar(record) }),
    });

    return new Response("ok", { status: 200 });
  } catch (e) {
    // 200 de propósito: evita o webhook entrar em loop de re-tentativas
    return new Response("err: " + (e as Error).message, { status: 200 });
  }
});

function formatar(r: any): string {
  // A frase em linguagem natural já vem pronta da app, em detalhe.frase.
  // (fallback simples para linhas antigas, sem frase.)
  const icon = r.tipo === "presenca" ? "✋" : "👥";
  const frase = (r.detalhe && r.detalhe.frase)
    || `${r.autor_amigo || r.autor_email} alterou ${r.alvo}`;
  return `${icon} ${frase}`;
}
