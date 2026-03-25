# API Bling para Localização de Estoque (Render)

Projeto pronto para subir no Render.

## O que esta API faz
- `GET /health` -> teste rápido
- `GET /buscar?tipo=SKU&codigo=...` -> busca produto no Bling
- `POST /atualizar` -> atualiza localização no Bling

## 1) Subir no Render
1. Crie uma pasta/repositório com estes arquivos.
2. Suba para o GitHub.
3. No Render, clique em **New +** -> **Web Service**.
4. Conecte o repositório.
5. Use:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`

## 2) Variáveis de ambiente no Render
Cadastre estas variáveis:
- `API_KEY`
- `BLING_CLIENT_ID`
- `BLING_CLIENT_SECRET`
- `BLING_REFRESH_TOKEN`
- `BLING_REDIRECT_URI` (se usar)

## 3) Testar
### Health
`https://SEU-APP.onrender.com/health`

### Buscar
`https://SEU-APP.onrender.com/buscar?key=SUA_CHAVE&tipo=SKU&codigo=PROD-TESTE`

### Atualizar
POST para `https://SEU-APP.onrender.com/atualizar`
Body JSON:
```json
{
  "key": "SUA_CHAVE",
  "tipo": "SKU",
  "codigo": "PROD-TESTE",
  "novaLocalizacao": "A-01-02"
}
```

## 4) Mudar sua extensão
No `content.js`:
- buscar -> `GET /buscar`
- salvar -> `POST /atualizar`

## Observação
Este projeto usa o `refresh_token` do Bling para gerar o `access_token` automaticamente.
