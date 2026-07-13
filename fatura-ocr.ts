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
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)
//
// Deploy: supabase functions deploy fatura-ocr

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = "gemini-2.5-flash";

// A app corre no GitHub Pages (origem diferente) → CORS obrigatório
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROMPT = `Isto é a fotografia de um talão ou fatura de compras (Portugal).
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

    const g = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mime || "image/jpeg", data: image } },
              { text: PROMPT },
            ],
          }],
          generationConfig: { response_mime_type: "application/json", temperature: 0 },
        }),
      },
    );
    if (!g.ok) {
      const detail = await g.text();
      console.error("gemini", g.status, detail.slice(0, 500));
      return json({ error: `gemini ${g.status}` }, 502);
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
    return json({ error: (e as Error).message }, 500);
  }
});
