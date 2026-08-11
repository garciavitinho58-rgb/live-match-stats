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

    const req = https.request(
      {
        hostname: API_HOST,
        path: endpoint,
        method: 'GET',
        headers: {
          'x-apisports-key': API_KEY,
          'Accept': 'application/json',
          'User-Agent': 'LiveMatchStats/4.0'
        }
      },
      res => {
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

            if (json.errors && Object.keys(json.errors).length) {
              return reject(
                new Error(
                  JSON.stringify(json.errors)
                )
              );
            }

            resolve(json);
          } catch {
            reject(
              new Error('Resposta inválida da API-Football.')
            );
          }
        });
      }
    );

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

function parseInput(value) {
  const text = String(value || '').trim();

  if (!text) {
    return {};
  }

  // ID da API-Football
  if (/^\d{4,7}$/.test(text)) {
    return {
      fixtureId: text
    };
  }

  // Formato:
  // Time A x Time B
  // Time A vs Time B
  // Time A - Time B
  const match = text.match(
    /^(.+?)\s+(?:x|vs\.?|versus|-)\s+(.+)$/i
  );

  if (match) {
    return {
      home: match[1].trim(),
      away: match[2].trim()
    };
  }

  return {
    search: text
  };
}

async function findFixture(input) {
  const parsed = parseInput(input);

  // Se foi fornecido um ID da API-Football
  if (parsed.fixtureId) {
    const data = await requestAPI(
      `/fixtures?id=${encodeURIComponent(parsed.fixtureId)}`
    );

    if (!data.response || !data.response.length) {
      throw new Error(
        'Partida não encontrada pelo ID da API-Football.'
      );
    }

    return data.response[0];
  }

  // Se foi fornecido "Time A x Time B"
  if (parsed.home && parsed.away) {
    const search = await requestAPI(
      `/teams?search=${encodeURIComponent(parsed.home)}`
    );

    const teams = search.response || [];

    if (!teams.length) {
      throw new Error(
        `Time não encontrado: ${parsed.home}`
      );
    }

    const homeTeam =
      teams.find(
        item =>
          normalize(item.team.name) === normalize(parsed.home)
      ) || teams[0];

    const awaySearch = await requestAPI(
      `/teams?search=${encodeURIComponent(parsed.away)}`
    );

    const awayTeams = awaySearch.response || [];

    if (!awayTeams.length) {
      throw new Error(
        `Time não encontrado: ${parsed.away}`
      );
    }

    const awayTeam =
      awayTeams.find(
        item =>
          normalize(item.team.name) === normalize(parsed.away)
      ) || awayTeams[0];

    // Procura partidas recentes de cada equipe.
    const homeFixtures = await requestAPI(
      `/fixtures?team=${homeTeam.team.id}&last=20`
    );

    const awayFixtures = await requestAPI(
      `/fixtures?team=${awayTeam.team.id}&last=20`
    );

    const all = [
      ...(homeFixtures.response || []),
      ...(awayFixtures.response || [])
    ];

    const unique = new Map();

    all.forEach(fixture => {
      unique.set(
        fixture.fixture.id,
        fixture
      );
    });

    const candidates = [...unique.values()];

    const exact = candidates.find(fixture => {
      const h =
        normalize(fixture.teams.home.name);

      const a =
        normalize(fixture.teams.away.name);

      return (
        (
          h === normalize(parsed.home) &&
          a === normalize(parsed.away)
        ) ||
        (
          h === normalize(parsed.away) &&
          a === normalize(parsed.home)
        )
      );
    });

    if (exact) {
      return exact;
    }

    throw new Error(
      'Não encontrei essa partida nas últimas partidas das equipes.'
    );
  }

  // Pesquisa simples por nome de equipe
  if (parsed.search) {
    const teams = await requestAPI(
      `/teams?search=${encodeURIComponent(parsed.search)}`
    );

    if (!teams.response || !teams.response.length) {
      throw new Error(
        'Nenhum time encontrado.'
      );
    }

    const team =
      teams.response[0].team;

    const fixtures = await requestAPI(
      `/fixtures?team=${team.id}&next=10`
    );

    if (
      fixtures.response &&
      fixtures.response.length
    ) {
      return fixtures.response[0];
    }

    const previous = await requestAPI(
      `/fixtures?team=${team.id}&last=10`
    );

    if (
      previous.response &&
      previous.response.length
    ) {
      return previous.response[0];
    }

    throw new Error(
      'Nenhuma partida encontrada para esse time.'
    );
  }

  throw new Error(
    'Informe um ID da API-Football ou "Time A x Time B".'
  );
}

async function getMatchData(fixtureId) {
  const cached = cache.get(String(fixtureId));

  if (
    cached &&
    Date.now() - cached.time < CACHE_TTL
  ) {
    return cached.data;
  }

  const [fixtureData, statistics, events, lineups] =
    await Promise.all([
      requestAPI(
        `/fixtures?id=${fixtureId}`
      ),

      requestAPI(
        `/fixtures/statistics?fixture=${fixtureId}`
      ),

      requestAPI(
        `/fixtures/events?fixture=${fixtureId}`
      ),

      requestAPI(
        `/fixtures/lineups?fixture=${fixtureId}`
      )
    ]);

  const data = {
    fixture:
      fixtureData.response?.[0] || null,

    statistics:
      statistics.response || [],

    events:
      events.response || [],

    lineups:
      lineups.response || []
  };

  cache.set(String(fixtureId), {
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

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type':
      'application/json; charset=utf-8',
    'Cache-Control':
      'no-store'
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

      if (url.pathname === '/api/match') {

        const input =
          url.searchParams.get('q') ||
          url.searchParams.get('id') ||
          url.searchParams.get('search');

        if (!input) {
          return sendJSON(
            res,
            400,
            {
              error:
                'Informe o ID da API-Football ou os nomes dos times.'
            }
          );
        }

        const fixture =
          await findFixture(input);

        if (!fixture) {
          return sendJSON(
            res,
            404,
            {
              error:
                'Partida não encontrada.'
            }
          );
        }

        const fixtureId =
          fixture.fixture.id;

        const data =
          await getMatchData(fixtureId);

        return sendJSON(
          res,
          200,
          {
            ok: true,
            source: 'API-Football',
            fixtureId,
            data
          }
        );
      }

      if (
        url.pathname === '/' ||
        url.pathname === '/index.html'
      ) {

        res.writeHead(200, {
          'Content-Type':
            'text/html; charset=utf-8',
          'Cache-Control':
            'no-cache'
        });

        return res.end(indexHTML);
      }

      res.writeHead(404, {
        'Content-Type':
          'text/plain; charset=utf-8'
      });

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
  });

server.listen(
  PORT,
  () => {
    console.log(
      `Live Match Stats V4 - API-Football - porta ${PORT}`
    );
  }
);
