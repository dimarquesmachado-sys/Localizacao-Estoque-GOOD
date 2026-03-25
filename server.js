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
function traduzirErroBling(msg) {
  const texto = String(msg || "").toLowerCase().trim();

  if (texto.includes("invalid refresh token")) {
    return "Token de atualização do Bling inválido. Verifique BLING_REFRESH_TOKEN, BLING_CLIENT_ID e BLING_CLIENT_SECRET no Render.";
  }

  if (texto.includes("invalid_token")) {
    return "Token de acesso do Bling inválido ou expirado.";
  }

  if (texto.includes("unauthorized")) {
    return "Não autorizado no Bling.";
  }

  if (texto.includes("forbidden")) {
    return "Acesso negado no Bling.";
  }

  return "Erro de comunicação com o Bling.";
}

let usuarios = [];
try {
  usuarios = JSON.parse(fs.readFileSync("./usuarios.json", "utf8"));
} catch (e) {
  console.error("Erro ao ler usuarios.json:", e.message);
  usuarios = [];
}

// ================= HELPERS =================
function normalize(v) {
  return String(v || "").trim().toLowerCase();
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function isExactCaseInsensitive(a, b) {
  return normalize(a) === normalize(b);
}

function isExactDigits(a, b) {
  const aa = onlyDigits(a);
  const bb = onlyDigits(b);
  return aa && bb && aa === bb;
}

function extractImage(produto) {
  const vistos = new Set();

  function procurar(obj) {
    if (!obj) return "";

    if (typeof obj === "string") {
      const valor = obj.trim();

      if (!valor) return "";

      const ehImagemDireta =
        /^https?:\/\/.+\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(valor);

      const ehGoogleImage =
        /^https?:\/\/lh3\.googleusercontent\.com\//i.test(valor);

      if (ehImagemDireta || ehGoogleImage) {
        return valor;
      }

      return "";
    }

    if (typeof obj !== "object") return "";

    if (vistos.has(obj)) return "";
    vistos.add(obj);

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const achou = procurar(item);
        if (achou) return achou;
      }
      return "";
    }

    for (const chave of Object.keys(obj)) {
      const achou = procurar(obj[chave]);
      if (achou) return achou;
    }

    return "";
  }

  return procurar(produto) || "";
}

function extractLocalizacao(produto) {
  return (
    produto?.estoque?.localizacao ||
    produto?.localizacao ||
    produto?.depositos?.[0]?.localizacao ||
    produto?.deposito?.localizacao ||
    ""
  );
}

function extractEstoque(produto) {
  return (
    produto?.estoque?.saldoVirtualTotal ??
    produto?.estoque?.saldoVirtual ??
    produto?.saldoVirtualTotal ??
    produto?.saldoVirtual ??
    0
  );
}

function getPossiveisCodigosSku(obj) {
  return [
    obj?.codigo,
    obj?.sku,
    obj?.codigoProduto,
    obj?.codigoPai
  ].filter(Boolean);
}

function getPossiveisGtins(obj) {
  return [
    obj?.gtin,
    obj?.ean,
    obj?.codigoBarras,
    obj?.gtinEan,
    obj?.gtinTributario,
    obj?.codigo_barras,
    obj?.codigoDeBarras,
    obj?.codigo_barra,
    obj?.codBarras,
    obj?.codigobarras,
    obj?.codigoBarrasTributario,
    obj?.gtin_embalagem,
    obj?.gtinEmbalagem,
    obj?.tributavel?.gtin,
    obj?.tributavel?.ean,
    obj?.tributacao?.gtin,
    obj?.tributacao?.ean
  ].filter(Boolean);
}

// ================= LOGIN =================
app.post("/login", (req, res) => {
  try {
    const { usuario, senha } = req.body || {};

    const user = usuarios.find(
      (u) => u.usuario === usuario && u.senha === senha
    );

    if (user) {
      return res.json({
        sucesso: true,
        perfil: user.perfil,
        usuario: user.usuario
      });
    }

    return res
      .status(401)
      .json({ sucesso: false, mensagem: "Usuário ou senha inválidos" });
  } catch (error) {
    return res
      .status(500)
      .json({ sucesso: false, mensagem: error.message });
  }
});

// ================= TOKEN BLING =================
async function renovarAccessToken() {
  const clientId = process.env.BLING_CLIENT_ID;
  const clientSecret = process.env.BLING_CLIENT_SECRET;
  const refreshToken = process.env.BLING_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Credenciais OAuth do Bling ausentes no Render.");
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams();
  body.append("grant_type", "refresh_token");
  body.append("refresh_token", String(refreshToken).trim());

  const response = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "1.0",
      "enable-jwt": "1"
    },
    body: body.toString()
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok || !data?.access_token) {
    const msg =
      data?.error?.description ||
      data?.error?.type ||
      data?.message ||
      "Falha ao renovar token";
    throw new Error(traduzirErroBling(msg));
  }

  return data;
}

async function blingRequest(url, options = {}, accessToken = process.env.BLING_ACCESS_TOKEN) {
  let token = accessToken;

  async function doFetch(currentToken) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${currentToken}`,
        Accept: "application/json",
        ...(options.headers || {})
      }
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    return { response, data };
  }

  let { response, data } = await doFetch(token);

  const tokenInvalido =
    response.status === 401 ||
    data?.error?.type === "invalid_token" ||
    /invalid_token/i.test(JSON.stringify(data || {}));

  if (tokenInvalido) {
    const novosTokens = await renovarAccessToken();
    token = novosTokens.access_token;

    const segunda = await doFetch(token);
    response = segunda.response;
    data = segunda.data;
  }

  return { response, data, accessToken: token };
}

// ================= BLING HELPERS =================
async function listarProdutosPorUrl(url, accessTokenAtual) {
  const tentativa = await blingRequest(url, {}, accessTokenAtual);
  return tentativa;
}

async function buscarDetalheProduto(id, accessTokenAtual) {
  const detalhe = await blingRequest(
    `https://api.bling.com.br/Api/v3/produtos/${id}`,
    {},
    accessTokenAtual
  );

  if (!detalhe.response.ok) return null;

  return {
    produto: detalhe.data?.data || null,
    accessToken: detalhe.accessToken
  };
}

function matchSkuExato(produto, valorDigitado) {
  const candidatos = getPossiveisCodigosSku(produto);
  return candidatos.some((c) => isExactCaseInsensitive(c, valorDigitado));
}

function matchEanExato(produto, valorDigitado) {
  const candidatos = getPossiveisGtins(produto);
  return candidatos.some((c) => isExactDigits(c, valorDigitado));
}

async function resolverProduto(tipo, valor) {
  const tipoBusca = String(tipo || "").toUpperCase();
  const valorOriginal = String(valor || "").trim();

  let accessTokenAtual = process.env.BLING_ACCESS_TOKEN;

  if (!valorOriginal) {
    return { ok: false, erro: "Código não informado" };
  }

  const urlsBusca =
    tipoBusca === "SKU"
      ? [
          `https://api.bling.com.br/Api/v3/produtos?codigo=${encodeURIComponent(valorOriginal)}`,
          `https://api.bling.com.br/Api/v3/produtos?sku=${encodeURIComponent(valorOriginal)}`
        ]
      : [
          `https://api.bling.com.br/Api/v3/produtos?gtin=${encodeURIComponent(valorOriginal)}`,
          `https://api.bling.com.br/Api/v3/produtos?ean=${encodeURIComponent(valorOriginal)}`,
          `https://api.bling.com.br/Api/v3/produtos?codigoBarras=${encodeURIComponent(valorOriginal)}`
        ];

  const idsJaTentados = new Set();

  for (const url of urlsBusca) {
    const tentativa = await listarProdutosPorUrl(url, accessTokenAtual);
    accessTokenAtual = tentativa.accessToken;

    if (!tentativa.response.ok) continue;

    const lista = tentativa.data?.data || [];
    if (!lista.length) continue;

    if (tipoBusca === "SKU") {
      const candidatosExatos = lista.filter((item) => {
        if (!item?.id || idsJaTentados.has(item.id)) return false;
        return matchSkuExato(item, valorOriginal);
      });

      for (const item of candidatosExatos) {
        idsJaTentados.add(item.id);

        const detalhe = await buscarDetalheProduto(item.id, accessTokenAtual);
        if (!detalhe?.produto) continue;

        accessTokenAtual = detalhe.accessToken;
        const p = detalhe.produto;

        if (matchSkuExato(p, valorOriginal)) {
          return {
            ok: true,
            produto: p,
            accessToken: accessTokenAtual
          };
        }
      }
    } else {
      const candidatos = lista
        .filter((item) => item?.id && !idsJaTentados.has(item.id))
        .slice(0, 15);

      for (const item of candidatos) {
        idsJaTentados.add(item.id);

        const detalhe = await buscarDetalheProduto(item.id, accessTokenAtual);
        if (!detalhe?.produto) continue;

        accessTokenAtual = detalhe.accessToken;
        const p = detalhe.produto;

        if (matchEanExato(p, valorOriginal)) {
          return {
            ok: true,
            produto: p,
            accessToken: accessTokenAtual
          };
        }
      }
    }
  }

  return { ok: false, erro: "Produto não encontrado" };
}

// ================= BUSCAR =================
app.get("/buscar", async (req, res) => {
  try {
    const { key, tipo, codigo } = req.query;

    if (!key || key !== API_KEY) {
      return res.status(401).json({ ok: false, erro: "API key inválida" });
    }

    const tipoBusca = String(tipo || "").toUpperCase();
    if (!["SKU", "EAN"].includes(tipoBusca)) {
      return res.json({ ok: false, erro: "Tipo de busca inválido" });
    }

    const resultado = await resolverProduto(tipoBusca, codigo);

    if (!resultado.ok || !resultado.produto) {
      return res.json({ ok: false, erro: resultado.erro || "Produto não encontrado" });
    }

    const p = resultado.produto;

    return res.json({
  ok: true,
  produto: {
    id: p.id,
    nome: p.nome || "",
    codigo: p.codigo || p.sku || "",
    estoque: extractEstoque(p),
    localizacao: extractLocalizacao(p),
    imagem: extractImage(p),
    ean: getPossiveisGtins(p).find(Boolean) || ""
  },
  debug: {
    id: p?.id || null,
    codigo: p?.codigo || p?.sku || null,
    gtin: p?.gtin || null,
    ean: p?.ean || null,
    codigoBarras: p?.codigoBarras || null,
    gtinEan: p?.gtinEan || null,
    gtinTributario: p?.gtinTributario || null,
    codigo_barras: p?.codigo_barras || null,
    imagemURL: p?.imagemURL || null,
    imagemUrl: p?.imagemUrl || null,
    imagem: p?.imagem || null,
    linkImagem: p?.linkImagem || null,
    urlImagem: p?.urlImagem || null,
    imagensExternas: p?.imagensExternas || null,
    imagens: p?.imagens || null,
    midia: p?.midia || null,
    anexos: p?.anexos || null
  }
});
  } catch (error) {
    return res.json({
  ok: false,
  erro: traduzirErroBling(error.message)
});
  }
});

// ================= SALVAR =================
app.post("/salvar", async (req, res) => {
  try {
    const { key, codigo, tipo, novaLocalizacao } = req.body || {};

    if (!key || key !== API_KEY) {
      return res.status(401).json({ ok: false, erro: "API key inválida" });
    }

    if (!String(novaLocalizacao || "").trim()) {
      return res.json({ ok: false, erro: "Nova localização não informada" });
    }

    let resultado = null;

    if (tipo && String(tipo).toUpperCase() === "EAN") {
      resultado = await resolverProduto("EAN", codigo);
    } else {
      resultado = await resolverProduto("SKU", codigo);
      if (!resultado.ok) {
        resultado = await resolverProduto("EAN", codigo);
      }
    }

    if (!resultado.ok || !resultado.produto?.id) {
      return res.json({ ok: false, erro: "Produto não encontrado para salvar" });
    }

    const id = resultado.produto.id;

    const patch = await blingRequest(
      `https://api.bling.com.br/Api/v3/produtos/${id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          estoque: {
            localizacao: String(novaLocalizacao).trim()
          }
        })
      },
      resultado.accessToken
    );

    if (!patch.response.ok) {
      return res.json({
        ok: false,
        erro:
          patch.data?.error?.description ||
          patch.data?.error?.type ||
          "Erro ao salvar"
      });
    }

    return res.json({
      ok: true,
      produto: {
        id,
        codigo: resultado.produto.codigo || "",
        nome: resultado.produto.nome || "",
        localizacao: String(novaLocalizacao).trim()
      }
    });
  } catch (error) {
    return res.json({
  ok: false,
  erro: traduzirErroBling(error.message)
});
  }
});

// ================= HEALTH =================
app.get("/", (req, res) => {
  res.send("Servidor rodando");
});

app.get("/celular", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "celular.html"));
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
