/* =====================================================================
   GOOD - Checkout Alerta FRAGIL SKUs — Painel Online + Buscador Bling
   - Painel admin (lista de SKUs frágeis e configurações)
   - OAuth Bling com renovação automática
   - Cache de produtos (SKU + EAN + nome + imagem)
   - Endpoint /api/buscar pra autocomplete na UI
   ===================================================================== */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ----- ARQUIVO DE DADOS (Render Disk persistente) -----
const DATA_DIR = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, "skus.json");

// ----- ENV VARS -----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || "";
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || "";
const RENDER_API_KEY = process.env.RENDER_API_KEY || "";
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || "";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===================================================================
// PARTE 1 — PAINEL DE SKUs FRÁGEIS (já existia)
// ===================================================================

function dadosPadrao() {
  return {
    config: {
      tempoMinimoSegundos: 2,
      mensagemPadrao: "Atenção. Produto frágil. Embalar com plástico bolha e reforçar a caixa.",
      repetirVoz: false
    },
    skus: {},
    atualizadoEm: null
  };
}

function lerDados() {
  try {
    if (!fs.existsSync(DATA_FILE)) return dadosPadrao();
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const obj = JSON.parse(raw);
    const padrao = dadosPadrao();
    return {
      config: { ...padrao.config, ...(obj.config || {}) },
      skus: obj.skus || {},
      atualizadoEm: obj.atualizadoEm || null
    };
  } catch (e) {
    console.error("[ERRO] Lendo arquivo:", e.message);
    return dadosPadrao();
  }
}

function salvarDados(dados) {
  dados.atualizadoEm = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(dados, null, 2), "utf8");
  return dados;
}

// ===================================================================
// PARTE 2 — BLING OAUTH + CACHE DE PRODUTOS
// ===================================================================

const cacheDetalhes = new Map();   // id -> produto completo
const indiceSku = new Map();        // sku_lower -> id
const indiceEan = new Map();        // ean_digits -> id
let listagemCarregada = false;
let eansCarregados = false;

function normalize(v) { return String(v || "").trim().toLowerCase(); }
function onlyDigits(v) { return String(v || "").replace(/\D/g, ""); }

function extractImage(produto) {
  const vistos = new Set();
  function proc(obj) {
    if (!obj) return "";
    if (typeof obj === "string") {
      const v = obj.trim();
      if (/^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(v)) return v;
      if (/^https?:\/\/lh3\.googleusercontent\.com\//i.test(v)) return v;
      return "";
    }
    if (typeof obj !== "object" || vistos.has(obj)) return "";
    vistos.add(obj);
    if (Array.isArray(obj)) {
      for (const i of obj) { const a = proc(i); if (a) return a; }
      return "";
    }
    for (const k of Object.keys(obj)) { const a = proc(obj[k]); if (a) return a; }
    return "";
  }
  return proc(produto) || "";
}

function getSkus(p) { return [p?.codigo, p?.sku, p?.codigoProduto].filter(Boolean); }
function getEans(p) {
  return [
    p?.gtin, p?.ean, p?.codigoBarras, p?.gtinEan, p?.gtinTributario,
    p?.codigo_barras, p?.codigoDeBarras, p?.codBarras,
    p?.tributavel?.gtin, p?.tributavel?.ean,
    p?.tributacao?.gtin, p?.tributacao?.ean
  ].filter(Boolean);
}

function formatarProduto(p) {
  return {
    id: p.id,
    nome: p.nome || "",
    codigo: p.codigo || p.sku || "",
    imagem: extractImage(p),
    ean: getEans(p).find(Boolean) || ""
  };
}

// ----- Atualizar env var no Render (pra persistir tokens novos) -----
async function atualizarVariavelRender(chave, valor) {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    console.warn("[RENDER] RENDER_API_KEY ou RENDER_SERVICE_ID não configurados, token não será persistido");
    return false;
  }
  try {
    const getResp = await fetch(
      `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,
      { headers: { Authorization: `Bearer ${RENDER_API_KEY}`, Accept: "application/json" } }
    );
    if (!getResp.ok) {
      console.warn("[RENDER] GET env-vars falhou:", getResp.status);
      return false;
    }
    const envVars = await getResp.json();
    const atualizadas = envVars.map(item => ({
      key: item.envVar?.key || item.key,
      value: (item.envVar?.key || item.key) === chave
        ? valor
        : (item.envVar?.value || item.value || "")
    }));
    const putResp = await fetch(
      `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${RENDER_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(atualizadas)
      }
    );
    if (!putResp.ok) {
      console.warn("[RENDER] PUT env-vars falhou:", putResp.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[RENDER] erro:", e.message);
    return false;
  }
}

// ----- OAuth Bling -----
async function renovarAccessToken() {
  if (!BLING_CLIENT_ID || !BLING_CLIENT_SECRET) {
    throw new Error("BLING_CLIENT_ID/SECRET ausentes nas env vars");
  }
  const refreshToken = process.env.BLING_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error("BLING_REFRESH_TOKEN ausente — faça o login OAuth inicial em /auth/bling");
  }
  const basicAuth = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams();
  body.append("grant_type", "refresh_token");
  body.append("refresh_token", String(refreshToken).trim());

  const r = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "1.0"
    },
    body: body.toString()
  });
  let data = {};
  try { data = await r.json(); } catch { data = {}; }
  if (!r.ok || !data?.access_token) {
    throw new Error("Falha ao renovar token: " + (data?.error?.description || r.status));
  }
  process.env.BLING_ACCESS_TOKEN = data.access_token;
  if (data.refresh_token) process.env.BLING_REFRESH_TOKEN = data.refresh_token;
  await atualizarVariavelRender("BLING_ACCESS_TOKEN", data.access_token);
  if (data.refresh_token) await atualizarVariavelRender("BLING_REFRESH_TOKEN", data.refresh_token);
  console.log("[TOKEN] Renovado!");
  return data;
}

async function blingFetch(url, options = {}) {
  const token = process.env.BLING_ACCESS_TOKEN;
  async function doFetch(t) {
    const r = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: "application/json",
        ...(options.headers || {})
      }
    });
    let d = {};
    try { d = await r.json(); } catch { d = {}; }
    return { response: r, data: d };
  }
  let result = await doFetch(token);
  if (result.response.status === 401 || /invalid_token/i.test(JSON.stringify(result.data || {}))) {
    const novos = await renovarAccessToken();
    result = await doFetch(novos.access_token);
  }
  return result;
}

async function blingFetchComRetry(url, options = {}) {
  for (let i = 0; i < 4; i++) {
    const result = await blingFetch(url, options);
    if (result.response.status === 429) {
      await sleep(1500 * (i + 1));
      continue;
    }
    return result;
  }
  return await blingFetch(url, options);
}

// ----- Carregar índice de produtos -----
async function buscarDetalhe(id) {
  const cached = cacheDetalhes.get(String(id));
  if (cached) return cached;
  const { response, data } = await blingFetchComRetry(`https://api.bling.com.br/Api/v3/produtos/${id}`);
  if (!response.ok || !data?.data) return null;
  const p = data.data;
  cacheDetalhes.set(String(p.id), p);
  getEans(p).forEach(e => {
    const d = onlyDigits(e);
    if (d && d.length >= 8) indiceEan.set(d, String(p.id));
  });
  getSkus(p).forEach(s => { if (s) indiceSku.set(normalize(s), String(p.id)); });
  return p;
}

async function carregarEansBackground() {
  console.log("[EANS] Iniciando carregamento de EANs em background...");
  let total = 0;
  for (const [, id] of indiceSku) {
    if (cacheDetalhes.has(id)) { total++; continue; }
    try {
      await sleep(1000);
      await buscarDetalhe(id);
      total++;
      if (total % 50 === 0) {
        console.log(`[EANS] ${total}/${indiceSku.size} produtos carregados...`);
      }
    } catch (e) { /* ignora erros individuais */ }
  }
  eansCarregados = true;
  console.log(`[EANS] ✅ Todos os EANs carregados! ${indiceEan.size} EANs no índice.`);
}

async function carregarIndiceListagem() {
  if (!process.env.BLING_ACCESS_TOKEN && !process.env.BLING_REFRESH_TOKEN) {
    console.warn("[INDICE] Sem tokens Bling — pulando carregamento de produtos. Faça login em /auth/bling");
    return;
  }
  console.log("[INDICE] Carregando índice de produtos do Bling...");
  let pagina = 1;
  let total = 0;
  while (true) {
    try {
      const url = `https://api.bling.com.br/Api/v3/produtos?pagina=${pagina}&limite=100`;
      const { response, data } = await blingFetchComRetry(url);
      if (!response.ok) {
        console.warn(`[INDICE] Erro página ${pagina}:`, response.status);
        break;
      }
      const lista = data?.data || [];
      if (!lista.length) break;
      for (const item of lista) {
        if (!item?.id || !item?.codigo) continue;
        const id = String(item.id);
        indiceSku.set(normalize(item.codigo), id);
        if (item.sku) indiceSku.set(normalize(item.sku), id);
        total++;
      }
      if (lista.length < 100) break;
      pagina++;
      await sleep(300);
    } catch (e) {
      console.error("[INDICE] Erro:", e.message);
      break;
    }
  }
  listagemCarregada = true;
  console.log(`[INDICE] ✅ ${total} produtos indexados por SKU.`);
  carregarEansBackground();
  // Sync periódico
  setInterval(async () => {
    try {
      const { response, data } = await blingFetchComRetry(
        `https://api.bling.com.br/Api/v3/produtos?pagina=1&limite=100`
      );
      if (!response.ok) return;
      const lista = data?.data || [];
      let novos = 0;
      for (const item of lista) {
        if (!item?.id || !item?.codigo) continue;
        const id = String(item.id);
        if (!indiceSku.has(normalize(item.codigo))) novos++;
        indiceSku.set(normalize(item.codigo), id);
        if (item.sku) indiceSku.set(normalize(item.sku), id);
      }
      if (novos > 0) console.log(`[INDICE] Sync: ${novos} produtos novos.`);
    } catch (e) { /* ignora */ }
  }, 5 * 60 * 1000);
}

// ===================================================================
// PARTE 3 — MIDDLEWARE
// ===================================================================

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

function exigirSenha(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const enviada = req.headers["x-admin-password"] || "";
  if (enviada !== ADMIN_PASSWORD) {
    return res.status(401).json({ erro: "Senha invalida ou nao fornecida." });
  }
  next();
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ===================================================================
// PARTE 4 — ROTAS
// ===================================================================

// ----- API: SKUs frágeis (lista + config) -----
app.get("/api/skus", (req, res) => {
  res.json(lerDados());
});

app.post("/api/skus", exigirSenha, (req, res) => {
  try {
    const body = req.body || {};
    const atual = lerDados();
    const novo = {
      config: {
        tempoMinimoSegundos: clampInt(body && body.config && body.config.tempoMinimoSegundos, 0, 30, atual.config.tempoMinimoSegundos),
        mensagemPadrao: typeof (body && body.config && body.config.mensagemPadrao) === "string"
          ? body.config.mensagemPadrao.slice(0, 500)
          : atual.config.mensagemPadrao,
        repetirVoz: !!(body && body.config && body.config.repetirVoz)
      },
      skus: typeof body.skus === "object" && body.skus !== null ? body.skus : atual.skus
    };
    const salvo = salvarDados(novo);
    console.log("[SAVE] " + Object.keys(salvo.skus).length + " SKUs | tempoMin=" + salvo.config.tempoMinimoSegundos + "s");
    res.json(salvo);
  } catch (e) {
    console.error("[ERRO] POST /api/skus:", e);
    res.status(500).json({ erro: e.message });
  }
});

// ----- API: check auth -----
app.get("/api/check-auth", (req, res) => {
  res.json({ exigeSenha: !!ADMIN_PASSWORD });
});

app.post("/api/check-auth", (req, res) => {
  if (!ADMIN_PASSWORD) return res.json({ ok: true, exigeSenha: false });
  const enviada = req.headers["x-admin-password"] || "";
  res.json({ ok: enviada === ADMIN_PASSWORD, exigeSenha: true });
});

// ----- API: buscar produtos (autocomplete) -----
app.get("/api/buscar", exigirSenha, (req, res) => {
  try {
    const termo = String(req.query.q || "").trim();
    const cacheStatus = {
      listagemCarregada,
      eansCarregados,
      skusIndexados: indiceSku.size,
      detalhesEmCache: cacheDetalhes.size
    };
    if (!termo) return res.json({ ok: true, total: 0, resultados: [], cacheStatus });
    const limiteResp = Math.min(parseInt(req.query.limite, 10) || 50, 200);
    const termoNorm = normalize(termo);
    const termoDigits = onlyDigits(termo);
    const idsVistos = new Set();
    const resultados = [];
    function adicionar(item) {
      const id = String(item.id);
      if (idsVistos.has(id)) return;
      idsVistos.add(id);
      resultados.push(item);
    }
    // 1. SKU
    for (const [skuNorm, id] of indiceSku) {
      if (resultados.length >= limiteResp) break;
      if (skuNorm.includes(termoNorm)) {
        const p = cacheDetalhes.get(String(id));
        if (p) {
          adicionar(formatarProduto(p));
        } else {
          adicionar({
            id, codigo: skuNorm.toUpperCase(),
            nome: "(carregando detalhes...)",
            imagem: "", ean: ""
          });
        }
      }
    }
    // 2. EAN (numérico, 8+ dígitos)
    if (termoDigits.length >= 8 && resultados.length < limiteResp) {
      for (const [ean, id] of indiceEan) {
        if (resultados.length >= limiteResp) break;
        if (ean.includes(termoDigits)) {
          const p = cacheDetalhes.get(String(id));
          if (p) adicionar(formatarProduto(p));
        }
      }
    }
    // 3. Nome (apenas em produtos com detalhe carregado)
    if (resultados.length < limiteResp) {
      for (const [, p] of cacheDetalhes) {
        if (resultados.length >= limiteResp) break;
        if (normalize(p.nome).includes(termoNorm)) adicionar(formatarProduto(p));
      }
    }
    // Ordena: matches exatos por SKU primeiro, depois alfabético
    resultados.sort((a, b) => {
      const aExact = normalize(a.codigo) === termoNorm ? 0 : 1;
      const bExact = normalize(b.codigo) === termoNorm ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return (a.codigo || "").localeCompare(b.codigo || "", "pt-BR", { numeric: true });
    });
    res.json({ ok: true, total: resultados.length, resultados, cacheStatus });
  } catch (e) {
    console.error("[/api/buscar] ERRO:", e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ----- OAUTH BLING -----
const OAUTH_REDIRECT = (req) => `${req.protocol}://${req.get("host")}/bling/callback`;

app.get("/auth/bling", exigirSenha, (req, res) => {
  if (!BLING_CLIENT_ID) return res.status(500).send("BLING_CLIENT_ID não configurado");
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${encodeURIComponent(BLING_CLIENT_ID)}&state=${Date.now()}`;
  res.redirect(url);
});

app.get("/bling/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Faltou ?code=");
    if (!BLING_CLIENT_ID || !BLING_CLIENT_SECRET) {
      return res.status(500).send("BLING_CLIENT_ID/SECRET não configurados");
    }
    const basicAuth = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString("base64");
    const body = new URLSearchParams();
    body.append("grant_type", "authorization_code");
    body.append("code", String(code).trim());
    const r = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "1.0"
      },
      body: body.toString()
    });
    let data = {};
    try { data = await r.json(); } catch { data = {}; }
    if (!r.ok || !data?.access_token) {
      return res.status(500).send("Erro OAuth: " + (data?.error?.description || r.status));
    }
    process.env.BLING_ACCESS_TOKEN = data.access_token;
    process.env.BLING_REFRESH_TOKEN = data.refresh_token;
    await atualizarVariavelRender("BLING_ACCESS_TOKEN", data.access_token);
    await atualizarVariavelRender("BLING_REFRESH_TOKEN", data.refresh_token);
    console.log("[OAUTH] Login concluído. Iniciando carregamento de produtos...");
    setTimeout(carregarIndiceListagem, 1000);
    res.send(`
      <html><body style="font-family:Arial;padding:40px;text-align:center;">
        <h1 style="color:#28a745;">✅ Login Bling concluído!</h1>
        <p>Tokens capturados e salvos no Render.</p>
        <p>O carregamento dos produtos vai começar agora (leva ~30s pra SKUs e ~18min pra EANs e nomes completos).</p>
        <p><a href="/">Voltar ao painel</a></p>
      </body></html>
    `);
  } catch (e) {
    console.error("[OAUTH] erro:", e);
    res.status(500).send("Erro: " + e.message);
  }
});

// ----- HEALTH + STATUS -----
app.get("/health", (req, res) => {
  const dados = lerDados();
  res.json({
    ok: true,
    skusFrageis: Object.keys(dados.skus).length,
    atualizadoEm: dados.atualizadoEm,
    senhaConfigurada: !!ADMIN_PASSWORD,
    blingConfigurado: !!BLING_CLIENT_ID && !!BLING_CLIENT_SECRET,
    blingLogado: !!process.env.BLING_ACCESS_TOKEN || !!process.env.BLING_REFRESH_TOKEN
  });
});

app.get("/api/cache-status", (req, res) => {
  res.json({
    listagemCarregada,
    eansCarregados,
    skusIndexados: indiceSku.size,
    eansIndexados: indiceEan.size,
    detalhesEmCache: cacheDetalhes.size
  });
});

// ----- START -----
app.listen(PORT, () => {
  console.log("[SERVER] rodando na porta " + PORT);
  console.log("[DATA]   arquivo: " + DATA_FILE);
  console.log("[AUTH]   senha admin: " + (ADMIN_PASSWORD ? "CONFIGURADA" : "NAO configurada (painel aberto)"));
  console.log("[BLING]  client: " + (BLING_CLIENT_ID ? "OK" : "FALTANDO"));
  console.log("[BLING]  tokens: " + (process.env.BLING_ACCESS_TOKEN ? "OK (vai carregar produtos em 3s)" : "FALTANDO (acesse /auth/bling)"));
  // Carrega índice se já tiver tokens
  if (process.env.BLING_ACCESS_TOKEN || process.env.BLING_REFRESH_TOKEN) {
    setTimeout(carregarIndiceListagem, 3000);
  }
});
