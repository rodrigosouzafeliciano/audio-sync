/**
 * AudioSync — Conversor de mídia YouTube para MP3
 *
 * SOLUÇÃO DEFINITIVA PARA VERCEL HOBBY:
 * /api/stream usa https nativo do Node para fazer proxy do MP3,
 * setando Content-Disposition com o nome correto ANTES de stremar.
 *
 * Endpoints:
 *   POST /api/start   → Chama a API, retorna o link de download pronto
 *   GET  /api/stream  → Proxy do MP3 com Content-Disposition correto
 *   GET  /api/health  → Health check
 */

const express = require('express');
const axios   = require('axios');
const https   = require('https');
const http    = require('http');
const path    = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const API_HOST = process.env.API_HOST || 'youtube-mp36.p.rapidapi.com';
const API_URL  = process.env.API_URL  || 'https://youtube-mp36.p.rapidapi.com/dl';

const apiKeys = (process.env.API_KEYS || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

if (apiKeys.length === 0) {
  console.error('ERRO FATAL: API_KEYS nao definida.');
}

console.log(`${apiKeys.length} chave(s) carregada(s) | Host: ${API_HOST}`);

const TIMEOUT_REQUEST  = 35_000;
const FILENAME_MAX_LEN = 100;
const REGEX_VIDEO_ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([0-9A-Za-z_-]{11})/;

async function fetchWithRotation(config) {
  if (apiKeys.length === 0) throw new Error('Nenhuma chave de API configurada.');
  let lastError;
  for (let i = 0; i < apiKeys.length; i++) {
    const key = apiKeys[i];
    try {
      const response = await axios({
        ...config,
        headers: { ...(config.headers || {}), 'x-rapidapi-key': key, 'x-rapidapi-host': API_HOST },
        timeout: TIMEOUT_REQUEST,
      });
      console.log(`   OK Key ${i + 1}`);
      return response;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (status === 429 || status === 403) { console.warn(`   Key ${i + 1} -> ${status}`); continue; }
      throw error;
    }
  }
  throw lastError;
}

function extractVideoId(url) {
  const match = url.trim().match(REGEX_VIDEO_ID);
  return match?.[1] || null;
}

function sanitizeFilename(raw) {
  return ((raw || 'audio').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, '_').replace(/_{2,}/g, '_').substring(0, FILENAME_MAX_LEN).trim() || 'audio');
}

// Proxy nativo: segue redirects e repassa o MP3 chunk a chunk com nome correto
function proxyDownload(downloadUrl, filename, res, depth) {
  depth = depth || 0;
  if (depth > 5) return Promise.reject(new Error('Muitos redirects'));

  return new Promise((resolve, reject) => {
    const protocol = downloadUrl.startsWith('https') ? https : http;

    const req = protocol.get(downloadUrl, {
      timeout: 60000,
      headers: { 'User-Agent': 'Mozilla/5.0 AudioSync/1.0' }
    }, (remoteRes) => {

      // Seguir redirects manualmente
      if ([301, 302, 307, 308].includes(remoteRes.statusCode)) {
        const location = remoteRes.headers['location'];
        remoteRes.resume();
        if (location) {
          console.log(`   Redirect ${remoteRes.statusCode} -> ${location.substring(0, 60)}`);
          proxyDownload(location, filename, res, depth + 1).then(resolve).catch(reject);
        } else {
          reject(new Error('Redirect sem Location header'));
        }
        return;
      }

      if (remoteRes.statusCode !== 200) {
        remoteRes.resume();
        reject(new Error(`HTTP ${remoteRes.statusCode}`));
        return;
      }

      // Headers com nome correto ANTES de stremar
      const ascii = filename.replace(/[^\x20-\x7E]/g, '') || 'audio';
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', `attachment; filename="${ascii}.mp3"; filename*=UTF-8''${encodeURIComponent(filename)}.mp3`);
      res.setHeader('Cache-Control', 'no-cache');
      if (remoteRes.headers['content-length']) {
        res.setHeader('Content-Length', remoteRes.headers['content-length']);
      }

      remoteRes.pipe(res);
      remoteRes.on('end', resolve);
      remoteRes.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// POST /api/start
app.post('/api/start', async (req, res) => {
  console.log('\nPOST /api/start');
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.trim()) return res.status(400).json({ error: 'URL nao fornecida.' });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'URL do YouTube invalida.' });
    console.log(`   Video ID: ${videoId}`);

    const { data } = await fetchWithRotation({ method: 'GET', url: API_URL, params: { id: videoId } });
    console.log(`   API: status=${data?.status} msg=${data?.msg}`);

    if (data?.msg === 'fail' || data?.status === 'fail') {
      return res.status(422).json({ error: 'Nao foi possivel converter este video.' });
    }

    const downloadLink = data?.link || data?.url || null;
    if (!downloadLink) return res.status(500).json({ error: 'API nao retornou link de download.' });

    console.log(`   Link obtido: ${data.title}`);
    return res.json({ success: true, downloadUrl: downloadLink, title: data.title || 'Audio', filesize: data.filesize || 0, duration: Math.round(data.duration || 0) });

  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;
    console.error(`   ERRO /api/start: ${status} - ${message}`);
    if (status === 400) return res.status(400).json({ error: 'Video nao encontrado.' });
    if (status === 429 || status === 403) return res.status(503).json({ error: 'Limite de requisicoes. Tente em alguns minutos.' });
    return res.status(500).json({ error: `Erro interno: ${message}` });
  }
});

// GET /api/stream — proxy real com nome correto
app.get('/api/stream', async (req, res) => {
  console.log('\nGET /api/stream');
  const { url: downloadUrl, title } = req.query;
  if (!downloadUrl) return res.status(400).send('URL nao fornecida.');

  const filename = sanitizeFilename(title);
  console.log(`   Arquivo: ${filename}.mp3`);

  try {
    await proxyDownload(downloadUrl, filename, res, 0);
  } catch (err) {
    console.error(`   ERRO stream: ${err.message}`);
    if (!res.headersSent) res.status(500).send('Falha ao baixar o arquivo.');
  }
});

// POST /api/stream (compatibilidade)
app.post('/api/stream', async (req, res) => {
  console.log('\nPOST /api/stream');
  const { downloadUrl, title } = req.body;
  if (!downloadUrl) return res.status(400).send('URL nao fornecida.');

  const filename = sanitizeFilename(title);
  try {
    await proxyDownload(downloadUrl, filename, res, 0);
  } catch (err) {
    console.error(`   ERRO stream POST: ${err.message}`);
    if (!res.headersSent) res.status(500).send('Falha ao baixar o arquivo.');
  }
});

// GET /api/health
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', keys: apiKeys.length, timestamp: new Date().toISOString() });
});

if (process.env.NODE_ENV !== 'production') {
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));
}

module.exports = app;
