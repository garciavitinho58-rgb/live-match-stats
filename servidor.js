const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const HOSTS = [
  'api.sofascore.app',
  'api.sofascore.com',
  'www.sofascore.com'
];

const CACHE_TTL = 10000;
const cache = new Map();

function requestJSON(host, endpoint) {
  return new Promise((resolve, reject) => {

    const options = {
      hostname: host,
      path: endpoint,
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept':
          'application/json, text/plain, */*',
        'Accept-Language':
          'pt-BR,pt;q=0.9,en;q=0.8',
        'Referer':
          'https://www.sofascore.com/',
        'Origin':
          'https://www.sofascore.com'
      }
    };

    const req = https.request(options, res => {

      let body = '';

      res.setEncoding('utf8');

      res.on('data', chunk => {
        body += chunk;
      });

      res.on('end', () => {

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(
            new Error(
              `${host} HTTP ${res.statusCode}`
            )
          );
        }

        try {
          resolve(JSON.parse(body));
        } catch {
          reject(
            new Error(
              `${host} retornou uma resposta não-JSON`
            )
          );
        }
      });
    });

    req.on('error', reject);

    req.setTimeout(12000, () => {
      req.destroy(
        new Error(`${host} timeout`)
      );
    });

    req.end();
  });
}

async function fetchSofaScore(endpoint) {

  let lastError = null;

  for (const host of HOSTS) {

    try {

      const data =
        await requestJSON(host, endpoint);

      return {
        ok: true,
        host,
        data
      };

    } catch (error) {

      console.log(
        `Falha ${host}${endpoint}:`,
        error.message
      );

      lastError = error;
    }
  }

  return {
    ok: false,
    error:
      lastError?.message ||
      'Não foi possível consultar o SofaScore.'
  };
}

function getMatchId(value) {

  const text =
    String(value || '').trim();

  if (/^\d{5,}$/.test(text)) {
    return text;
  }

  let match =
    text.match(/#id:(\d{5,})/i);

  if (match) {
    return match[1];
  }

  match =
    text.match(/\/(\d{5,})(?:[/?#]|$)/);

  if (match) {
    return match[1];
  }

  match =
    text.match(/\b(\d{6,})\b/);

  if (match) {
    return match[1];
  }

  return null;
}

async function getMatchData(id) {

  const cached = cache.get(id);

  if (
    cached &&
    Date.now() - cached.time < CACHE_TTL
  ) {
    return cached.data;
  }

  const base =
    `/api/v1/event/${id}`;

  const endpoints = {
    event: base,
    statistics: `${base}/statistics`,
    incidents: `${base}/incidents`,
    lineups: `${base}/lineups`,
    graph: `${base}/graph`,
    momentum: `${base}/momentum`
  };

  const result = {};

  for (const [name, endpoint] of
       Object.entries(endpoints)) {

    const response =
      await fetchSofaScore(endpoint);

    if (response.ok) {

      result[name] =
        response.data;

    } else {

      result[name] = {
        error: response.error
      };
    }
  }

  cache.set(id, {
    time: Date.now(),
    data: result
  });

  return result;
}

const indexPath =
  path.join(
    __dirname,
    'public',
    'index.html'
  );

const indexHTML =
  fs.readFileSync(
    indexPath,
    'utf8'
  );

function sendJSON(res, status, data) {

  res.writeHead(status, {
    'Content-Type':
      'application/json; charset=utf-8',

    'Cache-Control':
      'no-store',

    'Access-Control-Allow-Origin':
      '*'
  });

  res.end(
    JSON.stringify(data)
  );
}

const server =
  http.createServer(async (req, res) => {

    try {

      const url =
        new URL(
          req.url,
          `http://${req.headers.host || 'localhost'}`
        );

      if (
        url.pathname === '/api/match'
      ) {

        const input =
          url.searchParams.get('id') ||
          url.searchParams.get('url');

        const id =
          getMatchId(input);

        if (!id) {

          return sendJSON(
            res,
            400,
            {
              error:
                'ID da partida não encontrado.'
            }
          );
        }

        const data =
          await getMatchData(id);

        const event =
          data.event;

        if (
          !event ||
          event.error
        ) {

          return sendJSON(
            res,
            502,
            {
              error:
                'Não foi possível obter os dados da partida.',

              details:
                event?.error ||
                'Nenhuma fonte do SofaScore respondeu.'
            }
          );
        }

        return sendJSON(
          res,
          200,
          {
            ok: true,
            id,
            data
          }
        );
      }

      if (
        url.pathname === '/' ||
        url.pathname === '/index.html'
      ) {

        res.writeHead(
          200,
          {
            'Content-Type':
              'text/html; charset=utf-8',

            'Cache-Control':
              'no-cache'
          }
        );

        return res.end(
          indexHTML
        );
      }

      res.writeHead(
        404,
        {
          'Content-Type':
            'text/plain; charset=utf-8'
        }
      );

      res.end(
        'Página não encontrada.'
      );

    } catch (error) {

      console.error(error);

      sendJSON(
        res,
        500,
        {
          error:
            'Erro interno do servidor.',

          details:
            error.message
        }
      );
    }
  });

server.listen(
  PORT,
  () => {
    console.log(
      `Live Match Stats V4 rodando na porta ${PORT}`
    );
  }
);
