
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_HOST = 'v3.football.api-sports.io';

const CACHE_TTL = 15000;
const cache = new Map();

function requestAPI(endpoint) {
  return new Promise((resolve, reject) => {

    if (!API_KEY) {
      return reject(
        new Error('API_FOOTBALL_KEY não configurada no Render.')
      );
    }

    const req = https.request({
      hostname: API_HOST,
      path: endpoint,
      method: 'GET',
      headers: {
        'x-apisports-key': API_KEY,
        'Accept': 'application/json',
        'User-Agent': 'LiveMatchStats/4.0'
      }
    }, res => {

      let body = '';

      res.setEncoding('utf8');

      res.on('data', chunk => {
        body += chunk;
      });

      res.on('end', () => {

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(
            new Error(
              `API-Football HTTP ${res.statusCode}: ${body.slice(0, 300)}`
            )
          );
        }

        try {

          const json = JSON.parse(body);

          if (
            json.errors &&
            Object.keys(json.errors).length
          ) {
            return reject(
              new Error(
                JSON.stringify(json.errors)
              )
            );
          }

          resolve(json);

        } catch {
          reject(
            new Error(
              'Resposta inválida da API-Football.'
            )
          );
        }
      });
    });

    req.on('error', reject);

    req.setTimeout(12000, () => {
      req.destroy(
        new Error('Timeout da API-Football.')
      );
    });

    req.end();
  });
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function parseTeams(value) {

  const text =
    String(value || '').trim();

  const match =
    text.match(
      /^(.+?)\s+(?:x|vs\.?|versus|-)\s+(.+)$/i
    );

  if (!match) {
    return null;
  }

  return {
    home: match[1].trim(),
    away: match[2].trim()
  };
}

async function findTeam(name) {

  const data =
    await requestAPI(
      `/teams?search=${encodeURIComponent(name)}`
    );

  const teams =
    data.response || [];

  if (!teams.length) {
    throw new Error(
      `Time não encontrado: ${name}`
    );
  }

  const exact =
    teams.find(
      item =>
        normalize(item.team.name) ===
        normalize(name)
    );

  return (
    exact ||
    teams[0]
  ).team;
}

function formatDate(date) {

  const year =
    date.getFullYear();

  const month =
    String(
      date.getMonth() + 1
    ).padStart(2, '0');

  const day =
    String(
      date.getDate()
    ).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

async function fixturesByDate(date) {

  return requestAPI(
    `/fixtures?date=${date}`
  );
}

async function findFixture(input) {

  const text =
    String(input || '').trim();

  /*
   * Se for um ID numérico, tratamos como
   * ID da API-Football.
   */

  if (/^\d{4,7}$/.test(text)) {

    const data =
      await requestAPI(
        `/fixtures?id=${text}`
      );

    if (
      !data.response ||
      !data.response.length
    ) {
      throw new Error(
        'Partida não encontrada pelo ID da API-Football.'
      );
    }

    return data.response[0];
  }

  const teams =
    parseTeams(text);

  if (!teams) {

    throw new Error(
      'Digite os times no formato: Time A x Time B'
    );
  }

  const homeTeam =
    await findTeam(teams.home);

  const awayTeam =
    await findTeam(teams.away);

  /*
   * O plano gratuito não permite "last".
   *
   * Por isso consultamos partidas por DATA.
   *
   * Primeiro hoje.
   * Depois alguns dias anteriores.
   */

  const dates = [];

  const today =
    new Date();

  for (let i = 0; i <= 7; i++) {

    const d =
      new Date(today);

    d.setDate(
      today.getDate() - i
    );

    dates.push(
      formatDate(d)
    );
  }

  /*
   * Também verificamos alguns dias futuros.
   */

  for (let i = 1; i <= 7; i++) {

    const d =
      new Date(today);

    d.setDate(
      today.getDate() + i
    );

    dates.push(
      formatDate(d)
    );
  }

  for (const date of dates) {

    const data =
      await fixturesByDate(date);

    const fixtures =
      data.response || [];

    const found =
      fixtures.find(fixture => {

        const h =
          normalize(
            fixture.teams?.home?.name
          );

        const a =
          normalize(
            fixture.teams?.away?.name
          );

        return (
          (
            h === normalize(teams.home) &&
            a === normalize(teams.away)
          ) ||
          (
            h === normalize(teams.away) &&
            a === normalize(teams.home)
          )
        );
      });

    if (found) {
      return found;
    }
  }

  throw new Error(
    `Não encontrei ${teams.home} x ${teams.away} nos próximos/últimos dias consultados.`
  );
}

async function getMatchData(fixtureId) {

  const key =
    String(fixtureId);

  const cached =
    cache.get(key);

  if (
    cached &&
    Date.now() - cached.time <
    CACHE_TTL
  ) {
    return cached.data;
  }

  const fixture =
    await requestAPI(
      `/fixtures?id=${fixtureId}`
    );

  const statistics =
    await requestAPI(
      `/fixtures/statistics?fixture=${fixtureId}`
    );

  const events =
    await requestAPI(
      `/fixtures/events?fixture=${fixtureId}`
    );

  let lineups = {
    response: []
  };

  try {

    lineups =
      await requestAPI(
        `/fixtures/lineups?fixture=${fixtureId}`
      );

  } catch (error) {

    console.log(
      'Lineups indisponíveis:',
      error.message
    );
  }

  const data = {

    fixture:
      fixture.response?.[0] ||
      null,

    statistics:
      statistics.response ||
      [],

    events:
      events.response ||
      [],

    lineups:
      lineups.response ||
      []
  };

  cache.set(key, {
    time: Date.now(),
    data
  });

  return data;
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

function sendJSON(
  res,
  status,
  data
) {

  res.writeHead(
    status,
    {
      'Content-Type':
        'application/json; charset=utf-8',

      'Cache-Control':
        'no-store'
    }
  );

  res.end(
    JSON.stringify(data)
  );
}

const server =
  http.createServer(
    async (req, res) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host || 'localhost'}`
          );

        if (
          url.pathname ===
          '/api/match'
        ) {

          const input =
            url.searchParams.get('q') ||
            url.searchParams.get('id');

          if (!input) {

            return sendJSON(
              res,
              400,
              {
                error:
                  'Informe os dois times no formato Time A x Time B.'
              }
            );
          }

          const fixture =
            await findFixture(input);

          const fixtureId =
            fixture.fixture.id;

          const data =
            await getMatchData(
              fixtureId
            );

          return sendJSON(
            res,
            200,
            {
              ok: true,
              source:
                'API-Football',

              fixtureId,

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

        console.error(
          'ERRO:',
          error
        );

        return sendJSON(
          res,
          500,
          {
            error:
              'Não foi possível obter os dados agora.',

            details:
              error.message
          }
        );
      }
    }
  );

server.listen(
  PORT,
  () => {

    console.log(
      `Live Match Stats V4 API-Football rodando na porta ${PORT}`
    );

  }
);
