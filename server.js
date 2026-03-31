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

// ================= CACHE =================
const cache = {
  produtos: new Map(), // id -> produto completo
  porSku: new Map(),   // sku_lower -> id
  porEan: new Map(),   // ean_digits -> id
  carregado: false,
  carregando: false,
  totalProdutos: 0,
  ultimaSync: null
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  } catch (e) {
    console.error("[RENDER] Erro:", e.message);
    return false;
  }
}

// ================= HELPERS =================
function traduzirErroBling(msg) {
  const texto = String(msg || "").toLowerCase().trim();
  if (texto.includes("invalid refresh token")) return "Token de atualização do Bling inválido. Verifique BLING_REFRESH_TOKEN no Render.";
  if (texto.includes("invalid_token")) return "Token de acesso do Bling inválido ou expirado.";
  if (texto.includes("unauthorized")) return "Não autorizado no Bling.";
  return "Erro de comunicação com o Bling.";
}

let usuarios = [];
try { usuarios = JSON.parse(fs.readFileSync("./usuarios.json", "utf8")); } catch (e) { usuarios = []; }

function normalize(v) { return String(v || "").trim().toLowerCase(); }
function onlyDigits(v) { return String(v || "").replace(/\D/g, ""); }
function isExactCaseInsensitive(a, b) { return normalize(a) === normalize(b); }
function isExactDigits(a, b) { const aa = onlyDigits(a); const bb = onlyDigits(b); return aa && bb && aa === bb; }

function extractImage(produto) {
  const vistos = new Set();
  function procurar(obj) {
    if (!obj) return "";
    if (typeof obj === "string") {
      const valor = obj.trim();
      if (!valor) return "";
      const ehImagem = /^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(valor);
      const ehGoogle = /^https?:\/\/lh3\.googleusercontent\.com\//i.test(valor);
      if (ehImagem || ehGoogle) return valor;
      return "";
    }
    if (typeof obj !== "object") return "";
    if (vistos.has(obj)) return "";
    vistos.add(obj);
    if (Array.isArray(obj)) { for (const item of obj) { const a = procurar(item); if (a) return a; } return ""; }
    for (const chave of Object.keys(obj)) { const a = procurar(obj[chave]); if (a) return a; }
    return "";
  }
  return procurar(produto) || "";
}

function extractLocalizacao(p) {
  return p?.estoque?.localizacao || p?.localizacao || p?.depositos?.[0]?.localizacao || p?.deposito?.localizacao || "";
}

function extractEstoque(p) {
  return p?.estoque?.saldoVirtualTotal ?? p?.estoque?.saldoVirtual ?? p?.saldoVirtualTotal ?? p?.saldoVirtual ?? 0;
}

function getPossiveisSkus(obj) {
  return [obj?.codigo, obj?.sku, obj?.codigoProduto].filter(Boolean);
}

function getPossiveisEans(obj) {
  return [
    obj?.gtin, obj?.ean, obj?.codigoBarras, obj?.gtinEan, obj?.gtinTributario,
    obj?.codigo_barras, obj?.codigoDeBarras, obj?.codBarras, obj?.codigobarras,
    obj?.gtinEanTributario, obj?.eanTributario,
    obj?.tributavel?.gtin, obj?.tributavel?.ean,
    obj?.tributacao?.gtin, obj?.tributacao?.ean
  ].filter(Boolean);
}

function formatarProduto(p) {
  return {
    id: p.id,
    nome: p.nome || "",
    codigo: p.codigo || p.sku || "",
    estoque: extractEstoque(p),
    localizacao: extractLocalizacao(p),
    imagem: extractImage(p),
    ean: getPossiveisEans(p).find(Boolean) || ""
  };
}

// ================= LOGIN =================
app.post("/login", (req, res) => {
  try {
    const { usuario, senha } = req.body || {};
    const user = usuarios.find(u => u.usuario === usuario && u.senha === senha);
    if (user) return res.json({ sucesso: true, perfil: user.perfil, usuario: user.usuario });
    return res.status(401).json({ sucesso: false, mensagem: "Usuário ou senha inválidos" });
  } catch (e) {
    return res.status(500).json({ sucesso: false, mensagem: e.message });
  }
});

// ================= TOKEN BLING =================
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
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "1.0", "enable-jwt": "1" },
    body: body.toString()
  });

  let data = {};
  try { data = await response.json(); } catch { data = {}; }

  if (!response.ok || !data?.access_token) {
    const msg = data?.error?.description || data?.error?.type || "Falha ao renovar token";
    throw new Error(traduzirErroBling(msg));
  }

  process.env.BLING_ACCESS_TOKEN = data.access_token;
  if (data.refresh_token) process.env.BLING_REFRESH_TOKEN = data.refresh_token;

  await atualizarVariavelRender("BLING_ACCESS_TOKEN", data.access_token);
  if (data.refresh_token) await atualizarVariavelRender("BLING_REFRESH_TOKEN", data.refresh_token);

  console.log("[TOKEN] Renovado e salvo no Render!");
  return data;
}

async function blingFetch(url, options = {}, token = process.env.BLING_ACCESS_TOKEN) {
  async function doFetch(t) {
    const r = await fetch(url, { ...options, headers: { Authorization: `Bearer ${t}`, Accept: "application/json", ...(options.headers || {}) } });
    let d = {};
    try { d = await r.json(); } catch { d = {}; }
    return { response: r, data: d };
  }

  let { response, data } = await doFetch(token);

  const invalido = response.status === 401 || /invalid_token/i.test(JSON.stringify(data || {}));
  if (invalido) {
    console.log("[BLING] Token inválido. Renovando...");
    const novos = await renovarAccessToken();
    token = novos.access_token;
    const segunda = await doFetch(token);
    response = segunda.response;
    data = segunda.data;
  }

  return { response, data, token };
}

// ================= CACHE: CARREGAR TODOS OS PRODUTOS =================
async function carregarTodosOsProdutos() {
  if (cache.carregando) return;
  cache.carregando = true;
  console.log("[CACHE] Iniciando carregamento de todos os produtos...");

  let pagina = 1;
  let total = 0;
  const novosMap = new Map();
  const novoSku = new Map();
  const novoEan = new Map();

  try {
    while (true) {
      const url = `https://api.bling.com.br/Api/v3/produtos?pagina=${pagina}&limite=100&criterio=1`;
      const { response, data } = await blingFetch(url);

      if (response.status === 429) {
        console.warn(`[CACHE] Rate limit na página ${pagina}. Aguardando 3s...`);
        await sleep(3000);
        continue; // tenta a mesma página novamente
      }
      if (response.status === 429) {
        console.warn(`[CACHE] Rate limit na página ${pagina}. Aguardando 3s...`);
        await sleep(3000);
        continue; // tenta a mesma página novamente
      }
      if (!response.ok) {
        console.warn(`[CACHE] Erro na página ${pagina}:`, response.status);
        break;
      }

      const lista = data?.data || [];
      if (!lista.length) break;

      // Busca detalhes de cada produto em paralelo (lotes de 5)
      for (let i = 0; i < lista.length; i += 5) {
        const lote = lista.slice(i, i + 5);
        await Promise.all(lote.map(async (item) => {
          if (!item?.id) return;
          try {
            await sleep(300);
            const det = await blingFetch(`https://api.bling.com.br/Api/v3/produtos/${item.id}`);
            if (!det.response.ok) return;
            const p = det.data?.data;
            if (!p) return;

            novosMap.set(String(p.id), p);

            // Indexa por SKU
            getPossiveisSkus(p).forEach(s => {
              if (s) novoSku.set(normalize(s), String(p.id));
            });

            // Indexa por EAN
            getPossiveisEans(p).forEach(e => {
              const d = onlyDigits(e);
              if (d && d.length >= 8) novoEan.set(d, String(p.id));
            });

            total++;
          } catch (e) { /* ignora erros individuais */ }
        }));
      }

      console.log(`[CACHE] Página ${pagina} processada. Total até agora: ${total}`);

      if (lista.length < 100) break;
      pagina++;
      await sleep(1000);
    }

    // Atualiza cache atomicamente
    cache.produtos = novosMap;
    cache.porSku = novoSku;
    cache.porEan = novoEan;
    cache.carregado = true;
    cache.totalProdutos = total;
    cache.ultimaSync = new Date();
    console.log(`[CACHE] ✅ Carregamento completo! ${total} produtos indexados.`);

  } catch (e) {
    console.error("[CACHE] Erro ao carregar:", e.message);
  } finally {
    cache.carregando = false;
  }
}

// Sync incremental a cada 5 minutos — pega produtos novos/alterados
async function syncIncremental() {
  try {
    console.log("[CACHE] Sync incremental...");
    const url = `https://api.bling.com.br/Api/v3/produtos?pagina=1&limite=100&criterio=5`; // criterio=5 = mais recentes
    const { response, data } = await blingFetch(url);
    if (!response.ok) return;

    const lista = data?.data || [];
    let atualizados = 0;

    for (const item of lista) {
      if (!item?.id) continue;
      try {
        await sleep(150);
        const det = await blingFetch(`https://api.bling.com.br/Api/v3/produtos/${item.id}`);
        if (!det.response.ok) continue;
        const p = det.data?.data;
        if (!p) continue;

        cache.produtos.set(String(p.id), p);
        getPossiveisSkus(p).forEach(s => { if (s) cache.porSku.set(normalize(s), String(p.id)); });
        getPossiveisEans(p).forEach(e => { const d = onlyDigits(e); if (d && d.length >= 8) cache.porEan.set(d, String(p.id)); });
        atualizados++;
      } catch (e) { /* ignora */ }
    }

    cache.ultimaSync = new Date();
    console.log(`[CACHE] Sync incremental: ${atualizados} produtos atualizados.`);
  } catch (e) {
    console.error("[CACHE] Erro no sync:", e.message);
  }
}

// ================= BUSCA NO CACHE =================
function buscarNoCachePorSku(valor) {
  const id = cache.porSku.get(normalize(valor));
  if (!id) return null;
  return cache.produtos.get(id) || null;
}

function buscarNoCachePorEan(valor) {
  const id = cache.porEan.get(onlyDigits(valor));
  if (!id) return null;
  return cache.produtos.get(id) || null;
}

// Fallback: busca direto na API quando não achar no cache
async function buscarNaApiDireta(tipo, valor) {
  console.log(`[API-DIRETA] Buscando ${tipo}: ${valor}`);
  const urls = tipo === "SKU"
    ? [`https://api.bling.com.br/Api/v3/produtos?codigo=${encodeURIComponent(valor)}`]
    : [
        `https://api.bling.com.br/Api/v3/produtos?gtin=${encodeURIComponent(valor)}`,
        `https://api.bling.com.br/Api/v3/produtos?gtinTributario=${encodeURIComponent(valor)}`,
        `https://api.bling.com.br/Api/v3/produtos?ean=${encodeURIComponent(valor)}`
      ];

  for (const url of urls) {
    const { response, data } = await blingFetch(url);
    if (!response.ok) continue;
    const lista = data?.data || [];
    for (const item of lista) {
      if (!item?.id) continue;
      await sleep(200);
      const det = await blingFetch(`https://api.bling.com.br/Api/v3/produtos/${item.id}`);
      if (!det.response.ok) continue;
      const p = det.data?.data;
      if (!p) continue;

      const encontrou = tipo === "SKU"
        ? getPossiveisSkus(p).some(s => isExactCaseInsensitive(s, valor))
        : getPossiveisEans(p).some(e => isExactDigits(e, valor));

      if (encontrou) {
        // Adiciona ao cache para próximas buscas
        cache.produtos.set(String(p.id), p);
        getPossiveisSkus(p).forEach(s => { if (s) cache.porSku.set(normalize(s), String(p.id)); });
        getPossiveisEans(p).forEach(e => { const d = onlyDigits(e); if (d && d.length >= 8) cache.porEan.set(d, String(p.id)); });
        console.log(`[API-DIRETA] Encontrado e adicionado ao cache: ${p.codigo}`);
        return p;
      }
    }
  }
  return null;
}

// ================= RESOLVER PRODUTO =================
async function resolverProduto(tipo, valor) {
  const tipoBusca = String(tipo || "").toUpperCase();
  const valorOriginal = String(valor || "").trim();

  if (!valorOriginal) return { ok: false, erro: "Código não informado" };

  // 1. Busca no cache primeiro (instantâneo)
  let produto = null;
  if (cache.carregado) {
    produto = tipoBusca === "SKU"
      ? buscarNoCachePorSku(valorOriginal)
      : buscarNoCachePorEan(valorOriginal);

    if (produto) {
      console.log(`[CACHE-HIT] ${tipoBusca} ${valorOriginal} → ${produto.codigo}`);
      return { ok: true, produto };
    }

    // Cache-miss — tenta busca profunda no cache varrendo todos os campos
    console.log(`[CACHE-MISS] ${tipoBusca} ${valorOriginal} — buscando em todos os campos do cache...`);
    
    if (tipoBusca === "EAN") {
      const eanDigits = onlyDigits(valorOriginal);
      for (const [id, p] of cache.produtos) {
        const eansDoP = getPossiveisEans(p);
        if (eansDoP.some(e => isExactDigits(e, valorOriginal))) {
          // Achou! Indexa para próximas buscas
          cache.porEan.set(eanDigits, id);
          console.log(`[CACHE-DEEP] EAN ${valorOriginal} encontrado em ${p.codigo}`);
          return { ok: true, produto: p };
        }
      }
    }

    console.log(`[CACHE-MISS] ${tipoBusca} ${valorOriginal} — não encontrado.`);
    return { ok: false, erro: "Produto não encontrado" };
  }

  // Cache ainda carregando — fallback direto na API
  console.log(`[CACHE] Ainda carregando — buscando direto na API...`);
  produto = await buscarNaApiDireta(tipoBusca, valorOriginal);
  if (produto) return { ok: true, produto };

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
    const patch = await blingFetch(
      `https://api.bling.com.br/Api/v3/produtos/${id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ estoque: { localizacao: localizacaoFinal } }) }
    );

    if (!patch.response.ok) return res.json({ ok: false, erro: patch.data?.error?.description || "Erro ao salvar" });

    // Atualiza o cache na hora
    const pAtualizado = { ...resultado.produto, estoque: { ...(resultado.produto.estoque || {}), localizacao: localizacaoFinal } };
    cache.produtos.set(String(id), pAtualizado);
    console.log(`[CACHE] Localização atualizada no cache: ${resultado.produto.codigo} → "${localizacaoFinal}"`);

    return res.json({ ok: true, produto: { id, codigo: resultado.produto.codigo || "", nome: resultado.produto.nome || "", localizacao: localizacaoFinal } });
  } catch (e) {
    console.error("[/salvar] ERRO:", e.message);
    return res.json({ ok: false, erro: traduzirErroBling(e.message) });
  }
});

// ================= STATUS DO CACHE =================
app.get("/cache-status", (req, res) => {
  res.json({
    carregado: cache.carregado,
    carregando: cache.carregando,
    totalProdutos: cache.totalProdutos,
    ultimaSync: cache.ultimaSync,
    skusIndexados: cache.porSku.size,
    eansIndexados: cache.porEan.size
  });
});

// ================= HEALTH =================
app.get("/", (req, res) => { res.send("Servidor rodando"); });
app.get("/celular", (req, res) => { res.sendFile(path.join(__dirname, "public", "celular.html")); });

// ================= START =================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log("API_KEY:", !!process.env.API_KEY);
  console.log("BLING_ACCESS_TOKEN:", !!process.env.BLING_ACCESS_TOKEN);
  console.log("BLING_REFRESH_TOKEN:", !!process.env.BLING_REFRESH_TOKEN);
  console.log("RENDER_API_KEY:", !!RENDER_API_KEY);

  // Carrega cache após 3s (deixa o servidor subir primeiro)
  setTimeout(() => {
    carregarTodosOsProdutos().then(() => {
      // Sync incremental a cada 5 minutos
      setInterval(syncIncremental, 5 * 60 * 1000);
    });
  }, 3000);
});
