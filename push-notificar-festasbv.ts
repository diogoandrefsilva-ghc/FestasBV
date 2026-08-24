// supabase/functions/push-notificar-festasbv/index.ts
// FestasBV — Envia notificações Web Push (Notification/Push API, sem
// Telegram). Irmã da Edge Function `push-notificar` do SplitBill (mesmo
// projeto Supabase, schema `festasbv`): as notificações Telegram
// (notif-festas/notif-pessoais) continuam a existir e não são tocadas por
// isto — são dois canais paralelos, cada um com o seu interruptor.
//
// CHAMA-SE "push-notificar-festasbv", NÃO "push-notificar": o nome da
// function é único por PROJETO Supabase, e o SplitBill já usa "push-notificar"
// neste mesmo projeto. Segue o padrão de "push-notificar-goals" (a app goals,
// também neste projeto). app.js chama exatamente este slug.
//
// Seis momentos, todos chamados pela app:
//   'fecho'                fecharContas() → TODOS os membros com conta
//                           ligada + o ADMIN: o ano fechou e está EM
//                           VALIDAÇÃO — cada um confirma as suas contas e
//                           NÃO paga ainda (fire-and-forget)
//   'pagamentos'           autorizarPagamentos() → os mesmos destinatários:
//                           a validação acabou e já se pode pagar
//                           (fire-and-forget)
//   'pagamento_declarado'  ao declarar "🤝 Pagar Dívida" (admin regista de
//                           imediato; um membro fica em pagamentos_pendentes
//                           à espera) → avisa sempre o ADMIN_EMAIL, que é
//                           quem aprova (fire-and-forget)
//   'pagamento_validado'   o outro lado do mesmo pedido: o admin validou-o e
//                           avisa-se de volta QUEM PAGOU — que o dinheiro
//                           chegou e como ficaram os saldos do casal
//                           (fire-and-forget)
//   'lembrete'              o admin, no separador Saldos, pede para lembrar
//                           um membro concreto de uma dívida em aberto
//                           (o utilizador espera pelo resultado)
//   'lembrete_validacao'    o admin, no painel "Validações" (Definições),
//                           pede para lembrar alguém de validar as
//                           presenças, os convidados ou as contas
//                           (db/validacoes_tipo.sql) — o `checkTipo` de
//                           cada pessoa diz qual dos três. Sem push ativo a
//                           app cai para um link de email (client-side);
//                           esta function só sabe de push
//
// 'fecho' e 'pagamentos' são os únicos com texto IGUAL PARA TODOS (são um
// aviso de fase, não um extrato): um payload só, mandado a toda a gente de
// uma vez. O saldo de cada um não vai lá de propósito — em 'fecho' porque
// ainda pode mudar com as validações, e em 'pagamentos' porque a app di-lo
// no ecrã dos Saldos, sempre atualizado. O ADMIN entra sempre na lista,
// mesmo que não esteja no plantel: é ele que dispara e quer ver o que os
// outros receberam.
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
// `festasbv.allowed_users`. Os tipos 'fecho', 'pagamentos', 'lembrete',
// 'lembrete_validacao' e 'pagamento_validado' só o admin pode disparar — é
// ele quem fecha as contas, quem autoriza os pagamentos, quem lembra
// dívidas/validações e quem valida um pagamento declarado; o pedido de
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
// Deploy: supabase functions deploy push-notificar-festasbv

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

type CheckTipo = "presencas" | "convidados" | "contas";
// `saldo`/`saldoConjuge` só existem no 'pagamento_validado': são as contas do
// ano, que a app calcula (aqui não há calcular() nenhum) e manda em números —
// a FRASE é sempre escolhida deste lado. Vêm COM SINAL (negativo = ainda
// deve); `null` no do cônjuge = não há cônjuge neste ano.
type Pessoa = {
  amigo: string;
  valor?: number;
  checkTipo?: CheckTipo;
  saldo?: number | null;
  saldoConjuge?: number | null;
};
type Tipo =
  | "fecho"
  | "pagamentos"
  | "pagamento_declarado"
  | "pagamento_validado"
  | "lembrete"
  | "lembrete_validacao";

function eurTxt(v: number) {
  return `€${Math.abs(v).toFixed(2).replace(".", ",")}`;
}
// Um SALDO, ao contrário de um valor, precisa do sinal: é ele que diz de que
// lado se está (negativo = ainda deve), e é assim que a app o mostra nos
// Saldos. O cêntimo perdido no arredondamento não é dívida nenhuma — abaixo de
// meio cêntimo escreve-se zero, senão saía um "−€0,00" a assustar quem já
// pagou tudo.
function saldoTxt(v: number) {
  return (v < -0.005 ? "−" : "") + eurTxt(v);
}

function checkTipoFrase(t?: CheckTipo): string {
  if (t === "presencas") return "as tuas presenças";
  if (t === "convidados") return "os convidados que trouxeste";
  return "as tuas contas";
}

// Os dois avisos de FASE ('fecho' e 'pagamentos'). O texto é o mesmo para
// toda a gente e `descricao` é só o nome do evento ("MEO 2026").
//
// O PUSH É O RESUMO, NÃO A MENSAGEM TODA: o iOS mostra ~4 linhas do corpo
// no ecrã bloqueado e corta o resto (só aparece ao expandir). Com o
// parágrafo inteiro aqui, o que ficava cortado era precisamente o "não
// pagues ainda" — a única coisa que este aviso tinha de dizer. Por isso o
// corpo cabe no relance e o ESSENCIAL VEM PRIMEIRO; a explicação completa
// vive no email e no cartão dos Saldos (avisoFaseTexto no app.js). Se
// voltares a pôr aqui o texto todo, volta a cortar-se no mesmo sítio.
//
// ⚠️ O TEXTO DE 'pagamentos' EXISTE EM DOIS SÍTIOS: aqui (push, escolhido
// sempre no servidor) e em avisoFaseTexto() no app.js (email + cartão). É
// de propósito — o push nunca aceita texto livre do cliente — mas os dois
// têm de dizer o mesmo. Se mexeres num, mexe no outro. O de 'fecho' é o
// resumo do que lá está, e é a versão longa que manda.
function faseTexto(tipo: "fecho" | "pagamentos", descricao?: string) {
  const ev = descricao || "das Festas";
  if (tipo === "pagamentos") {
    return {
      title: "💳 Já podes pagar",
      body: `As contas do ${ev} encontram-se fechadas e validadas. Podes (e deves!) proceder ao pagamento do teu saldo.`,
    };
  }
  return {
    title: "🔒 Contas fechadas — em validação",
    body: "Valida as tuas contas e as dos teus convidados nos Saldos. Não pagues ainda, as contas podem alterar.",
  };
}

function montarMensagem(tipo: Tipo, p: Pessoa, descricao?: string, quem?: string) {
  if (tipo === "lembrete") {
    return {
      title: "🔔 Lembrete de pagamento",
      body: `${quem || "O tesoureiro"} lembra-te que ainda deves ${eurTxt(p.valor ?? 0)}${descricao ? ` — ${descricao}` : ""}`,
    };
  }
  if (tipo === "lembrete_validacao") {
    return {
      title: "🔔 Lembrete de validação",
      body: `${quem || "O admin"} lembra-te de validar ${checkTipoFrase(p.checkTipo)}${descricao ? ` — ${descricao}` : ""}`,
    };
  }
  // O admin aceitou o pagamento declarado. A MENSAGEM É SEMPRE A MESMA — o
  // que entrou e como ficaram os saldos do casal — e é isso que a torna fácil
  // de ler: quem a recebe pela segunda vez já sabe onde está cada número, sem
  // caso especial nenhum a decorar. Os saldos vão com sinal, como no ecrã dos
  // Saldos: negativo = ainda falta, zero = está saldado. A única frase que
  // pode faltar é a do cônjuge, quando não há nenhum neste ano.
  if (tipo === "pagamento_validado") {
    // Saldo a `null` = a app não tem saldo para dar (não é membro do plantel
    // deste ano, ou não há cônjuge). Aí a frase desaparece: escrever "€0,00"
    // seria dizer "está saldado" sobre contas que não se chegaram a fazer.
    const saldo = (v?: number | null, txt = "Saldo atual") =>
      v === null || v === undefined ? "" : ` ${txt}: ${saldoTxt(v)}.`;
    return {
      title: "✅ Pagamento confirmado",
      body: `${quem || "O tesoureiro"} confirma que recebeu o teu pagamento de ${eurTxt(p.valor ?? 0)}.` +
        saldo(p.saldo) + saldo(p.saldoConjuge, "Saldo do teu cônjuge"),
    };
  }
  // 'fecho'/'pagamentos' não passam por aqui (são um payload só para todos,
  // tratados no handler) — este ramo é a rede de segurança de um tipo novo
  // que se esqueça de si próprio.
  return { title: "FestasBV", body: descricao || "" };
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
      const valor = (pessoas && pessoas[0] ? pessoas[0].valor : 0) ?? 0;
      const subs = await subscriptionsDe([ADMIN_EMAIL]);
      const payload = JSON.stringify({
        title: "✅ Pagamento declarado",
        body: `${quem || "Alguém"} diz que pagou ${eurTxt(valor)}${descricao ? ` — ${descricao}` : ""} — confirma na app`,
        url: "/FestasBV/",
      });
      return json(await enviarParaSubs(subs, payload));
    }

    // Os restantes só o admin os dispara — é ele quem fecha as contas, quem
    // autoriza os pagamentos, quem decide lembrar alguém de uma dívida ou de
    // um check por validar, e quem valida um pagamento declarado.
    if (
      tipo !== "fecho" && tipo !== "pagamentos" && tipo !== "lembrete" &&
      tipo !== "lembrete_validacao" && tipo !== "pagamento_validado"
    ) {
      return json({ error: "tipo inválido" }, 400);
    }
    if (emailChamador !== ADMIN_EMAIL) return json({ error: "só o admin" }, 403);
    // Lista vazia trava tudo menos os avisos de fase — nesses o admin recebe
    // sempre, mesmo num ano em que ninguém tenha conta ligada (é o "para ver
    // como fica" de quem carregou no botão).
    const lista = Array.isArray(pessoas) ? pessoas : [];
    const fase = tipo === "fecho" || tipo === "pagamentos";
    if (lista.length === 0 && !fase) return json({ enviados: 0, falhados: 0 });

    // amigo → email (só os amigos pedidos)
    const nomes = [...new Set(lista.map((p) => p.amigo).filter(Boolean))];
    const orList = nomes.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(",");
    const eqR = nomes.length
      ? await fetch(
        `${SB_URL}/rest/v1/user_amigos?amigo=in.(${orList})&select=amigo,email`,
        { headers: sbHeaders },
      )
      : null;
    const equivalencias: { amigo: string; email: string }[] = eqR && eqR.ok ? await eqR.json() : [];
    const emailPorAmigo = new Map(equivalencias.map((e) => [e.amigo, e.email.toLowerCase()]));

    // Avisos de FASE: o mesmo texto para toda a gente, logo um payload só
    // para TODAS as subscriptions de uma vez. O admin entra sempre na lista
    // (mesmo fora do plantel, ou sem `amigo` que resolva) — dispara e quer
    // ver o que os outros receberam. Mandar por pessoa, como os outros
    // tipos fazem, duplicaria o push a quem está nas duas listas.
    if (fase) {
      const alvos = new Set(
        lista.map((p) => emailPorAmigo.get(p.amigo)).filter(Boolean) as string[],
      );
      alvos.add(ADMIN_EMAIL);
      const subs = await subscriptionsDe([...alvos]);
      const payload = JSON.stringify({ ...faseTexto(tipo as "fecho" | "pagamentos", descricao), url: "/FestasBV/" });
      return json(await enviarParaSubs(subs, payload));
    }

    const emails = [...new Set(lista.map((p) => emailPorAmigo.get(p.amigo)).filter(Boolean))] as string[];
    if (emails.length === 0) return json({ enviados: 0, falhados: 0 });

    const subs = await subscriptionsDe(emails);

    let enviados = 0;
    let falhados = 0;
    await Promise.all(
      lista.map(async (p) => {
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
