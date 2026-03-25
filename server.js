const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY;
const BLING_ACCESS_TOKEN = process.env.BLING_ACCESS_TOKEN;

// =========================
// RENOVAR ACCESS TOKEN
// =========================
async function renovarAccessToken() {
  const clientId = process.env.BLING_CLIENT_ID;
  const clientSecret = process.env.BLING_CLIENT_SECRET;
  const refreshToken = process.env.BLING_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Faltam BLING_CLIENT_ID, BLING_CLIENT_SECRET ou BLING_REFRESH_TOKEN no Render.");
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams();
  body.append("grant_type", "refresh_token");
  body.append("refresh_token", refreshToken);

  const response = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "1.0",
      "enable-jwt": "1"
    },
    body: body.toString()
  });

  const data = await response.json();

  if (!response.ok) {
    console.log("Erro ao renovar token:", data);
    throw new Error("Erro ao renovar token");
  }

  console.log("NOVO ACCESS TOKEN:", data.access_token);
  console.log("NOVO REFRESH TOKEN:", data.refresh_token);

  return data;
}

// =========================
// CONSULTA BLING COM RETRY
// =========================
async function consultarBling(url, accessToken) {
  let response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  let data = await response.json();

  if (!response.ok && data?.error?.type === "invalid_token") {
    const novosTokens = await renovarAccessToken();
    accessToken = novosTokens.access_token;

    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });

    data = await response.json();
  }

  return { response, data, accessToken };
}

// =========================
// BUSCAR PRODUTO
// =========================
app.get("/buscar", async (req, res) => {
  try {
    const { key, tipo, codigo } = req.query;

    if (!key || key !== API_KEY) {
      return res.status(401).json({
        ok: false,
        erro: "Acesso negado. API key inválida."
      });
    }

    if (!tipo || !codigo) {
      return res.status(400).json({
        ok: false,
        erro: "Parâmetros tipo e codigo são obrigatórios."
      });
    }

    let urlBusca = "";

    if (tipo === "SKU") {
      urlBusca = `https://api.bling.com.br/Api/v3/produtos?codigo=${encodeURIComponent(codigo)}`;
    } else if (tipo === "EAN") {
      urlBusca = `https://api.bling.com.br/Api/v3/produtos?gtin=${encodeURIComponent(codigo)}`;
    } else {
      return res.status(400).json({
        ok: false,
        erro: "Tipo inválido. Use SKU ou EAN."
      });
    }

    let accessToken = process.env.BLING_ACCESS_TOKEN;

    const busca = await consultarBling(urlBusca, accessToken);
    accessToken = busca.accessToken;

    if (!busca.response.ok) {
      return res.status(busca.response.status).json({
        ok: false,
        erro: busca.data?.error?.description || busca.data?.message || "Erro ao consultar o Bling",
        retornoBling: busca.data
      });
    }

    if (!busca.data?.data || busca.data.data.length === 0) {
      return res.json({
        ok: false,
        erro: "Produto não encontrado"
      });
    }

    const produtoLista = busca.data.data[0];
    const id = produtoLista.id;

    const detalhe = await consultarBling(`https://api.bling.com.br/Api/v3/produtos/${id}`, accessToken);

    if (!detalhe.response.ok) {
      return res.status(detalhe.response.status).json({
        ok: false,
        erro: detalhe.data?.error?.description || detalhe.data?.message || "Erro ao consultar detalhe do produto",
        retornoBling: detalhe.data
      });
    }

    const produto = detalhe.data?.data || produtoLista;

    return res.json({
      ok: true,
      produto: {
        id: produto.id || produtoLista.id || null,
        nome: produto.nome || produto.descricao || produtoLista.nome || produtoLista.descricao || "",
        codigo: produto.codigo || produtoLista.codigo || "",
        localizacao: produto.localizacao || produtoLista.localizacao || "",
        estoque: produto.estoque?.saldoVirtualTotal || produtoLista.estoque?.saldoVirtualTotal || 0,
        imagem: produto.imagemURL || produtoLista.imagemURL || ""
      }
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      erro: error.message
    });
  }
});

// =========================
// SALVAR NOVA LOCALIZAÇÃO
// =========================
app.post("/salvar", async (req, res) => {
  try {
    const { key, codigo, novaLocalizacao } = req.body;

    if (!key || key !== API_KEY) {
      return res.status(401).json({
        ok: false,
        erro: "Acesso negado. API key inválida."
      });
    }

    if (!codigo || !novaLocalizacao) {
      return res.status(400).json({
        ok: false,
        erro: "Código e nova localização são obrigatórios."
      });
    }

    let accessToken = BLING_ACCESS_TOKEN;

    // 1. Buscar produto pelo código
    let busca = await consultarBling(
      `https://api.bling.com.br/Api/v3/produtos?codigo=${encodeURIComponent(codigo)}`,
      accessToken
    );

    if (!busca.data?.data?.length) {
      return res.status(404).json({
        ok: false,
        erro: "Produto não encontrado."
      });
    }

    const id = busca.data.data[0].id;

    // 2. Buscar detalhe completo do produto
    let detalhe = await consultarBling(
      `https://api.bling.com.br/Api/v3/produtos/${id}`,
      accessToken
    );

    if (!detalhe.data?.data) {
      return res.status(404).json({
        ok: false,
        erro: "Erro ao buscar detalhe do produto."
      });
    }

    let produtoCompleto = detalhe.data.data;

    // 3. Alterar apenas a localização
    produtoCompleto.localizacao = novaLocalizacao;

    // 4. Enviar PUT com o objeto completo
    let putResp = await fetch(`https://api.bling.com.br/Api/v3/produtos/${id}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(produtoCompleto)
    });

    let putData = await putResp.json();

    if (!putResp.ok) {
      return res.status(putResp.status).json({
        ok: false,
        erro: "Erro ao salvar localização",
        retornoBling: putData
      });
    }

    return res.json({
      ok: true,
      mensagem: "Localização salva com sucesso."
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      erro: error.message
    });
  }
});
