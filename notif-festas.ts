// supabase/functions/notif-festas/index.ts
// FestasBV — Notifica no Telegram quando alguém (que NÃO o admin) altera
// presenças ou convidados. Dispara do Database Webhook em festasbv.historico
// (evento INSERT). A frase já vem redigida da app, no campo detalhe.frase.
//
// Recebe TAMBÉM o webhook de festasbv.access_requests (INSERT): avisa o admin
// que há um pedido de acesso pendente para aprovar em Definições. Este aviso
// ignora o switch notif_telegram de propósito — é raro e, sem aviso, o pedido
// podia ficar semanas à espera.
//
// Switch ON/OFF: lê a flag festasbv.config.notif_telegram. Se estiver "false",
// não envia (o histórico fica sempre registado — só o envio é que para).
//
// Secrets necessários (Edge Functions -> Secrets):
//   TELEGRAM_BOT_TOKEN   token do @BotFather
//   TELEGRAM_CHAT_ID     o teu chat_id
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TG_CHAT  = Deno.env.get("TELEGRAM_CHAT_ID")!;
const ADMIN    = "diogo.andre.f.silva@gmail.com";
const SB_URL   = Deno.env.get("SUPABASE_URL")!;
const SB_SRV   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Lê a flag global do switch. Fail-open: se a leitura falhar (erro transitório),
// assume LIGADO — mais vale uma notificação a mais do que perdê-las por um glitch.
async function notifLigadas(): Promise<boolean> {
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/config?chave=eq.notif_telegram&select=valor`,
      {
        headers: {
          apikey: SB_SRV,
          Authorization: `Bearer ${SB_SRV}`,
          "Accept-Profile": "festasbv",
        },
      },
    );
    if (!r.ok) return true;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return true;
    return rows[0].valor === "true";
  } catch (_) {
    return true;
  }
}

async function enviar(text: string) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text }),
  });
}

Deno.serve(async (req) => {
  try {
    const { type, table, record } = await req.json();

    // Só nos interessam inserções novas
    if (type !== "INSERT" || !record) {
      return new Response("skip", { status: 200 });
    }

    // Pedido de acesso pendente (webhook em festasbv.access_requests)
    if (table === "access_requests") {
      await enviar(
        `🔑 ${record.email} pediu acesso à app — falta aprovares em Definições › Pedidos de acesso`,
      );
      return new Response("ok-acesso", { status: 200 });
    }

    // Não me notificar a mim próprio (mas o histórico regista na mesma)
    if ((record.autor_email ?? "") === ADMIN) {
      return new Response("skip-admin", { status: 200 });
    }

    // Eventos marcados como silenciosos ficam no histórico (auditoria) mas não
    // enviam Telegram — ex.: transições de só-bebida. A app põe detalhe.silencioso
    // na origem (ver _flushPresLog). Remover esta marca reativa o aviso.
    if (record.detalhe && record.detalhe.silencioso === true) {
      return new Response("skip-silent", { status: 200 });
    }

    // Switch ON/OFF na app: se desligado, não envia (histórico já está gravado)
    if (!(await notifLigadas())) {
      return new Response("skip-off", { status: 200 });
    }

    await enviar(formatar(record));

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
