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
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  const data = await response.json();
  return { response, data };
}

// =========================
// HOME
// =========================
app.get("/", (req, res) => {
  res.send("API Bling rodando!");
});

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

    let url = "";

    if (tipo === "SKU") {
      url = `https://api.bling.com.br/Api/v3/produtos?codigo=${encodeURIComponent(codigo)}`;
    } else if (tipo === "EAN") {
      url = `https://api.bling.com.br/Api/v3/produtos?gtin=${encodeURIComponent(codigo)}`;
    } else {
      return res.status(400).json({
        ok: false,
        erro: "Tipo inválido. Use SKU ou EAN."
      });
    }

    let accessToken = BLING_ACCESS_TOKEN;

    let { response, data } = await consultarBling(url, accessToken);

    if (!response.ok && data?.error?.type === "invalid_token") {
      const novosTokens = await renovarAccessToken();
      accessToken = novosTokens.access_token;
      ({ response, data } = await consultarBling(url, accessToken));
    }

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        erro: data?.error?.description || data?.message || "Erro ao consultar o Bling",
        retornoBling: data
      });
    }

    if (!data.data || data.data.length === 0) {
      return res.json({
        ok: false,
        erro: "Produto não encontrado"
      });
    }

    const produto = data.data[0];

    return res.json({
      ok: true,
      produto: {
        id: produto.id || null,
        nome: produto.nome || produto.descricao || "",
        codigo: produto.codigo || "",
        localizacao: produto.localizacao || "",
        estoque: produto.estoque?.saldoVirtualTotal || 0,
        imagem: produto.imagemURL || ""
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

    // 1. Busca o produto pelo código
    let buscaResp = await fetch(
      `https://api.bling.com.br/Api/v3/produtos?codigo=${encodeURIComponent(codigo)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      }
    );

    let buscaData = await buscaResp.json();

    if (!buscaResp.ok && buscaData?.error?.type === "invalid_token") {
      const novosTokens = await renovarAccessToken();
      accessToken = novosTokens.access_token;

      buscaResp = await fetch(
        `https://api.bling.com.br/Api/v3/produtos?codigo=${encodeURIComponent(codigo)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json"
          }
        }
      );

      buscaData = await buscaResp.json();
    }

    if (!buscaResp.ok || !buscaData?.data?.length) {
      return res.status(404).json({
        ok: false,
        erro: "Produto não encontrado para salvar localização.",
        retornoBling: buscaData
      });
    }

    const produto = buscaData.data[0];
    const id = produto.id;

    // 2. Atualiza localização
    // Observação:
    // alguns campos são mantidos para evitar rejeição do PUT
    const body = {
      nome: produto.nome || produto.descricao || "",
      codigo: produto.codigo || codigo,
      tipo: produto.tipo || "P",
      situacao: produto.situacao || "A",
      formato: produto.formato || "S",
      descricaoCurta: produto.descricaoCurta || "",
      preco: produto.preco || 0,
      localizacao: novaLocalizacao
    };

    let putResp = await fetch(`https://api.bling.com.br/Api/v3/produtos/${id}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    let putData = await putResp.json();

    if (!putResp.ok && putData?.error?.type === "invalid_token") {
      const novosTokens = await renovarAccessToken();
      accessToken = novosTokens.access_token;

      putResp = await fetch(`https://api.bling.com.br/Api/v3/produtos/${id}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      putData = await putResp.json();
    }

    if (!putResp.ok) {
      return res.status(putResp.status).json({
        ok: false,
        erro: "Erro ao salvar localização no Bling.",
        retornoBling: putData
      });
    }

    return res.json({
      ok: true,
      mensagem: "Localização atualizada com sucesso.",
      retornoBling: putData
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      erro: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
