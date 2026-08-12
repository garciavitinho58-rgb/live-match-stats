const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const SPORTMONKS_TOKEN =
  process.env.SPORTMONKS_API_TOKEN;

const API_FOOTBALL_KEY =
  process.env.API_FOOTBALL_KEY;

const SPORTMONKS_HOST =
  'api.sportmonks.com';

const API_FOOTBALL_HOST =
  'v3.football.api-sports.io';

/*
========================================================
 UTILIDADES
========================================================
*/

function requestHttps({
  hostname,
  path,
  headers = {},
  timeout = 15000
}) {
  return new Promise((resolve, reject) => {

    const req = https.request(
      {
        hostname,
        path,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...headers
        }
      },
      res => {

        let body = '';

        res.on('data', chunk => {
          body += chunk;
        });

        res.on('end', () => {

          let json;

          try {
            json = JSON.parse(body);
          } catch {
            reject(
              new Error(
                `Resposta inválida. HTTP ${res.statusCode}`
              )
            );
            return;
          }

          if (
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${
                  JSON.stringify(json)
                }`
              )
            );
            return;
          }

          resolve(json);
        });
      }
    );

    req.on('error', reject);

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(
        new Error('Timeout da API.')
      );
    });

    req.end();
  });
}

/*
========================================================
 SPORTMONKS
========================================================
*/

function sportmonks(pathname) {

  if (!SPORTMONKS_TOKEN) {
    throw new Error(
      'SPORTMONKS_API_TOKEN não configurada no Render.'
    );
  }

  const separator =
    pathname.includes('?')
      ? '&'
      : '?';

  const endpoint =
    pathname +
    separator +
    'api_token=' +
    encodeURIComponent(
      SPORTMONKS_TOKEN
    );

  return requestHttps({
    hostname: SPORTMONKS_HOST,
    path: endpoint
  });
}

/*
========================================================
 API-FOOTBALL - FONTE SECUNDÁRIA
========================================================
*/

function apiFootball(endpoint) {

  if (!API_FOOTBALL_KEY) {
    throw new Error(
      'API_FOOTBALL_KEY não configurada.'
    );
  }

  return requestHttps({
    hostname: API_FOOTBALL_HOST,
    path: endpoint,
    headers: {
      'x-apisports-key':
        API_FOOTBALL_KEY
    }
  });
}

/*
========================================================
 NORMALIZAÇÃO
========================================================
*/

function normalize(text) {

  return String(text || '')
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    )
    .toLowerCase()
    .trim();
}

function todayISO() {

  const now =
    new Date();

  const yyyy =
    now.getUTCFullYear();

  const mm =
    String(
      now.getUTCMonth() + 1
    ).padStart(2, '0');

  const dd =
    String(
      now.getUTCDate()
    ).padStart(2, '0');

  return `${yyyy}-${mm}-${dd}`;
}

function addDaysISO(
  dateString,
  days
) {

  const d =
    new Date(
      `${dateString}T00:00:00Z`
    );

  d.setUTCDate(
    d.getUTCDate() + days
  );

  return d
    .toISOString()
    .slice(0, 10);
}

function parseTeams(text) {

  const m =
    String(text || '')
      .trim()
      .match(
        /^(.+?)\s+(?:x|vs\.?|versus|-)\s+(.+)$/i
      );

  if (!m) {
    return null;
  }

  return {
    home: m[1].trim(),
    away: m[2].trim()
  };
}

function fixtureTeams(fixture) {

  const participants =
    fixture?.participants || [];

  let home = null;
  let away = null;

  for (const team of participants) {

    const location =
      team?.meta?.location;

    if (location === 'home') {
      home = team;
    }

    if (location === 'away') {
      away = team;
    }
  }

  return {
    home,
    away
  };
}

function fixtureMatches(
  fixture,
  home,
  away
) {

  const teams =
    fixtureTeams(fixture);

  if (
    !teams.home ||
    !teams.away
  ) {
    return false;
  }

  const h =
    normalize(home);

  const a =
    normalize(away);

  const homeName =
    normalize(
      teams.home.name
    );

  const awayName =
    normalize(
      teams.away.name
    );

  return (
    homeName === h &&
    awayName === a
  ) || (
    homeName === a &&
    awayName === h
  );
}

/*
========================================================
 INCLUDES
========================================================

A SportMonks pode limitar a quantidade de níveis de
relacionamentos por requisição dependendo do endpoint/
plano. Por isso mantemos uma lista centralizada.
*/

const FIXTURE_INCLUDES =
  [
    'participants',
    'league',
    'venue',
    'state',
    'scores',
    'events.type',
    'events.period',
    'events.player',
    'statistics',
    'odds.market',
    'odds.bookmaker',
    'predictions.type',
    'lineups.player',
    'lineups.xGlineup.type',
    'xGFixture.type'
  ].join(';');

/*
========================================================
 PARTIDA POR ID
========================================================
*/

async function getSportmonksFixture(
  fixtureId
) {

  const result =
    await sportmonks(
      `/v3/football/fixtures/${encodeURIComponent(
        fixtureId
      )}?include=${encodeURIComponent(
        FIXTURE_INCLUDES
      )}`
    );

  return result?.data || null;
}

/*
========================================================
 JOGOS DE UMA DATA
========================================================
*/

async function getFixturesByDate(
  date
) {

  const result =
    await sportmonks(
      `/v3/football/fixtures/date/${encodeURIComponent(
        date
      )}?include=${encodeURIComponent(
        'participants;league;state;scores;odds.market;odds.bookmaker;predictions.type'
      )}`
    );

  return result?.data || [];
}

/*
========================================================
 JOGOS POR INTERVALO
========================================================
*/

async function getFixturesBetween(
  start,
  end
) {

  const result =
    await sportmonks(
      `/v3/football/fixtures/between/${encodeURIComponent(
        start
      )}/${encodeURIComponent(
        end
      )}?include=${encodeURIComponent(
        'participants;league;state;scores;odds.market;odds.bookmaker;predictions.type'
      )}`
    );

  return result?.data || [];
}

/*
========================================================
 AO VIVO
========================================================
*/

async function getLiveFixtures() {

  const result =
    await sportmonks(
      `/v3/football/livescores/inplay?include=${encodeURIComponent(
        'participants;league;state;scores;events.type;events.player;statistics'
      )}`
    );

  return result?.data || [];
}

/*
========================================================
 PROCURAR PARTIDA
========================================================
*/

async function findSportmonksFixture(
  home,
  away
) {

  /*
   * 1. Primeiro procura ao vivo.
   */

  try {

    const live =
      await getLiveFixtures();

    const foundLive =
      live.find(
        fixture =>
          fixtureMatches(
            fixture,
            home,
            away
          )
      );

    if (foundLive) {
      return foundLive;
    }

  } catch (error) {

    console.error(
      'Erro ao consultar jogos ao vivo:',
      error.message
    );
  }

  /*
   * 2. Depois procura hoje.
   */

  const today =
    todayISO();

  const todayFixtures =
    await getFixturesByDate(
      today
    );

  const foundToday =
    todayFixtures.find(
      fixture =>
        fixtureMatches(
          fixture,
          home,
          away
        )
    );

  if (foundToday) {
    return foundToday;
  }

  /*
   * 3. Procura os próximos dias.
   */

  const end =
    addDaysISO(
      today,
      7
    );

  const future =
    await getFixturesBetween(
      today,
      end
    );

  const foundFuture =
    future.find(
      fixture =>
        fixtureMatches(
          fixture,
          home,
          away
        )
    );

  return foundFuture || null;
}

/*
========================================================
 LISTA DE JOGOS DO DIA
========================================================
*/

async function getTodayData() {

  const date =
    todayISO();

  const fixtures =
    await getFixturesByDate(
      date
    );

  return {
    date,
    count: fixtures.length,
    fixtures
  };
}

/*
========================================================
 PRÓXIMOS JOGOS
========================================================
*/

async function getUpcomingData(
  days = 7
) {

  const start =
    todayISO();

  const safeDays =
    Math.min(
      Math.max(
        Number(days) || 7,
        1
      ),
      30
    );

  const end =
    addDaysISO(
      start,
      safeDays
    );

  const fixtures =
    await getFixturesBetween(
      start,
      end
    );

  return {
    start,
    end,
    count: fixtures.length,
    fixtures
  };
}

/*
========================================================
 API-FOOTBALL FALLBACK
========================================================
*/

async function findApiFootballFixture(
  home,
  away
) {

  if (!API_FOOTBALL_KEY) {
    return null;
  }

  try {

    const result =
      await apiFootball(
        '/fixtures?live=all'
      );

    const games =
      result.response || [];

    const h =
      normalize(home);

    const a =
      normalize(away);

    return (
      games.find(
        f => {

          const homeName =
            normalize(
              f.teams?.home?.name
            );

          const awayName =
            normalize(
              f.teams?.away?.name
            );

          return (
            homeName === h &&
            awayName === a
          ) || (
            homeName === a &&
            awayName === h
          );
        }
      ) || null
    );

  } catch (error) {

    console.error(
      'Fallback API-Football:',
      error.message
    );

    return null;
  }
}

/*
========================================================
 RESUMO NORMALIZADO
========================================================
*/

function buildMatchSummary(
  fixture
) {

  const teams =
    fixtureTeams(fixture);

  const scores =
    fixture?.scores || [];

  const currentScores =
    scores.filter(
      score =>
        score.description ===
        'CURRENT'
    );

  function scoreFor(
    participantId
  ) {

    const score =
      currentScores.find(
        s =>
          s.participant_id ===
          participantId
      );

    return (
      score?.score?.goals ??
      null
    );
  }

  return {

    id:
      fixture?.id ?? null,

    name:
      fixture?.name ?? null,

    starting_at:
      fixture?.starting_at ?? null,

    timestamp:
      fixture?.starting_at_timestamp ??
      null,

    state:
      fixture?.state || null,

    league:
      fixture?.league || null,

    venue:
      fixture?.venue || null,

    home:
      teams.home
        ? {
            id: teams.home.id,
            name: teams.home.name,
            short_code:
              teams.home.short_code,
            score:
              scoreFor(
                teams.home.id
              )
          }
        : null,

    away:
      teams.away
        ? {
            id: teams.away.id,
            name: teams.away.name,
            short_code:
              teams.away.short_code,
            score:
              scoreFor(
                teams.away.id
              )
          }
        : null,

    has_odds:
      fixture?.has_odds ?? false,

    has_premium_odds:
      fixture?.has_premium_odds ??
      false
  };
}

/*
========================================================
 HTML
========================================================
*/

let html = '';

try {

  html =
    fs.readFileSync(
      path.join(
        __dirname,
        'public',
        'index.html'
      ),
      'utf8'
    );

} catch {

  html =
    `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Live Match Stats V3</title>
    </head>
    <body>
      <h1>Live Match Stats V3</h1>
      <p>Servidor funcionando.</p>
    </body>
    </html>
    `;
}

/*
========================================================
 JSON RESPONSE
========================================================
*/

function json(
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
        'no-store',

      'Access-Control-Allow-Origin':
        '*'
    }
  );

  res.end(
    JSON.stringify(
      data,
      null,
      2
    )
  );
}

/*
========================================================
 SERVIDOR
========================================================
*/

const server =
  http.createServer(
    async (req, res) => {

      try {

        const url =
          new URL(
            req.url,
            'http://localhost'
          );

        /*
        ================================================
        HEALTH CHECK
        ================================================
        */

        if (
          url.pathname ===
          '/api/health'
        ) {

          return json(
            res,
            200,
            {
              ok: true,
              service:
                'Live Match Stats V3',

              sportmonks:
                Boolean(
                  SPORTMONKS_TOKEN
                ),

              apiFootball:
                Boolean(
                  API_FOOTBALL_KEY
                ),

              time:
                new Date()
                  .toISOString()
            }
          );
        }

        /*
        ================================================
        PARTIDA POR ID
        ================================================
        */

        if (
          url.pathname ===
          '/api/fixture'
        ) {

          const id =
            url.searchParams.get(
              'id'
            );

          if (!id) {

            return json(
              res,
              400,
              {
                error:
                  'Informe o ID da partida.'
              }
            );
          }

          const fixture =
            await getSportmonksFixture(
              id
            );

          if (!fixture) {

            return json(
              res,
              404,
              {
                error:
                  'Partida não encontrada.'
              }
            );
          }

          return json(
            res,
            200,
            {
              ok: true,
              source:
                'SportMonks',

              summary:
                buildMatchSummary(
                  fixture
                ),

              data:
                fixture
            }
          );
        }

        /*
        ================================================
        BUSCAR PARTIDA PELOS TIMES
        ================================================
        */

        if (
          url.pathname ===
          '/api/match'
        ) {

          const q =
            url.searchParams.get(
              'q'
            );

          if (!q) {

            return json(
              res,
              400,
              {
                error:
                  'Digite os dois times.'
              }
            );
          }

          const teams =
            parseTeams(q);

          if (!teams) {

            return json(
              res,
              400,
              {
                error:
                  'Use: Time A x Time B'
              }
            );
          }

          const fixture =
            await findSportmonksFixture(
              teams.home,
              teams.away
            );

          /*
           * SportMonks encontrada.
           */

          if (fixture) {

            /*
             * Busca novamente pelo ID com
             * o conjunto completo de dados.
             */

            const complete =
              await getSportmonksFixture(
                fixture.id
              );

            return json(
              res,
              200,
              {
                ok: true,

                source:
                  'SportMonks',

                fixtureId:
                  fixture.id,

                summary:
                  buildMatchSummary(
                    complete ||
                    fixture
                  ),

                data:
                  complete ||
                  fixture
              }
            );
          }

          /*
           * Fallback API-Football.
           */

          const fallback =
            await findApiFootballFixture(
              teams.home,
              teams.away
            );

          if (fallback) {

            return json(
              res,
              200,
              {
                ok: true,

                source:
                  'API-Football',

                fixtureId:
                  fallback.fixture?.id ??
                  null,

                data:
                  fallback
              }
            );
          }

          return json(
            res,
            404,
            {
              error:
                'Partida não encontrada.',
              teams
            }
          );
        }

        /*
        ================================================
        JOGOS DO DIA
        ================================================
        */

        if (
          url.pathname ===
          '/api/today'
        ) {

          const data =
            await getTodayData();

          return json(
            res,
            200,
            {
              ok: true,
              source:
                'SportMonks',
              ...data,

              summaries:
                data.fixtures.map(
                  buildMatchSummary
                )
            }
          );
        }

        /*
        ================================================
        PRÓXIMOS JOGOS
        ================================================
        */

        if (
          url.pathname ===
          '/api/upcoming'
        ) {

          const days =
            url.searchParams.get(
              'days'
            ) || 7;

          const data =
            await getUpcomingData(
              days
            );

          return json(
            res,
            200,
            {
              ok: true,
              source:
                'SportMonks',
              ...data,

              summaries:
                data.fixtures.map(
                  buildMatchSummary
                )
            }
          );
        }

        /*
        ================================================
        AO VIVO
        ================================================
        */

        if (
          url.pathname ===
          '/api/live'
        ) {

          const fixtures =
            await getLiveFixtures();

          return json(
            res,
            200,
            {
              ok: true,
              source:
                'SportMonks',

              count:
                fixtures.length,

              fixtures,

              summaries:
                fixtures.map(
                  buildMatchSummary
                )
            }
          );
        }

        /*
        ================================================
        FRONTEND
        ================================================
        */

        if (
          url.pathname === '/' ||
          url.pathname ===
            '/index.html'
        ) {

          res.writeHead(
            200,
            {
              'Content-Type':
                'text/html; charset=utf-8'
            }
          );

          return res.end(
            html
          );
        }

        /*
        ================================================
        404
        ================================================
        */

        res.writeHead(
          404,
          {
            'Content-Type':
              'application/json'
          }
        );

        res.end(
          JSON.stringify({
            error:
              'Página não encontrada.'
          })
        );

      } catch (error) {

        console.error(
          'ERRO:',
          error
        );

        return json(
          res,
          500,
          {
            ok: false,

            error:
              'Erro ao consultar os dados.',

            details:
              error.message
          }
        );
      }
    }
  );

/*
========================================================
 START
========================================================
*/

server.listen(
  PORT,
  () => {

    console.log(
      `Live Match Stats V3 ativo na porta ${PORT}`
    );

    console.log(
      'SportMonks:',
      SPORTMONKS_TOKEN
        ? 'CONFIGURADA'
        : 'NÃO CONFIGURADA'
    );

    console.log(
      'API-Football:',
      API_FOOTBALL_KEY
        ? 'CONFIGURADA'
        : 'NÃO CONFIGURADA'
    );
  }
);
