// supabase/functions/fatura-ocr/index.ts
// FestasBV — Lê uma fotografia de fatura/talão com o Gemini e devolve JSON
// estruturado (loja, data, total, linhas artigo a artigo) para a app
// pré-preencher o Registar Compra. Chamada pelo browser com o JWT do
// utilizador (verify_jwt fica LIGADO no deploy — é o gateway que valida).
//
// Por cima disso confirma-se ainda que o email consta de allowed_users
// (mesma regra de acesso da app).
//
// Secrets necessários (Edge Functions -> Secrets):
//   GEMINI_API_KEY       chave do Google AI Studio (free tier chega)
//   GEMINI_MODEL         (opcional) fixa um modelo concreto; sem ele a função
//                        descobre sozinha o melhor "flash" disponível na chave
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)
//
// Deploy: supabase functions deploy fatura-ocr

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
// Limite próprio para a chamada ao Gemini. Abaixo dos ~60s a que o Safari/iOS
// mata o pedido, para conseguirmos devolver um erro claro em vez de "Load failed".
const TIMEOUT_MS = 50_000;

/* ── Escolha do modelo ──
   Os nomes dos modelos Gemini mudam com o tempo (foi assim que apanhámos um
   404). Em vez de fixar um nome, pergunta-se à API que modelos a chave tem
   (ListModels) e escolhe-se o melhor "flash". Cache em memória enquanto a
   instância viver. Override manual: secret GEMINI_MODEL (opcional). */
let _model: string | null = null;
function rankFlash(names: string[]): string | null {
  const ok = names.filter((n) =>
    n.includes("flash") &&
    !/(lite|8b|image|tts|live|audio|embed|exp|preview|thinking)/.test(n)
  );
  if (!ok.length) return null;
  if (ok.includes("gemini-flash-latest")) return "gemini-flash-latest";
  const exact = ok
    .map((n) => {
      const m = n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/);
      return m ? { n, v: parseFloat(m[1]) } : null;
    })
    .filter((x): x is { n: string; v: number } => !!x)
    .sort((a, b) => b.v - a.v);
  if (exact.length) return exact[0].n;
  return ok.sort().reverse()[0];
}
async function escolherModelo(): Promise<string> {
  const pinned = Deno.env.get("GEMINI_MODEL");
  if (pinned) return pinned;
  if (_model) return _model;
  try {
    const names: string[] = [];
    let page = "";
    for (let i = 0; i < 3; i++) {
      const r = await fetch(
        `${GAPI}/models?pageSize=200${page ? `&pageToken=${page}` : ""}&key=${GEMINI_KEY}`,
      );
      if (!r.ok) break;
      const d = await r.json();
      (d.models ?? []).forEach((m: any) => {
        if ((m.supportedGenerationMethods ?? []).includes("generateContent")) {
          names.push(String(m.name).replace(/^models\//, ""));
        }
      });
      page = d.nextPageToken ?? "";
      if (!page) break;
    }
    _model = rankFlash(names);
  } catch (_) { /* fica o fallback */ }
  return _model ?? "gemini-flash-latest";
}

// A app corre no GitHub Pages (origem diferente) → CORS obrigatório
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROMPT = `Isto é um talão ou fatura de compras (Portugal) — fotografia ou
PDF (pode ter várias páginas; considera todas).
Extrai APENAS um objeto JSON com esta forma exata:
{"loja": string|null, "data": "YYYY-MM-DD"|null, "total": number|null,
 "linhas": [{"artigo": string, "qtd": string|null, "preco": number}]}

Regras:
- "linhas": só produtos comprados. Ignora subtotais, IVA, troco, pontos de
  cartão, sacos de caução devolvidos e linhas de desconto isoladas.
- "preco" é o valor total pago por essa linha, JÁ COM o desconto dessa linha
  aplicado se existir (se o desconto vier numa linha própria logo a seguir,
  subtrai-o ao artigo respetivo).
- "qtd": quantidade legível, ex. "2", "1,5 kg", "6 garrafas". null se não for claro.
- "artigo": nome legível em português. Expande abreviaturas óbvias
  (ex. "LTE MG UHT" -> "Leite meio-gordo UHT") mas não inventes.
- "loja": nome da cadeia/loja (ex. "Continente"), sem morada.
- Se algo não se ler com confiança, usa null nesse campo em vez de adivinhar.
Responde só com o JSON.`;

async function emailAutorizado(auth: string): Promise<boolean> {
  // 1) quem é o utilizador deste token?
  const u = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SRV, Authorization: auth },
  });
  if (!u.ok) return false;
  const email = ((await u.json()).email ?? "").toLowerCase();
  if (!email) return false;
  // 2) consta de festasbv.allowed_users?
  const r = await fetch(
    `${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,
    {
      headers: {
        apikey: SB_SRV,
        Authorization: `Bearer ${SB_SRV}`,
        "Accept-Profile": "festasbv",
      },
    },
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
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
    if (!(await emailAutorizado(auth))) {
      return json({ error: "não autorizado" }, 403);
    }

    const { image, mime } = await req.json();
    if (!image || typeof image !== "string" || image.length > 6_000_000) {
      return json({ error: "imagem em falta ou demasiado grande" }, 400);
    }

    // O Safari/iOS corta pedidos que passem dos ~60s ("Load failed", sem
    // detalhe). Impomos um limite próprio mais curto para conseguir devolver
    // um erro legível ANTES de o browser rebentar às cegas.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    const chamarGemini = (model: string, desligarThinking = true) => {
      const generationConfig: Record<string, unknown> = {
        response_mime_type: "application/json",
        temperature: 0,
      };
      // Os modelos 2.5 "pensam" por defeito e isso pode custar dezenas de
      // segundos — o suficiente para estoirar o limite do Safari. Com
      // thinkingBudget:0 desligamos o thinking (resposta muito mais rápida).
      // Se o modelo não suportar o campo devolve 400 → repetimos sem ele.
      if (desligarThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      return fetch(`${GAPI}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mime || "image/jpeg", data: image } },
              { text: PROMPT },
            ],
          }],
          generationConfig,
        }),
      });
    };

    let model = await escolherModelo();
    let g = await chamarGemini(model);
    // Modelo desapareceu do catálogo (404)? Redescobre e tenta uma vez mais.
    if (g.status === 404) {
      _model = null;
      const m2 = await escolherModelo();
      if (m2 !== model) {
        model = m2;
        g = await chamarGemini(model);
      }
    }
    // Modelo não aceita o campo thinkingConfig (400)? Repete sem ele.
    if (g.status === 400) {
      const d = await g.clone().text();
      if (/think/i.test(d)) g = await chamarGemini(model, false);
    }
    clearTimeout(timer);
    if (!g.ok) {
      const detail = await g.text();
      console.error("gemini", model, g.status, detail.slice(0, 500));
      let msg = "";
      try { msg = JSON.parse(detail)?.error?.message ?? ""; } catch (_) { /**/ }
      return json({ error: `gemini ${g.status} (${model})${msg ? ": " + msg.slice(0, 180) : ""}` }, 502);
    }
    const gd = await g.json();
    const text = gd?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      return json({ error: "resposta ilegível do modelo" }, 502);
    }
    return json(parsed);
  } catch (e) {
    const err = e as Error;
    // Estoirou o nosso timeout antes de o modelo responder.
    if (err.name === "AbortError") {
      return json({
        error: "o modelo demorou demasiado a ler a fatura — tenta uma foto mais nítida ou um PDF com menos páginas",
      }, 504);
    }
    return json({ error: err.message }, 500);
  }
});
