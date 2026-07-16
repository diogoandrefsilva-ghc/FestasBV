// supabase/functions/notif-pessoais/index.ts
// FestasBV — Notificações Telegram PESSOAIS (por utilizador), a par da
// notif-festas (que continua a avisar só o admin no chat dele).
//
// Esta função recebe DOIS tipos de POST e distingue-os pelo payload:
//
//  A) Database Webhook (INSERT em festasbv.historico) → decide QUEM avisar:
//     - presenca/convidado ......... responsáveis (cozinha+compras) da refeição
//     - refeicao + nomeou/retirou .. o próprio nomeado/retirado (a nomeação
//                                    leva em detalhe.resumo a lista de quem
//                                    vai e os totais, redigida pela app)
//     - compras + adicionou ........ TODOS os inscritos exceto o autor, mas
//                                    só se quem adicionou não ficou a tratar
//                                    (detalhe.tratoEu === false)
//     Nunca se avisa o próprio autor, nem o admin (o admin já recebe tudo
//     pela notif-festas). O interruptor global notif_telegram manda em tudo.
//
//  B) Webhook do bot do Telegram (update com message) → liga a conta:
//     o utilizador toca em t.me/<bot>?start=<codigo> na app, o Telegram
//     envia "/start <codigo>" e aqui grava-se o chat_id em notif_prefs.
//
// Secrets necessários (Edge Functions -> Secrets):
//   TELEGRAM_BOT_TOKEN        token do @BotFather (o mesmo da notif-festas)
//   TELEGRAM_WEBHOOK_SECRET   (opcional) secret_token passado no setWebhook;
//                             se definido, updates sem o header certo são ignorados
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)
//
// Deploy: supabase functions deploy notif-pessoais --no-verify-jwt
// (o Telegram não manda JWT; o DB webhook pode apontar aqui na mesma.)
// Setup passo-a-passo: ver db/telegram.md.

const TG_TOKEN  = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TG_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const ADMIN     = "diogo.andre.f.silva@gmail.com";
const SB_URL    = Deno.env.get("SUPABASE_URL")!;
const SB_SRV    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// REST no schema festasbv com service_role (ignora RLS — só leituras de
// routing e o update do chat_id; nada disto é exposto ao browser).
async function sb(method: string, path: string, body?: unknown) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_SRV,
      Authorization: `Bearer ${SB_SRV}`,
      "Accept-Profile": "festasbv",
      "Content-Profile": "festasbv",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error(`sb ${method} ${path} -> HTTP ${r.status}`, detail.slice(0, 300));
    throw new Error(`sb ${path}: HTTP ${r.status}`);
  }
  const tx = await r.text();
  return tx ? JSON.parse(tx) : null;
}

async function tgSend(chatId: string, text: string) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!r.ok) console.error("tgSend -> HTTP", r.status, (await r.text().catch(() => "")).slice(0, 200));
  } catch (e) {
    console.error("tgSend falhou:", (e as Error).message);
  }
}

// Interruptor global (mesma semântica fail-open da notif-festas)
async function notifLigadas(): Promise<boolean> {
  try {
    const rows = await sb("GET", "config?chave=eq.notif_telegram&select=valor");
    if (!Array.isArray(rows) || rows.length === 0) return true;
    return rows[0].valor === "true";
  } catch (_) {
    return true;
  }
}

// nome de membro -> email da conta (via user_amigos; cônjuges não contam:
// o aviso é para a própria pessoa nomeada/responsável)
async function emailDoAmigo(nome: string): Promise<string | null> {
  if (!nome) return null;
  const rows = await sb(
    "GET",
    `user_amigos?amigo=eq.${encodeURIComponent(nome)}&select=email`,
  );
  return rows && rows[0] ? rows[0].email : null;
}

// ── B) update do Telegram: ligar conta via /start <codigo> ──
async function handleTelegram(update: any): Promise<Response> {
  const msg = update.message;
  const chatId = msg?.chat?.id;
  const text: string = msg?.text ?? "";
  console.log("telegram update:", chatId ? `chat ${chatId}` : "sem chat", "texto:", text.slice(0, 40));
  if (!chatId) return new Response("skip", { status: 200 });

  const m = text.match(/^\/start\s+(\S+)/);
  if (m) {
    const rows = await sb(
      "GET",
      `notif_prefs?codigo=eq.${encodeURIComponent(m[1])}&select=user_email`,
    );
    console.log("/start com código:", m[1], "-> match:", rows?.length ?? 0);
    if (rows && rows[0]) {
      await sb("PATCH", `notif_prefs?codigo=eq.${encodeURIComponent(m[1])}`, {
        chat_id: String(chatId),
        ativo: true,
        updated_at: new Date().toISOString(),
      });
      await tgSend(String(chatId), "✅ Ligado! Vais passar a receber os avisos das Festas aqui. Podes desligar a qualquer momento na app (Definições → Notificações).");
      return new Response("linked", { status: 200 });
    }
  }
  await tgSend(String(chatId), "Para ligares as notificações, abre a app FestasBV → Definições → 🔔 Notificações e toca em «Ligar ao Telegram».");
  return new Response("nocode", { status: 200 });
}

// ── A) INSERT no histórico: routing por tipo de evento ──
async function handleHistorico(record: any): Promise<Response> {
  console.log("historico:", record.tipo, record.accao, "por", record.autor_email);
  if (!(await notifLigadas())) return new Response("skip-off", { status: 200 });

  const d = record.detalhe ?? {};
  // Eventos silenciosos ficam no histórico (auditoria) mas não notificam
  // ninguém — ex.: transições de só-bebida. A app marca detalhe.silencioso na
  // origem (ver _flushPresLog). Remover a marca reativa o aviso.
  if (d.silencioso === true) return new Response("skip-silent", { status: 200 });
  const destinos = new Set<string>();

  if (record.tipo === "presenca" || record.tipo === "convidado") {
    // avisar os responsáveis da refeição alterada
    if (record.evento_id && d.dia && d.ref) {
      const ref = d.ref === "Tarde" ? "Lanche" : d.ref; // chave de presença vs refeicoes_def
      const rd = await sb(
        "GET",
        `refeicoes_def?evento_id=eq.${record.evento_id}&dia=eq.${encodeURIComponent(d.dia)}&ref=eq.${encodeURIComponent(ref)}&select=resp_cozinha,resp_compras`,
      );
      for (const nome of [rd?.[0]?.resp_cozinha, rd?.[0]?.resp_compras]) {
        const em = await emailDoAmigo(nome);
        if (em) destinos.add(em);
      }
    }
  } else if (record.tipo === "refeicao" && (record.accao === "nomeou" || record.accao === "retirou")) {
    // avisar o nomeado (ou quem deixou de ser responsável)
    const em = await emailDoAmigo(record.alvo);
    if (em) destinos.add(em);
  } else if (record.tipo === "compras" && record.accao === "adicionou" && d.tratoEu === false) {
    // ninguém ficou a tratar → avisar todos os inscritos (menos o autor)
    const rows = await sb(
      "GET",
      "notif_prefs?ativo=is.true&chat_id=not.is.null&select=user_email",
    );
    (rows ?? []).forEach((r: any) => destinos.add(r.user_email));
  }

  destinos.delete(record.autor_email ?? ""); // nunca avisar o próprio
  destinos.delete(ADMIN);                    // o admin já recebe pela notif-festas
  if (!destinos.size) return new Response("no-dest", { status: 200 });

  const emails = [...destinos].map((e) => `"${e}"`).join(",");
  const prefs = await sb(
    "GET",
    `notif_prefs?user_email=in.(${encodeURIComponent(emails)})&ativo=is.true&chat_id=not.is.null&select=chat_id`,
  );
  if (!prefs || !prefs.length) return new Response("no-chat", { status: 200 });

  const icon = { presenca: "✋", convidado: "👥", compras: "🛒", refeicao: "🧑‍🍳" }[record.tipo as string] ?? "🔔";
  const frase = d.frase || `${record.autor_amigo || record.autor_email} alterou ${record.alvo}`;
  const text = `${icon} ${frase}` + (d.resumo ? `\n\n${d.resumo}` : "");

  await Promise.all(prefs.map((p: any) => tgSend(p.chat_id, text)));
  return new Response("ok", { status: 200 });
}

Deno.serve(async (req) => {
  try {
    const body = await req.json();

    // Update do Telegram? (tem update_id; valida o secret se configurado)
    if (body && typeof body.update_id !== "undefined") {
      if (TG_SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== TG_SECRET) {
        return new Response("bad-secret", { status: 200 });
      }
      return await handleTelegram(body);
    }

    // Database Webhook do histórico
    if (body?.type === "INSERT" && body.record) {
      return await handleHistorico(body.record);
    }
    return new Response("skip", { status: 200 });
  } catch (e) {
    // 200 de propósito: evita loops de re-tentativa dos webhooks
    console.error("erro não tratado:", (e as Error).message);
    return new Response("err: " + (e as Error).message, { status: 200 });
  }
});
