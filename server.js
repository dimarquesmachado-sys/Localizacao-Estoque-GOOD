const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY;
const RENDER_API_KEY = "rnd_1NUSsu0O0VLBaf0sEFgo8gE4epHT";
const RENDER_SERVICE_ID = "srv-d71m8o15pdvs7381m9l0";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ================= CACHE SIMPLES =================
// Só guarda id -> produto completo para produtos já buscados
const cacheDetalhes = new Map(); // id -> produto completo
const indiceSku = new Map();     // sku_lower -> id  (populado da listagem)
const indiceEan = new Map();     // ean_digits -> id (populado quando produto é buscado)
let listagemCarregada = false;

// ================= RENDER API =================
async function atualizarVariavelRender(chave, valor) {
  try {
    const getResp = await fetch(
      `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,
      { headers: { Authorization: `Bearer ${RENDER_API_KEY}`, Accept: "application/json" } }
    );
    if (!getResp.ok) return false;
    const envVars = await getResp.json();
    const atualizadas = envVars.map(item => ({
      key: item.envVar?.key || item.key,
      value: (item.envVar?.key || item.key) === chave ? valor : (item.envVar?.value || item.value || "")
    }));
    const putResp = await fetch(
      `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${RENDER_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(atualizadas)
      }
    );
    return putResp.ok;
  } catch (e) { return false; }
}

// ================= HELPERS =================
function traduzirErroBling(msg) {
  const texto = String(msg || "").toLowerCase().trim();
  if (texto.includes("invalid refresh token")) return "Token inválido. Renove os tokens no Render.";
  if (texto.includes("invalid_token")) return "Token expirado.";
  return "Erro de comunicação com o Bling.";
}

let usuarios = [];
try { usuarios = JSON.parse(fs.readFileSync("./usuarios.json", "utf8")); } catch (e) { usuarios = []; }

function normalize(v) { return String(v || "").trim().toLowerCase(); }
function onlyDigits(v) { return String(v || "").replace(/\D/g, ""); }
function isExactCI(a, b) { return normalize(a) === normalize(b); }
function isExactDigits(a, b) { const aa = onlyDigits(a); const bb = onlyDigits(b); return aa && bb && aa === bb; }

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
    if (Array.isArray(obj)) { for (const i of obj) { const a = proc(i); if (a) return a; } return ""; }
    for (const k of Object.keys(obj)) { const a = proc(obj[k]); if (a) return a; }
    return "";
  }
  return proc(produto) || "";
}

function extractLocalizacao(p) {
  return p?.estoque?.localizacao || p?.localizacao || p?.depositos?.[0]?.localizacao || "";
}
function extractEstoque(p) {
  return p?.estoque?.saldoVirtualTotal ?? p?.estoque?.saldoVirtual ?? p?.saldoVirtualTotal ?? 0;
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
    id: p.id, nome: p.nome || "",
    codigo: p.codigo || p.sku || "",
    estoque: extractEstoque(p),
    localizacao: extractLocalizacao(p),
    imagem: extractImage(p),
    ean: getEans(p).find(Boolean) || ""
  };
}

// ================= LOGIN =================
app.post("/login", (req, res) => {
  try {
    const { usuario, senha } = req.body || {};
    const user = usuarios.find(u => u.usuario === usuario && u.senha === senha);
    if (user) return res.json({ sucesso: true, perfil: user.perfil, usuario: user.usuario });
    return res.status(401).json({ sucesso: false, mensagem: "Usuário ou senha inválidos" });
  } catch (e) { return res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

// ================= TOKEN =================
async function renovarAccessToken() {
  const clientId = process.env.BLING_CLIENT_ID;
  const clientSecret = process.env.BLING_CLIENT_SECRET;
  const refreshToken = process.env.BLING_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Credenciais OAuth ausentes.");

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams();
  body.append("grant_type", "refresh_token");
  body.append("refresh_token", String(refreshToken).trim());

  const response = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "1.0" },
    body: body.toString()
  });
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok || !data?.access_token) {
    throw new Error(traduzirErroBling(data?.error?.description || "Falha ao renovar token"));
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
    const r = await fetch(url, { ...options, headers: { Authorization: `Bearer ${t}`, Accept: "application/json", ...(options.headers || {}) } });
    let d = {};
    try { d = await r.json(); } catch { d = {}; }
    return { response: r, data: d };
  }
  let { response, data } = await doFetch(token);
  if (response.status === 401 || /invalid_token/i.test(JSON.stringify(data || {}))) {
    const novos = await renovarAccessToken();
    const segunda = await doFetch(novos.access_token);
    response = segunda.response; data = segunda.data;
  }
  return { response, data };
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

// ================= CARREGAR ÍNDICE DA LISTAGEM =================
// Carrega apenas a listagem básica (sem detalhes) — bem rápido
async function carregarIndiceListagem() {
  console.log("[INDICE] Carregando índice de produtos...");
  let pagina = 1;
  let total = 0;

  while (true) {
    try {
      const url = `https://api.bling.com.br/Api/v3/produtos?pagina=${pagina}&limite=100`;
      const { response, data } = await blingFetchComRetry(url);
      if (!response.ok) { console.warn(`[INDICE] Erro página ${pagina}:`, response.status); break; }

      const lista = data?.data || [];
      if (!lista.length) break;

      for (const item of lista) {
        if (!item?.id || !item?.codigo) continue;
        const id = String(item.id);
        // Indexa pelo codigo/sku da listagem
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

  // Sync a cada 5 minutos
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

// ================= BUSCAR DETALHE COM CACHE =================
async function buscarDetalhe(id) {
  const cached = cacheDetalhes.get(String(id));
  if (cached) return cached;

  const { response, data } = await blingFetchComRetry(`https://api.bling.com.br/Api/v3/produtos/${id}`);
  if (!response.ok || !data?.data) return null;

  const p = data.data;
  // Salva no cache
  cacheDetalhes.set(String(p.id), p);
  // Indexa EANs
  getEans(p).forEach(e => {
    const d = onlyDigits(e);
    if (d && d.length >= 8) indiceEan.set(d, String(p.id));
  });
  // Garante SKU indexado
  getSkus(p).forEach(s => { if (s) indiceSku.set(normalize(s), String(p.id)); });
  return p;
}

// ================= RESOLVER PRODUTO =================
async function resolverProduto(tipo, valor) {
  const tipoBusca = String(tipo || "").toUpperCase();
  const valorOriginal = String(valor || "").trim();
  if (!valorOriginal) return { ok: false, erro: "Código não informado" };

  // ===== BUSCA POR SKU =====
  if (tipoBusca === "SKU") {
    // 1. Tenta no índice primeiro
    const id = indiceSku.get(normalize(valorOriginal));
    if (id) {
      const p = await buscarDetalhe(id);
      if (p && getSkus(p).some(s => isExactCI(s, valorOriginal))) {
        console.log(`[SKU-HIT] ${valorOriginal} → ${p.codigo}`);
        return { ok: true, produto: p };
      }
    }
    // 2. Fallback: busca direta na API
    const { response, data } = await blingFetchComRetry(
      `https://api.bling.com.br/Api/v3/produtos?codigo=${encodeURIComponent(valorOriginal)}`
    );
    if (response.ok) {
      for (const item of (data?.data || [])) {
        if (!item?.id) continue;
        const p = await buscarDetalhe(item.id);
        if (p && getSkus(p).some(s => isExactCI(s, valorOriginal))) {
          return { ok: true, produto: p };
        }
      }
    }
    return { ok: false, erro: "Produto não encontrado" };
  }

  // ===== BUSCA POR EAN =====
  // 1. Tenta no índice de EAN (populado por buscas anteriores)
  const eanDigits = onlyDigits(valorOriginal);
  const idPorEan = indiceEan.get(eanDigits);
  if (idPorEan) {
    const p = await buscarDetalhe(idPorEan);
    if (p && getEans(p).some(e => isExactDigits(e, valorOriginal))) {
      console.log(`[EAN-HIT] ${valorOriginal} → ${p.codigo}`);
      return { ok: true, produto: p };
    }
  }

  // 2. Tenta parâmetros da API do Bling
  const urlsEan = [
    `https://api.bling.com.br/Api/v3/produtos?gtin=${encodeURIComponent(valorOriginal)}`,
    `https://api.bling.com.br/Api/v3/produtos?gtinTributario=${encodeURIComponent(valorOriginal)}`,
    `https://api.bling.com.br/Api/v3/produtos?ean=${encodeURIComponent(valorOriginal)}`,
    `https://api.bling.com.br/Api/v3/produtos?codigoBarras=${encodeURIComponent(valorOriginal)}`,
    `https://api.bling.com.br/Api/v3/produtos?codigo=${encodeURIComponent(valorOriginal)}`,
  ];
  for (const url of urlsEan) {
    const { response, data } = await blingFetchComRetry(url);
    if (!response.ok) continue;
    for (const item of (data?.data || [])) {
      if (!item?.id) continue;
      const p = await buscarDetalhe(item.id);
      if (p && getEans(p).some(e => isExactDigits(e, valorOriginal))) {
        console.log(`[EAN-API] ${valorOriginal} → ${p.codigo}`);
        return { ok: true, produto: p };
      }
    }
  }

  // 3. Busca nas variações — tenta buscar o produto pai pelo EAN da variação
  // Varre o índice de SKU buscando apenas produtos já em cache (sem novas requisições)
  console.log(`[EAN-CACHE] Varrendo ${cacheDetalhes.size} produtos em cache...`);
  for (const [, p] of cacheDetalhes) {
    if (getEans(p).some(e => isExactDigits(e, valorOriginal))) {
      console.log(`[EAN-CACHE] Encontrado em cache: ${p.codigo}`);
      indiceEan.set(eanDigits, String(p.id));
      return { ok: true, produto: p };
    }
  }

  return { ok: false, erro: "Produto não encontrado" };
}

// ================= BUSCAR =================
app.get("/buscar", async (req, res) => {
  try {
    const { key, tipo, codigo } = req.query;
    if (!key || key !== API_KEY) return res.status(401).json({ ok: false, erro: "API key inválida" });
    const tipoBusca = String(tipo || "").toUpperCase();
    if (!["SKU", "EAN"].includes(tipoBusca)) return res.json({ ok: false, erro: "Tipo inválido" });

    const resultado = await resolverProduto(tipoBusca, codigo);
    if (!resultado.ok || !resultado.produto) return res.json({ ok: false, erro: resultado.erro || "Produto não encontrado" });
    return res.json({ ok: true, produto: formatarProduto(resultado.produto) });
  } catch (e) {
    console.error("[/buscar] ERRO:", e.message);
    return res.json({ ok: false, erro: traduzirErroBling(e.message) });
  }
});

// ================= SALVAR =================
app.post("/salvar", async (req, res) => {
  try {
    const { key, codigo, tipo, novaLocalizacao } = req.body || {};
    if (!key || key !== API_KEY) return res.status(401).json({ ok: false, erro: "API key inválida" });
    const localizacaoFinal = String(novaLocalizacao ?? "");

    let resultado = null;
    if (tipo && String(tipo).toUpperCase() === "EAN") {
      resultado = await resolverProduto("EAN", codigo);
    } else {
      resultado = await resolverProduto("SKU", codigo);
      if (!resultado.ok) resultado = await resolverProduto("EAN", codigo);
    }

    if (!resultado.ok || !resultado.produto?.id) return res.json({ ok: false, erro: "Produto não encontrado" });

    const id = resultado.produto.id;
    const patch = await blingFetchComRetry(
      `https://api.bling.com.br/Api/v3/produtos/${id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ estoque: { localizacao: localizacaoFinal } }) }
    );
    if (!patch.response.ok) return res.json({ ok: false, erro: patch.data?.error?.description || "Erro ao salvar" });

    // Atualiza cache
    const pAtualizado = { ...resultado.produto, estoque: { ...(resultado.produto.estoque || {}), localizacao: localizacaoFinal } };
    cacheDetalhes.set(String(id), pAtualizado);

    return res.json({ ok: true, produto: { id, codigo: resultado.produto.codigo || "", nome: resultado.produto.nome || "", localizacao: localizacaoFinal } });
  } catch (e) {
    console.error("[/salvar] ERRO:", e.message);
    return res.json({ ok: false, erro: traduzirErroBling(e.message) });
  }
});

// ================= STATUS =================
app.get("/cache-status", (req, res) => {
  res.json({
    listagemCarregada,
    skusIndexados: indiceSku.size,
    eansIndexados: indiceEan.size,
    detalhesEmCache: cacheDetalhes.size
  });
});

app.get("/", (req, res) => { res.send("Servidor rodando"); });
app.get("/celular", (req, res) => { res.sendFile(path.join(__dirname, "public", "celular.html")); });

// ================= START =================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log("API_KEY:", !!process.env.API_KEY);
  console.log("BLING_ACCESS_TOKEN:", !!process.env.BLING_ACCESS_TOKEN);
  console.log("BLING_REFRESH_TOKEN:", !!process.env.BLING_REFRESH_TOKEN);

  // Carrega índice após 3s
  setTimeout(carregarIndiceListagem, 3000);
});
