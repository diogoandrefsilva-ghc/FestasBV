// supabase/functions/push-notificar/index.ts
// FestasBV — Envia notificações Web Push (Notification/Push API, sem
// Telegram). Irmã da Edge Function homónima do SplitBill (mesmo projeto
// Supabase, schema `festasbv`): as notificações Telegram (notif-festas/
// notif-pessoais) continuam a existir e não são tocadas por isto — são dois
// canais paralelos, cada um com o seu interruptor.
//
// Três momentos, todos chamados pela app:
//   'fecho'                fecharContas() → TODOS os membros com conta
//                           ligada, cada um com o que tem a pagar/receber
//                           (e o saldo do casal, quando há cônjuge) — o
//                           texto é sempre por pessoa, nunca "toda a gente
//                           deve o mesmo" (fire-and-forget)
//   'pagamento_declarado'  ao declarar "🤝 Pagar Dívida" (admin regista de
//                           imediato; um membro fica em pagamentos_pendentes
//                           à espera) → avisa sempre o ADMIN_EMAIL, que é
//                           quem aprova (fire-and-forget)
//   'lembrete'              o admin, no separador Saldos, pede para lembrar
//                           um membro concreto de uma dívida em aberto
//                           (o utilizador espera pelo resultado)
//
// Resolve amigo→email via `user_amigos` (mesma tabela usada nas outras
// políticas de equivalência) e manda o push a cada `push_subscriptions`
// dessa pessoa. Subscriptions que já não existem do lado do browser
// (404/410) são apagadas aqui mesmo. O texto da notificação é sempre
// escolhido AQUI (por `tipo`), nunca vindo livre do cliente — só os nomes/
// valores são interpolados.
//
// Chamada pelo browser com o JWT do utilizador (verify_jwt fica LIGADO no
// deploy). Por cima disso confirma-se que o email consta de
// `festasbv.allowed_users`. Os tipos 'fecho' e 'lembrete' só o admin pode
// disparar — é ele quem fecha as contas e quem lembra dívidas; o pedido de
// pagamento é o único que qualquer membro autorizado pode disparar (é ele
// que declara "já paguei").
//
// Secrets necessários (Edge Functions -> Secrets):
//   VAPID_PUBLIC_KEY   par de chaves só para Web Push (não é a chave do
//   VAPID_PRIVATE_KEY  Supabase). Os secrets são por PROJETO, não por função
//                      — como o SplitBill já tem o seu push-notificar neste
//                      MESMO projeto, estes dois já devem estar definidos;
//                      não é preciso repeti-los. O VAPID_PUBLIC_KEY do
//                      app.js do FestasBV tem de ser exatamente o mesmo
//                      valor (é o par do SplitBill, de propósito).
//   VAPID_SUBJECT      (opcional) "mailto:..."; sem ele usa um valor por omissão
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)
//
// Deploy: supabase functions deploy push-notificar

import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@festasbv.app";
// Mesmo valor do ADMIN_EMAIL em app.js — não é secret (já vai no código
// público do frontend), só se mantém aqui para saber a quem mandar os
// pushes de 'pagamento_declarado'.
const ADMIN_EMAIL = "diogo.andre.f.silva@gmail.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sbHeaders = {
  apikey: SB_SRV,
  Authorization: `Bearer ${SB_SRV}`,
  "Content-Profile": "festasbv",
  "Accept-Profile": "festasbv",
  "Content-Type": "application/json",
};

type Sub = { endpoint: string; email: string; p256dh: string; auth_key: string };

async function emailDoToken(auth: string): Promise<string | null> {
  const u = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SRV, Authorization: auth },
  });
  if (!u.ok) return null;
  const email = ((await u.json()).email ?? "").toLowerCase();
  return email || null;
}

async function estaAutorizado(email: string): Promise<boolean> {
  const r = await fetch(
    `${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,
    { headers: sbHeaders },
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function subscriptionsDe(emails: string[]): Promise<Sub[]> {
  if (!emails.length) return [];
  const orEmails = emails.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",");
  const r = await fetch(
    `${SB_URL}/rest/v1/push_subscriptions?email=in.(${orEmails})&select=endpoint,email,p256dh,auth_key`,
    { headers: sbHeaders },
  );
  return r.ok ? await r.json() : [];
}

async function apagarSubsMortas(endpoints: string[]) {
  if (!endpoints.length) return;
  const orMortos = endpoints.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",");
  await fetch(`${SB_URL}/rest/v1/push_subscriptions?endpoint=in.(${orMortos})`, {
    method: "DELETE",
    headers: sbHeaders,
  }).catch(() => {});
}

// Manda o mesmo payload a uma lista de subscriptions; devolve {enviados,
// falhados} e apaga as que já não existem do lado do browser (404/410).
async function enviarParaSubs(subs: Sub[], payload: string) {
  let enviados = 0;
  let falhados = 0;
  const mortos: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload,
        );
        enviados++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) mortos.push(s.endpoint);
        falhados++;
      }
    }),
  );
  await apagarSubsMortas(mortos);
  return { enviados, falhados };
}

type Pessoa = { amigo: string; valor: number; casal?: number | null };
type Tipo = "fecho" | "pagamento_declarado" | "lembrete";

function eurTxt(v: number) {
  return `€${Math.abs(v).toFixed(2).replace(".", ",")}`;
}

// 'fecho': o saldo do PRÓPRIO primeiro, o do CASAL a seguir — só quando há
// cônjuge e o total do casal é diferente do saldo individual (sem cônjuge,
// ou com cônjuge cujas contas não mudam nada, repetir o número era ruído).
function fraseSaldo(v: number): string {
  if (Math.abs(v) < 0.005) return "as contas estão saldadas";
  return v > 0 ? `tens ${eurTxt(v)} a receber` : `tens ${eurTxt(v)} a pagar`;
}
function fraseSaldoCasal(v: number): string {
  if (Math.abs(v) < 0.005) return "o casal está com as contas saldadas";
  return v > 0 ? `o casal, no total, tem ${eurTxt(v)} a receber` : `o casal, no total, tem ${eurTxt(v)} a pagar`;
}

function montarMensagem(tipo: Tipo, p: Pessoa, descricao?: string, quem?: string) {
  if (tipo === "lembrete") {
    return {
      title: "🔔 Lembrete de pagamento",
      body: `${quem || "O tesoureiro"} lembra-te que ainda deves ${eurTxt(p.valor)}${descricao ? ` — ${descricao}` : ""}`,
    };
  }
  // 'fecho'
  let body = fraseSaldo(p.valor);
  body = body.charAt(0).toUpperCase() + body.slice(1) + ".";
  if (p.casal != null && Math.abs(p.casal - p.valor) > 0.005) {
    body += " " + fraseSaldoCasal(p.casal).charAt(0).toUpperCase() + fraseSaldoCasal(p.casal).slice(1) + ".";
  }
  return {
    title: "🔒 Contas fechadas" + (descricao ? ` — ${descricao}` : ""),
    body,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    const emailChamador = await emailDoToken(auth);
    if (!emailChamador) return json({ error: "não autorizado" }, 403);
    if (!(await estaAutorizado(emailChamador))) return json({ error: "não autorizado" }, 403);

    const { pessoas, descricao, quem, tipo } = (await req.json()) as {
      pessoas?: Pessoa[];
      descricao?: string;
      quem?: string;
      tipo?: Tipo;
    };

    // 'pagamento_declarado': vai SEMPRE para o admin, direto — é ele quem
    // aprova o pedido em pagamentos_pendentes. Não passa por user_amigos:
    // não interessa quem é o "para" do pedido (o tesoureiro do ano pode nem
    // ter conta ligada), interessa avisar quem vai decidir.
    if (tipo === "pagamento_declarado") {
      const valor = pessoas && pessoas[0] ? pessoas[0].valor : 0;
      const subs = await subscriptionsDe([ADMIN_EMAIL]);
      const payload = JSON.stringify({
        title: "✅ Pagamento declarado",
        body: `${quem || "Alguém"} diz que pagou ${eurTxt(valor)}${descricao ? ` — ${descricao}` : ""} — confirma na app`,
        url: "/FestasBV/",
      });
      return json(await enviarParaSubs(subs, payload));
    }

    // 'fecho' e 'lembrete' só o admin os dispara — é ele quem fecha as
    // contas e quem decide lembrar uma dívida concreta.
    if (tipo !== "fecho" && tipo !== "lembrete") return json({ error: "tipo inválido" }, 400);
    if (emailChamador !== ADMIN_EMAIL) return json({ error: "só o admin" }, 403);
    if (!Array.isArray(pessoas) || pessoas.length === 0) return json({ enviados: 0, falhados: 0 });

    // amigo → email (só os amigos pedidos)
    const nomes = [...new Set(pessoas.map((p) => p.amigo).filter(Boolean))];
    const orList = nomes.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(",");
    const eqR = await fetch(
      `${SB_URL}/rest/v1/user_amigos?amigo=in.(${orList})&select=amigo,email`,
      { headers: sbHeaders },
    );
    const equivalencias: { amigo: string; email: string }[] = eqR.ok ? await eqR.json() : [];
    const emailPorAmigo = new Map(equivalencias.map((e) => [e.amigo, e.email.toLowerCase()]));

    const emails = [...new Set(pessoas.map((p) => emailPorAmigo.get(p.amigo)).filter(Boolean))] as string[];
    if (emails.length === 0) return json({ enviados: 0, falhados: 0 });

    const subs = await subscriptionsDe(emails);

    let enviados = 0;
    let falhados = 0;
    await Promise.all(
      pessoas.map(async (p) => {
        const emailP = emailPorAmigo.get(p.amigo);
        if (!emailP) return;
        const payload = JSON.stringify({
          ...montarMensagem(tipo, p, descricao, quem),
          url: "/FestasBV/",
        });
        const r = await enviarParaSubs(subs.filter((s) => s.email === emailP), payload);
        enviados += r.enviados;
        falhados += r.falhados;
      }),
    );

    return json({ enviados, falhados });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
