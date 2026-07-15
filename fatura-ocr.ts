// supabase/functions/fatura-ocr/index.ts
// FestasBV — Lê uma fotografia de fatura/talão com o Gemini e devolve JSON
// estruturado (loja, data, total, linhas artigo a artigo) para a app
// pré-preencher o Registar Compra. Se a app mandar `categorias`, cada linha
// vem também com a categoria de produto sugerida; e há um modo só-texto
// (`artigos` sem `image`) que classifica artigos existentes em lote.
// Chamada pelo browser com o JWT do
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
   (ListModels) e ordenam-se os "flash" do melhor para o pior. Devolve-se a
   LISTA (não só o topo) para se poder cair para o modelo seguinte quando o
   preferido falha (404 se o modelo foi reformado, 503 se está sobrecarregado).
   O secret GEMINI_MODEL (opcional) é apenas uma PREFERÊNCIA: entra em primeiro
   lugar mas, se estiver morto, a lista de descoberta apanha o pedido a seguir —
   assim um pin desatualizado nunca deixa a app sem leitura. Cache em memória
   enquanto a instância viver. */
let _models: string[] | null = null;
function rankFlash(names: string[]): string[] {
  const ok = [...new Set(names.filter((n) =>
    n.includes("flash") &&
    !/(lite|8b|image|tts|live|audio|embed|exp|preview|thinking)/.test(n)
  ))];
  const score = (n: string): number => {
    if (n === "gemini-flash-latest") return 100; // apontador sempre atualizado
    const m = n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/);
    return m ? parseFloat(m[1]) : 0; // versão exata; genéricos ao fundo
  };
  return ok.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}
// Pergunta à API que modelos flash vivos a chave tem (com cache em memória).
async function descobrirFlash(): Promise<string[]> {
  if (_models) return _models;
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
    const ranked = rankFlash(names);
    if (ranked.length) _models = ranked;
  } catch (_) { /* fica o fallback */ }
  return _models ?? [];
}
// Aliases estáveis do Gemini, por ordem de preferência. São apontadores que a
// Google mantém a apontar para o modelo flash atual — ao contrário dos nomes
// datados (ex.: gemini-2.0-flash-001), que são reformados e passam a dar 404.
// A descoberta automática por vezes escolhe um desses nomes datados já morto;
// tentar primeiro estes aliases evita isso. gemini-flash-latest já respondeu
// (com 503) à nossa chave, logo é válido.
const ESTAVEIS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];
async function candidatosModelo(): Promise<string[]> {
  const pinned = Deno.env.get("GEMINI_MODEL");
  const descobertos = await descobrirFlash();
  // Ordem: pin manual (se existir) → aliases estáveis → descoberta ao vivo.
  // O handler salta 404s, por isso um alias morto passa ao seguinte sozinho.
  const vistos = new Set<string>();
  const lista = [...(pinned ? [pinned] : []), ...ESTAVEIS, ...descobertos]
    .filter((m) => (vistos.has(m) ? false : vistos.add(m)));
  return lista.length ? lista : ["gemini-flash-latest"];
}

// A app corre no GitHub Pages (origem diferente) → CORS obrigatório
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ── Categorias de artigos (opcional) ──
   A app pode mandar a lista de categorias (nome + descritivo, geridas pelo
   admin em Definições). Com ela, o OCR devolve também "categoria" por linha
   e existe um modo só-texto (artigos sem imagem) para classificar em lote.
   Como a lista vem da BD em cada chamada, categorias novas ficam
   automaticamente "conhecidas" pela AI — sem redeploy. */
type Cat = { nome: string; descritivo: string };
function lerCategorias(raw: unknown): Cat[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c.nome === "string" && c.nome.trim())
    .slice(0, 60)
    .map((c) => ({
      nome: String(c.nome).replace(/\s+/g, " ").trim().slice(0, 40),
      descritivo: String(c.descritivo ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
    }));
}
const catsLista = (cats: Cat[]) =>
  cats.map((c) => `  · ${c.nome}${c.descritivo ? ` — ${c.descritivo}` : ""}`).join("\n");

const promptFatura = (cats: Cat[]) => `Isto é um talão ou fatura de compras (Portugal) — fotografia ou
PDF (pode ter várias páginas; considera todas).
Extrai APENAS um objeto JSON com esta forma exata:
{"loja": string|null, "data": "YYYY-MM-DD"|null, "total": number|null,
 "linhas": [{"artigo": string, "qtd": string|null, "preco": number${cats.length ? ', "categoria": string|null' : ""}}]}

Regras:
- "linhas": só produtos comprados. Ignora subtotais, IVA, troco, pontos de
  cartão, sacos de caução devolvidos e linhas de desconto isoladas.
- "preco" é o valor total pago por essa linha, JÁ COM o desconto dessa linha
  aplicado se existir (se o desconto vier numa linha própria logo a seguir,
  subtrai-o ao artigo respetivo).
- "qtd": quantidade legível, ex. "2", "1,5 kg", "6 garrafas". null se não for claro.
- "artigo": nome legível em português. Expande abreviaturas óbvias
  (ex. "LTE MG UHT" -> "Leite meio-gordo UHT") mas não inventes.
- "loja": nome da cadeia/loja (ex. "Continente"), sem morada.${cats.length ? `
- "categoria": a categoria que melhor descreve o artigo, EXATAMENTE um destes
  nomes (copia o nome tal e qual), ou null se nenhum encaixar com confiança:
${catsLista(cats)}` : ""}
- Se algo não se ler com confiança, usa null nesse campo em vez de adivinhar.
Responde só com o JSON.`;

// Modo só-texto: classificar nomes de artigos já existentes (sem imagem)
const promptClassificar = (artigos: string[], cats: Cat[]) => `Classifica artigos de compras de
supermercado (Portugal) em categorias.

Categorias disponíveis:
${catsLista(cats)}

Artigos a classificar:
${artigos.map((a) => `  - ${a}`).join("\n")}

Responde APENAS com um objeto JSON com esta forma exata:
{"sugestoes": [{"artigo": string, "categoria": string|null}]}

Regras:
- Devolve UMA entrada por artigo, com "artigo" exatamente igual ao nome dado.
- "categoria": EXATAMENTE um dos nomes da lista (copia tal e qual), ou null
  se nenhum encaixar com confiança. Não inventes categorias novas.`;

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

    const { image, mime, categorias, artigos } = await req.json();
    const cats = lerCategorias(categorias);

    // Duas utilizações: OCR de fatura (image) ou classificação só-texto
    // (artigos, sem image) — o botão "✨ Categorias" da app.
    const soTexto = !image && Array.isArray(artigos);
    let parts: unknown[];
    if (soTexto) {
      const nomes = (artigos as unknown[])
        .filter((a) => typeof a === "string" && a.trim())
        .slice(0, 200)
        .map((a) => String(a).replace(/\s+/g, " ").trim().slice(0, 60));
      if (!nomes.length || !cats.length) {
        return json({ error: "artigos ou categorias em falta" }, 400);
      }
      parts = [{ text: promptClassificar(nomes, cats) }];
    } else {
      if (!image || typeof image !== "string" || image.length > 6_000_000) {
        return json({ error: "imagem em falta ou demasiado grande" }, 400);
      }
      parts = [
        { inline_data: { mime_type: mime || "image/jpeg", data: image } },
        { text: promptFatura(cats) },
      ];
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
          contents: [{ parts }],
          generationConfig,
        }),
      });
    };

    // 429/500/503 = sobrecarga temporária do lado do Google ("high demand").
    const transitorio = (s: number) => s === 429 || s === 500 || s === 503;
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

    // Percorre os modelos flash disponíveis. Para cada um tolera uma repetição
    // em erros transitórios (com pequeno backoff); se persistir, cai para o
    // modelo seguinte. Assim uma sobrecarga pontual num modelo não estraga a
    // leitura quando há outro flash livre.
    const candidatos = await candidatosModelo();
    // Marcador de versão + lista de candidatos: se este log não aparecer, é a
    // versão ANTIGA que está a correr (o deploy não pegou).
    console.log("FATURA-OCR build=categorias-v1 candidatos:", candidatos.join(", "));
    let model = candidatos[0] ?? "gemini-flash-latest";
    let g: Response | null = null;

    for (let ci = 0; ci < candidatos.length && !ctrl.signal.aborted; ci++) {
      model = candidatos[ci];
      for (let tent = 0; tent < 2 && !ctrl.signal.aborted; tent++) {
        g = await chamarGemini(model);
        console.log("FATURA-OCR tentativa:", model, "->", g.status);
        // Modelo não aceita o campo thinkingConfig (400)? Repete já sem ele.
        if (g.status === 400) {
          const d = await g.clone().text();
          if (/think/i.test(d)) g = await chamarGemini(model, false);
        }
        // Nome saiu do catálogo (404) → força redescoberta e salta de modelo.
        if (g.status === 404) { _models = null; break; }
        // Sobrecarga temporária → espera e repete o MESMO modelo.
        if (transitorio(g.status)) { await sleep(700 * (tent + 1)); continue; }
        break; // resposta definitiva (ok ou erro não recuperável)
      }
      if (g && g.ok) break;                                  // sucesso
      if (g && !transitorio(g.status) && g.status !== 404) break; // erro real
      // caso contrário (503 persistente ou 404) → tenta o próximo candidato
    }
    clearTimeout(timer);

    if (!g || !g.ok) {
      const status = g?.status ?? 502;
      const detail = g ? await g.text() : "";
      console.error("gemini", model, status, detail.slice(0, 500));
      // Sobrecarga esgotou todos os modelos → mensagem amiga (não o texto cru).
      if (transitorio(status)) {
        return json({
          error: "o serviço de leitura de faturas está com muita procura agora — espera um minuto e tenta outra vez",
        }, 503);
      }
      let msg = "";
      try { msg = JSON.parse(detail)?.error?.message ?? ""; } catch (_) { /**/ }
      return json({ error: `gemini ${status} (${model})${msg ? ": " + msg.slice(0, 180) : ""}` }, 502);
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
