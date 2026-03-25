const express = require("express");
const cors = require("cors");
const fs = require('fs');
const usuarios = JSON.parse(fs.readFileSync('./usuarios.json', 'utf8'));
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY;
// ================= LOGIN =================
app.post('/login', (req, res) => {
  const { usuario, senha } = req.body;

  const user = usuarios.find(u => u.usuario === usuario && u.senha === senha);

  if (user) {
    res.json({ sucesso: true, perfil: user.perfil, usuario: user.usuario });
  } else {
    res.status(401).json({ sucesso: false, mensagem: 'Usuário ou senha inválidos' });
  }
});
// =========================
// RENOVAR ACCESS TOKEN
// =========================
async function renovarAccessToken() {
  const clientId = process.env.BLING_CLIENT_ID;
  const clientSecret = process.env.BLING_CLIENT_SECRET;
  const refreshToken = process.env.BLING_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Faltam BLING_CLIENT_ID, BLING_CLIENT_SECRET ou BLING_REFRESH_TOKEN no ambiente."
    );
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams();
  body.append("grant_type", "refresh_token");
  body.append("refresh_token", refreshToken);

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

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro ao renovar token:", JSON.stringify(data));
    throw new Error(`Erro ao renovar token: ${JSON.stringify(data)}`);
  }

  console.log("==========================================");
  console.log("NOVOS TOKENS GERADOS PELO BLING");
  console.log("ATUALIZE NO RENDER SE QUISER PERSISTIR:");
  console.log("BLING_ACCESS_TOKEN=", data.access_token);
  console.log("BLING_REFRESH_TOKEN=", data.refresh_token);
  console.log("==========================================");

  return data;
}

// =========================
// REQUEST AO BLING COM RETRY
// =========================
async function blingRequest(url, options = {}, accessToken = process.env.BLING_ACCESS_TOKEN) {
  let token = accessToken;

  let response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.headers || {})
    }
  });

  let data;
  try {
    data = await response.json();
  } catch {
    data = { raw: "Resposta não JSON do Bling" };
  }

  if (!response.ok && data?.error?.type === "invalid_token") {
    const novosTokens = await renovarAccessToken();
    token = novosTokens.access_token;

    response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.headers || {})
      }
    });

    try {
      data = await response.json();
    } catch {
      data = { raw: "Resposta não JSON do Bling" };
    }
  }

  return { response, data, accessToken: token };
}

// =========================
// MAPEAR PRODUTO PARA O PAINEL
// =========================
function mapearProdutoParaPainel(produtoLista, produtoDetalhe) {
  const p = produtoDetalhe || {};
  const l = produtoLista || {};

  let imagem = "";

  if (p.imagemURL) imagem = p.imagemURL;
  else if (l.imagemURL) imagem = l.imagemURL;
  else if (Array.isArray(p.imagensExternas) && p.imagensExternas.length > 0) {
    imagem = p.imagensExternas[0]?.link || p.imagensExternas[0]?.url || "";
  } else if (Array.isArray(l.imagensExternas) && l.imagensExternas.length > 0) {
    imagem = l.imagensExternas[0]?.link || l.imagensExternas[0]?.url || "";
  } else if (Array.isArray(p.imagens) && p.imagens.length > 0) {
    imagem = p.imagens[0]?.link || p.imagens[0]?.url || "";
  } else if (Array.isArray(l.imagens) && l.imagens.length > 0) {
    imagem = l.imagens[0]?.link || l.imagens[0]?.url || "";
  }

  let localizacao =
    p?.estoque?.localizacao ||
    p?.localizacao ||
    p?.deposito?.localizacao ||
    p?.depositos?.[0]?.localizacao ||
    p?.estoques?.[0]?.localizacao ||
    l?.estoque?.localizacao ||
    l?.localizacao ||
    l?.deposito?.localizacao ||
    l?.depositos?.[0]?.localizacao ||
    l?.estoques?.[0]?.localizacao ||
    "";

  if (!localizacao && Array.isArray(p.camposCustomizados)) {
    const campoEndereco = p.camposCustomizados.find((c) => {
      const nome = String(c.item || "").toLowerCase().trim();
      return nome === "endereço" || nome === "endereco";
    });

    if (campoEndereco?.valor) {
      localizacao = campoEndereco.valor;
    }
  }

  return {
    id: p.id || l.id || null,
    nome: p.nome || p.descricao || l.nome || l.descricao || "",
    codigo: p.codigo || l.codigo || "",
    localizacao,
    estoque: p.estoque?.saldoVirtualTotal || l.estoque?.saldoVirtualTotal || 0,
    imagem
  };
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

    const busca = await blingRequest(urlBusca);

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

    const detalhe = await blingRequest(
      `https://api.bling.com.br/Api/v3/produtos/${id}`,
      {},
      busca.accessToken
    );

    if (!detalhe.response.ok) {
      return res.status(detalhe.response.status).json({
        ok: false,
        erro:
          detalhe.data?.error?.description ||
          detalhe.data?.message ||
          "Erro ao consultar detalhe do produto",
        retornoBling: detalhe.data
      });
    }

    const produtoDetalhe = detalhe.data?.data || {};
    const produto = mapearProdutoParaPainel(produtoLista, produtoDetalhe);

    return res.json({
      ok: true,
      produto
    });
  } catch (error) {
    console.error("Erro /buscar:", error);
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
    const { key, codigo, novaLocalizacao } = req.body || {};

    if (!key || key !== API_KEY) {
      return res.status(401).json({
        ok: false,
        erro: "Acesso negado. API key inválida."
      });
    }

    if (!codigo || novaLocalizacao === undefined || novaLocalizacao === null) {
      return res.status(400).json({
        ok: false,
        erro: "Código e nova localização são obrigatórios."
      });
    }

    const busca = await blingRequest(
      `https://api.bling.com.br/Api/v3/produtos?codigo=${encodeURIComponent(codigo)}`
    );

    if (!busca.response.ok || !busca.data?.data?.length) {
      return res.status(404).json({
        ok: false,
        erro: "Produto não encontrado.",
        retornoBling: busca.data
      });
    }

    const id = busca.data.data[0].id;

    const tentativasBody = [
      { estoque: { localizacao: novaLocalizacao } },
      { localizacao: novaLocalizacao }
    ];

    let ultimaResposta = null;

    for (const body of tentativasBody) {
      const patch = await blingRequest(
        `https://api.bling.com.br/Api/v3/produtos/${id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        },
        busca.accessToken
      );

      ultimaResposta = patch;

      if (patch.response.ok) {
        const confirmacao = await blingRequest(
          `https://api.bling.com.br/Api/v3/produtos/${id}`,
          {},
          patch.accessToken
        );

        const produtoFinal = mapearProdutoParaPainel(
          busca.data.data[0],
          confirmacao.data?.data || {}
        );

        return res.json({
          ok: true,
          mensagem: "Localização atualizada com sucesso.",
          produto: produtoFinal
        });
      }
    }

    return res.status(ultimaResposta?.response?.status || 400).json({
      ok: false,
      erro: "Não foi possível atualizar a localização.",
      retornoBling: ultimaResposta?.data || null
    });
  } catch (error) {
    console.error("Erro /salvar:", error);
    return res.status(500).json({
      ok: false,
      erro: error.message
    });
  }
});
// ================= TELA CELULAR COM LOGIN =================
app.get('/celular', (req, res) => {
  res.send(`
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: Arial; padding: 20px; background: #f5f5f5; }
      input, button { width: 100%; padding: 15px; margin-top: 10px; font-size: 18px; }
      .box { background: white; padding: 15px; border-radius: 10px; margin-top: 15px; }
      img { width: 100%; margin-top: 10px; }
      #sistema { display: none; }
    </style>
  </head>
  <body>
    <h2>Login</h2>
    <input type="text" id="usuario" placeholder="Usuário" />
    <input type="password" id="senha" placeholder="Senha" />
    <button onclick="login()">Entrar</button>

    <div id="sistema">
      <h2>Localização de Produtos</h2>
      <input type="text" id="sku" placeholder="Bipar ou digitar SKU" />
      <button onclick="buscar()">Buscar</button>

      <div class="box">
        <div><b>Produto:</b> <span id="nome"></span></div>
        <div><b>Estoque:</b> <span id="estoque"></span></div>
        <div><b>Local atual:</b> <span id="local"></span></div>
      </div>

      <input type="text" id="novoLocal" placeholder="Nova localização" />
      <button onclick="salvar()">Salvar</button>

      <img id="imagem" />
    </div>

    <script>
      let idProduto = null;

      async function login() {
        const usuario = document.getElementById('usuario').value;
        const senha = document.getElementById('senha').value;

        const r = await fetch('/login', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ usuario, senha })
        });

        if (r.status === 200) {
          document.getElementById('sistema').style.display = 'block';
          document.querySelector('h2').innerText = 'Sistema';
          document.getElementById('usuario').style.display = 'none';
          document.getElementById('senha').style.display = 'none';
          document.querySelector('button').style.display = 'none';
        } else {
          alert('Login inválido');
        }
      }

      async function buscar() {
  const sku = document.getElementById('sku').value.trim();

  const r = await fetch('/buscar?key=GIRASSOL_ESTOQUE_2026&tipo=SKU&codigo=' + encodeURIComponent(sku));
  const d = await r.json();

  if (!d.ok || !d.produto) {
    alert(d.erro || 'Produto não encontrado');
    return;
  }

  document.getElementById('nome').innerText = d.produto.nome || '';
  document.getElementById('estoque').innerText = d.produto.estoque ?? '';
  document.getElementById('local').innerText = d.produto.localizacao || '';
  document.getElementById('imagem').src = d.produto.imagem || '';
  idProduto = d.produto.id || null;
}

      async function salvar() {
  const sku = document.getElementById('sku').value.trim();
  const novoLocal = document.getElementById('novoLocal').value.trim();

  const r = await fetch('/salvar', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      key: 'GIRASSOL_ESTOQUE_2026',
      codigo: sku,
      novaLocalizacao: novoLocal
    })
  });

  const d = await r.json();

  if (!d.ok) {
    alert(d.erro || 'Erro ao salvar');
    return;
  }

  document.getElementById('local').innerText = d.produto?.localizacao || novoLocal;
  alert('Salvo com sucesso');
}
    </script>
  </body>
  </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
