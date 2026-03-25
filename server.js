require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const BLING_API = 'https://www.bling.com.br/Api/v3';
const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';

const API_KEY = process.env.API_KEY || '';
const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || '';
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || '';
const BLING_REFRESH_TOKEN = process.env.BLING_REFRESH_TOKEN || '';
const BLING_REDIRECT_URI = process.env.BLING_REDIRECT_URI || '';

if (!API_KEY || !BLING_CLIENT_ID || !BLING_CLIENT_SECRET || !BLING_REFRESH_TOKEN) {
  console.warn('ATENÇÃO: faltam variáveis obrigatórias no ambiente. Veja o README.md');
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ limit: '1mb', type: 'text/plain' }));

const state = {
  accessToken: null,
  accessTokenExpiresAt: 0,
  refreshToken: BLING_REFRESH_TOKEN
};

function normalizeText(value) {
  return String(value || '').trim().toUpperCase();
}

function firstFilled(...args) {
  for (const value of args) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, erro: message, ...extra });
}

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key') || req.query.key || req.body?.key || '';
  if (!API_KEY || key !== API_KEY) {
    return jsonError(res, 401, 'Acesso negado. API key inválida.');
  }
  next();
}

async function refreshAccessToken() {
  const basic = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');

  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', state.refreshToken);
  if (BLING_REDIRECT_URI) {
    params.set('redirect_uri', BLING_REDIRECT_URI);
  }

  const response = await axios.post(BLING_TOKEN_URL, params.toString(), {
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    timeout: 30000
  });

  const data = response.data || {};
  if (!data.access_token) {
    throw new Error(`Falha ao renovar token do Bling: ${JSON.stringify(data)}`);
  }

  state.accessToken = data.access_token;
  state.refreshToken = data.refresh_token || state.refreshToken;
  const expiresIn = Number(data.expires_in || 3600);
  state.accessTokenExpiresAt = Date.now() + Math.max(60, expiresIn - 120) * 1000;

  return state.accessToken;
}

async function getAccessToken() {
  if (state.accessToken && Date.now() < state.accessTokenExpiresAt) {
    return state.accessToken;
  }
  return refreshAccessToken();
}

async function blingRequest(config, retryOn401 = true) {
  let token = await getAccessToken();

  try {
    const response = await axios({
      ...config,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(config.headers || {})
      },
      timeout: 30000
    });
    return response;
  } catch (error) {
    const status = error.response?.status;
    if (status === 401 && retryOn401) {
      token = await refreshAccessToken();
      return axios({
        ...config,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(config.headers || {})
        },
        timeout: 30000
      });
    }
    throw error;
  }
}

function buildSearchUrls(tipoBusca, codigo) {
  const termo = encodeURIComponent(codigo);
  const tipo = normalizeText(tipoBusca);

  if (tipo === 'EAN') {
    return [
      `${BLING_API}/produtos?ean=${termo}`,
      `${BLING_API}/produtos?gtin=${termo}`,
      `${BLING_API}/produtos?codigoBarras=${termo}`,
      `${BLING_API}/produtos?search=${termo}`
    ];
  }

  return [
    `${BLING_API}/produtos?codigo=${termo}`,
    `${BLING_API}/produtos?sku=${termo}`,
    `${BLING_API}/produtos?search=${termo}`
  ];
}

function extractProductFromResponse(json, tipoBusca, codigoBuscado) {
  if (!json) return null;

  let lista = [];

  if (Array.isArray(json.data)) {
    lista = json.data;
  } else if (json.data && Array.isArray(json.data.produtos)) {
    lista = json.data.produtos;
  } else if (Array.isArray(json.produtos)) {
    lista = json.produtos;
  } else if (json.data && typeof json.data === 'object' && json.data.id) {
    lista = [json.data];
  }

  if (!lista.length) return null;

  const alvo = normalizeText(codigoBuscado);

  const found = lista.find((p) => {
    const campos = [p.codigo, p.sku, p.ean, p.gtin, p.codigoBarras].map(normalizeText);
    return campos.includes(alvo);
  });

  return found || lista[0];
}

async function getProductDetail(produtoId, fallbackResumo) {
  const response = await blingRequest({
    method: 'get',
    url: `${BLING_API}/produtos/${produtoId}`
  });

  const json = response.data;

  if (json && json.data) {
    if (Array.isArray(json.data)) return json.data[0] || fallbackResumo || null;
    if (typeof json.data === 'object') return json.data;
  }

  return fallbackResumo || null;
}

async function buscarProdutoNoBling(tipoBusca, codigo) {
  const urls = buildSearchUrls(tipoBusca, codigo);
  let ultimoErro = '';

  for (const url of urls) {
    try {
      const response = await blingRequest({ method: 'get', url });
      const produtoResumo = extractProductFromResponse(response.data, tipoBusca, codigo);
      if (produtoResumo && produtoResumo.id) {
        return getProductDetail(produtoResumo.id, produtoResumo);
      }
    } catch (error) {
      ultimoErro = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    }
  }

  if (ultimoErro) {
    throw new Error(`Erro ao buscar produto no Bling: ${ultimoErro}`);
  }

  return null;
}

function extractImageUrl(produto) {
  return firstFilled(
    produto?.midia?.imagens?.externas?.[0]?.link,
    produto?.midia?.imagens?.internas?.[0]?.link,
    produto?.midia?.imagens?.imagensURL?.[0],
    produto?.imagemURL,
    produto?.imagemUrl,
    produto?.urlImagem,
    produto?.imagem,
    produto?.midia?.url,
    produto?.midia?.link,
    produto?.imagens?.[0]?.url,
    produto?.imagens?.[0]?.link,
    produto?.imagens?.[0]?.arquivo,
    produto?.imageURL,
    produto?.imageUrl
  ) || '';
}

function mapProdutoResposta(produto) {
  return {
    id: produto?.id || '',
    nome: produto?.nome || '',
    estoque: firstFilled(
      produto?.estoque?.saldoVirtualTotal,
      produto?.estoque?.saldo,
      produto?.saldoVirtualTotal,
      produto?.saldo
    ) || '',
    localizacao: firstFilled(
      produto?.estoque?.localizacao,
      produto?.localizacao,
      produto?.deposito?.localizacao,
      produto?.depositos?.[0]?.localizacao,
      produto?.estoques?.[0]?.localizacao
    ) || '',
    imagem: extractImageUrl(produto)
  };
}

async function atualizarLocalizacaoNoBling(produtoId, novaLocalizacao) {
  const tentativasBody = [
    { estoque: { localizacao: novaLocalizacao } },
    { localizacao: novaLocalizacao }
  ];

  let ultimoErro = '';

  for (const body of tentativasBody) {
    try {
      const response = await blingRequest({
        method: 'patch',
        url: `${BLING_API}/produtos/${produtoId}`,
        data: body,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.status >= 200 && response.status < 300) {
        return true;
      }
    } catch (error) {
      ultimoErro = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    }
  }

  throw new Error(`Não foi possível atualizar a localização do produto. ${ultimoErro}`);
}

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'online' });
});

app.get('/buscar', requireApiKey, async (req, res) => {
  try {
    const tipo = normalizeText(req.query.tipo || 'SKU');
    const codigo = String(req.query.codigo || '').trim();

    if (!codigo) {
      return jsonError(res, 400, 'Código não informado.');
    }

    const produto = await buscarProdutoNoBling(tipo, codigo);
    if (!produto) {
      return jsonError(res, 404, 'Produto não encontrado.');
    }

    return res.json({
      ok: true,
      produto: mapProdutoResposta(produto)
    });
  } catch (error) {
    return jsonError(res, 500, error.message || 'Erro interno ao buscar produto.');
  }
});

app.post('/atualizar', requireApiKey, async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const tipo = normalizeText(body.tipo || 'SKU');
    const codigo = String(body.codigo || '').trim();
    const novaLocalizacao = String(body.novaLocalizacao || '').trim();

    if (!codigo) {
      return jsonError(res, 400, 'Código não informado.');
    }

    if (!novaLocalizacao) {
      return jsonError(res, 400, 'Nova localização não informada.');
    }

    const produto = await buscarProdutoNoBling(tipo, codigo);
    if (!produto || !produto.id) {
      return jsonError(res, 404, 'Produto não encontrado para atualização.');
    }

    const localizacaoAnterior = firstFilled(
      produto?.estoque?.localizacao,
      produto?.localizacao,
      produto?.deposito?.localizacao,
      produto?.depositos?.[0]?.localizacao,
      produto?.estoques?.[0]?.localizacao
    ) || '';

    await atualizarLocalizacaoNoBling(produto.id, novaLocalizacao);

    return res.json({
      ok: true,
      mensagem: 'Localização atualizada com sucesso.',
      localizacaoAnterior,
      localizacaoNova: novaLocalizacao
    });
  } catch (error) {
    return jsonError(res, 500, error.message || 'Erro interno ao atualizar localização.');
  }
});

app.listen(PORT, () => {
  console.log(`API Bling rodando na porta ${PORT}`);
});
