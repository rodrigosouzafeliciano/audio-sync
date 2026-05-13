/**
 * AudioSync — Conversor de mídia YouTube para MP3
 *
 * CORREÇÃO VERCEL HOBBY: O plano Hobby tem limite de 4.5MB no body da resposta,
 * o que quebra o streaming via pipe(). Solução: /api/stream agora faz um
 * redirect 302 direto para a URL do MP3, deixando o browser baixar diretamente.
 *
 * Endpoints:
 *   POST /api/start   → Chama a API, retorna o link de download pronto
 *   GET  /api/stream  → Redirect 302 para a URL real do MP3 (download direto)
 *   GET  /api/health  → Health check
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
}

console.log(`🔑 ${apiKeys.length} chave(s) de API carregada(s)`);
console.log(`🌐 Host: ${API_HOST}`);

// ── Constantes ──────────────────────────────────────────────

const TIMEOUT_REQUEST  = 35_000;
const FILENAME_MAX_LEN = 100;

const REGEX_VIDEO_ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([0-9A-Za-z_-]{11})/;

// ── Rotação de Chaves ───────────────────────────────────────

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
      params: { id: videoId },
    });

    console.log(`   Resposta da API: status=${data?.status} | msg=${data?.msg} | progress=${data?.progress}`);

    if (data?.msg === 'fail' || data?.status === 'fail') {
      console.error('   ❌ API retornou falha:', JSON.stringify(data));
      return res.status(422).json({
        error: 'Não foi possível converter este vídeo. Pode ser privado, bloqueado ou muito longo.'
      });
    }

    const downloadLink = data?.link || data?.url || null;

    if (!downloadLink) {
      console.error('   ❌ API não retornou link de download:', JSON.stringify(data));
      return res.status(500).json({
        error: 'A API não retornou o link de download. Tente novamente em alguns instantes.'
      });
    }

    console.log(`   ✅ Link obtido | Título: ${data.title}`);

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

// ── GET /api/stream ─────────────────────────────────────────
//
// CORREÇÃO VERCEL HOBBY: Ao invés de fazer proxy/pipe (que estoura o limite
// de 4.5MB do Vercel Hobby), fazemos um redirect 302 direto para a URL do MP3.
// O browser baixa o arquivo diretamente do servidor da API, sem passar pelo Vercel.
//
// A URL chega como query param: GET /api/stream?url=https://...&title=Nome

app.get('/api/stream', (req, res) => {
  console.log('\n📥 GET /api/stream');

  const { url: downloadUrl, title } = req.query;

  if (!downloadUrl || typeof downloadUrl !== 'string') {
    return res.status(400).send('URL de download não fornecida.');
  }

  try {
    const filename = sanitizeFilename(title);
    console.log(`   Redirecionando para download: ${filename}.mp3`);

    // Redirect direto para a URL do MP3
    // O browser vai baixar o arquivo diretamente, sem passar pelo Vercel
    return res.redirect(302, downloadUrl);

  } catch (error) {
    console.error(`   ❌ /api/stream: ${error.message}`);
    return res.status(500).send('Falha ao redirecionar para o arquivo de áudio.');
  }
});

// Manter compatibilidade com POST /api/stream (caso o frontend ainda use)
app.post('/api/stream', (req, res) => {
  console.log('\n📥 POST /api/stream → redirecionando para GET');

  const { downloadUrl, title } = req.body;

  if (!downloadUrl || typeof downloadUrl !== 'string') {
    return res.status(400).send('URL de download não fornecida.');
  }

  try {
    const filename = sanitizeFilename(title);
    console.log(`   Redirecionando para download: ${filename}.mp3`);

    return res.redirect(302, downloadUrl);

  } catch (error) {
    console.error(`   ❌ /api/stream POST: ${error.message}`);
    return res.status(500).send('Falha ao redirecionar para o arquivo de áudio.');
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
