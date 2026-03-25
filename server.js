const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY; // chave da sua extensão
const BLING_ACCESS_TOKEN = process.env.BLING_ACCESS_TOKEN; // token do Bling

app.get("/", (req, res) => {
  res.send("API Bling rodando!");
});

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

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${BLING_ACCESS_TOKEN}`,
        Accept: "application/json"
      }
    });

    const data = await response.json();

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

    res.json({
      ok: true,
      descricao: produto.descricao || "",
      codigo: produto.codigo || "",
      localizacao: produto.localizacao || "",
      saldo: produto.estoque?.saldoVirtualTotal || 0,
      raw: produto
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      erro: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
