/**
 * AudioSync — Conversor de mídia YouTube para MP3 (Proxy Seguro)
 *
 * A API youtube-mp36 é SÍNCRONA — retorna o link MP3 direto na 1ª chamada.
 * Resposta real confirmada via cURL:
 * { msg:"success", progress:100, status:"ok", link:"https://...", title:"...", filesize:N, duration:N }
 *
 * Endpoints:
 *   POST /api/start   → Chama a API, retorna o link de download pronto
 *   POST /api/stream  → Proxy seguro: baixa o MP3 e entrega ao browser
 *   GET  /api/health  → Health check
 *
 * NOTA: Não há /api/status — a API não tem polling, retorna tudo de uma vez.
 */

const express = require('express');
const axios   = require('axios');
const path    = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Configuração ────────────────────────────────────────────

const API_HOST = process.env.API_HOST || 'youtube-mp36.p.rapidapi.com';
const API_URL  = process.env.API_URL  || 'https://youtube-mp36.p.rapidapi.com/dl';

const apiKeys = (process.env.API_KEYS || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

if (apiKeys.length === 0) {
  console.error('⛔ ERRO FATAL: Variável API_KEYS não definida ou vazia.');
  console.error('   Defina no .env (local) ou no Vercel Dashboard (produção).');
}

console.log(`🔑 ${apiKeys.length} chave(s) de API carregada(s)`);
console.log(`🌐 Host: ${API_HOST}`);

// ── Constantes ──────────────────────────────────────────────

// A API pode demorar até 30s para vídeos longos não cacheados
const TIMEOUT_REQUEST  = 35_000;
const TIMEOUT_DOWNLOAD = 60_000;
const FILENAME_MAX_LEN = 100;

const REGEX_VIDEO_ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([0-9A-Za-z_-]{11})/;

// ── Rotação de Chaves ───────────────────────────────────────
// Se uma key retornar 429 (rate limit) ou 403 (quota), tenta a próxima.

async function fetchWithRotation(config) {
  if (apiKeys.length === 0) {
    throw new Error('Nenhuma chave de API configurada.');
  }

  let lastError;

  for (let i = 0; i < apiKeys.length; i++) {
    const key = apiKeys[i];

    try {
      const response = await axios({
        ...config,
        headers: {
          ...(config.headers || {}),
          'x-rapidapi-key':  key,
          'x-rapidapi-host': API_HOST,
        },
        timeout: TIMEOUT_REQUEST,
      });

      console.log(`   ✅ Key ${i + 1}/${apiKeys.length} OK`);
      return response;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;

      if (status === 429 || status === 403) {
        console.warn(`   ⚠️ Key ${i + 1} → ${status}. Rotacionando...`);
        continue;
      }

      console.error(`   ❌ Key ${i + 1} → ${status}: ${error.message}`);
      throw error;
    }
  }

  console.error('   ❌ Todas as keys esgotadas.');
  throw lastError;
}

// ── Utilitários ─────────────────────────────────────────────

function extractVideoId(url) {
  const match = url.trim().match(REGEX_VIDEO_ID);
  return match?.[1] || null;
}

function sanitizeFilename(raw) {
  return (
    (raw || 'audio')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .substring(0, FILENAME_MAX_LEN)
      .trim() || 'audio'
  );
}

// ── POST /api/start ─────────────────────────────────────────
//
// A API youtube-mp36 é SÍNCRONA.
// Resposta de sucesso: { msg:"success", progress:100, status:"ok", link:"https://...", title:"..." }
// Resposta de falha:   { msg:"fail", ... }
//
// O backend extrai o "link" e retorna ao frontend como "downloadUrl".

app.post('/api/start', async (req, res) => {
  console.log('\n📥 POST /api/start');

  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ error: 'URL não fornecida.' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'URL do YouTube inválida.' });
    }

    console.log(`   Video ID: ${videoId}`);

    const { data } = await fetchWithRotation({
      method: 'GET',
      url:    API_URL,
      params: { id: videoId, format: 'mp3', audioQuality: '128' },
    });

    console.log(`   Resposta da API: status=${data?.status} | msg=${data?.msg} | progress=${data?.progress}`);

    // Verifica falha explícita da API
    if (data?.msg === 'fail' || data?.status === 'fail') {
      console.error('   ❌ API retornou falha:', JSON.stringify(data));
      return res.status(422).json({
        error: 'Não foi possível converter este vídeo. Pode ser privado, bloqueado ou muito longo.'
      });
    }

    // Verifica se o link foi retornado
    // A API youtube-mp36 retorna o campo "link" (confirmado via cURL)
    // Fallback para "url" por segurança caso a API mude o campo
    const downloadLink = data?.link || data?.url || null;

    if (!downloadLink) {
      console.error('   ❌ API não retornou link de download:', JSON.stringify(data));
      return res.status(500).json({
        error: 'A API não retornou o link de download. Tente novamente em alguns instantes.'
      });
    }

    console.log(`   ✅ Link obtido | Título: ${data.title}`);
    console.log(`   📦 Tamanho: ${(data.filesize / 1024 / 1024).toFixed(2)} MB | Duração: ${Math.round(data.duration)}s`);

    // Retorna ao frontend com "downloadUrl" (nome padronizado)
    return res.json({
      success:     true,
      downloadUrl: downloadLink,
      title:       data.title || 'Audio',
      filesize:    data.filesize || 0,
      duration:    Math.round(data.duration || 0),
    });

  } catch (error) {
    const status  = error.response?.status;
    const message = error.response?.data?.message || error.message;
    console.error(`   ❌ /api/start: ${status} — ${message}`);

    if (status === 400) return res.status(400).json({ error: 'Vídeo não encontrado ou URL inválida.' });
    if (status === 429 || status === 403) return res.status(503).json({ error: 'Limite de requisições atingido. Tente em alguns minutos.' });

    return res.status(500).json({ error: `Erro interno: ${message}` });
  }
});

// ── POST /api/stream ────────────────────────────────────────
//
// Proxy seguro: recebe a downloadUrl e faz streaming do MP3 para o browser.
// Necessário porque a URL do servidor da API tem tokens temporários e
// pode ter restrições de CORS que impedem o browser de acessar diretamente.

app.post('/api/stream', async (req, res) => {
  console.log('\n📥 POST /api/stream');

  const { downloadUrl, title } = req.body;

  if (!downloadUrl || typeof downloadUrl !== 'string') {
    return res.status(400).send('URL de download não fornecida.');
  }

  try {
    const filename = sanitizeFilename(title);
    console.log(`   Arquivo: ${filename}.mp3`);
    console.log(`   URL: ${downloadUrl.substring(0, 60)}...`);

    const stream = await axios({
      method:       'GET',
      url:          downloadUrl,
      responseType: 'stream',
      timeout:      TIMEOUT_DOWNLOAD,
    });

    // Nome ASCII para compatibilidade máxima com browsers
    const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '') || 'audio';

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFilename}.mp3"; filename*=UTF-8''${encodeURIComponent(filename)}.mp3`
    );
    res.setHeader('Content-Type', 'audio/mpeg');

    if (stream.headers['content-length']) {
      res.setHeader('Content-Length', stream.headers['content-length']);
    }

    // Pipe direto — sem buffer em memória (eficiente para arquivos grandes)
    stream.data.pipe(res);

    stream.data.on('error', (err) => {
      console.error('   ❌ Erro no stream:', err.message);
      if (!res.headersSent) res.status(500).send('Erro durante o download.');
    });

    res.on('finish', () => console.log('   ✅ Download concluído'));

  } catch (error) {
    console.error(`   ❌ /api/stream: ${error.message}`);
    if (!res.headersSent) res.status(500).send('Falha ao baixar o arquivo de áudio.');
  }
});

// ── GET /api/health ─────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status:    'ok',
    keys:      apiKeys.length,
    apiHost:   API_HOST,
    apiUrl:    API_URL,
    timestamp: new Date().toISOString(),
  });
});

// ── Servidor Local (dev) ────────────────────────────────────
// Em produção (Vercel), o static é servido pelo vercel.json automaticamente.

if (process.env.NODE_ENV !== 'production') {
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });
}

// ── Bootstrap & Export ──────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 http://localhost:${PORT}`);
    console.log(`🏥 http://localhost:${PORT}/api/health`);
    console.log(`🔑 ${apiKeys.length} chave(s) ativa(s)`);
  });
}

module.exports = app;
