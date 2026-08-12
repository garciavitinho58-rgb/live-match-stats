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
 LIVE MATCH STATS V4
========================================================

 Fonte principal:
   SportMonks

 Fonte secundária:
   API-Football

 Objetivos:
   - jogos do dia
   - próximos jogos
   - jogos ao vivo
   - partidas por ID
   - busca por equipes
   - placares
   - eventos
   - estatísticas
   - odds
   - xG quando disponível
   - base preparada para análise automática

 IMPORTANTE:
   Não solicitar "predictions" nos endpoints
   gerais, pois o token atual não possui acesso
   a esse include.
========================================================
*/

/*
========================================================
 UTILIDADES HTTP
========================================================
*/

function requestHttps({
  hostname,
  path: requestPath,
  headers = {},
  timeout = 15000
}) {
  return new Promise((resolve, reject) => {

    const req = https.request(
      {
        hostname,
        path: requestPath,
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
                `HTTP ${res.statusCode}: ${JSON.stringify(json)}`
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
 API-FOOTBALL
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

/*
========================================================
 DATAS
========================================================
*/

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

  const date =
    new Date(
      `${dateString}T00:00:00Z`
    );

  date.setUTCDate(
    date.getUTCDate() + days
  );

  return date
    .toISOString()
    .slice(0, 10);
}

/*
========================================================
 PARSE TIMES
========================================================
*/

function parseTeams(text) {

  const match =
    String(text || '')
      .trim()
      .match(
        /^(.+?)\s+(?:x|vs\.?|versus|-)\s+(.+)$/i
      );

  if (!match) {
    return null;
  }

  return {
    home:
      match[1].trim(),

    away:
      match[2].trim()
  };
}

/*
========================================================
 PARTICIPANTES
========================================================
*/

function fixtureTeams(
  fixture
) {

  const participants =
    fixture?.participants || [];

  let home = null;
  let away = null;

  for (
    const participant
    of participants
  ) {

    const location =
      participant?.meta?.location;

    if (
      location === 'home'
    ) {
      home =
        participant;
    }

    if (
      location === 'away'
    ) {
      away =
        participant;
    }
  }

  return {
    home,
    away
  };
}

/*
========================================================
 COMPARAR TIMES
========================================================
*/

function fixtureMatches(
  fixture,
  home,
  away
) {

  const teams =
    fixtureTeams(
      fixture
    );

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
 INCLUDES SEGUROS
========================================================

 NÃO contém predictions.

 A ideia é evitar que um recurso sem permissão
 bloqueie toda a consulta.
========================================================
*/

const TODAY_INCLUDES =
  [
    'participants',
    'league',
    'state',
    'scores'
  ].join(';');

const LIVE_INCLUDES =
  [
    'participants',
    'league',
    'state',
    'scores',
    'events.type',
    'events.player',
    'statistics'
  ].join(';');

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
    'odds.bookmaker'
  ].join(';');

/*
========================================================
 FIXTURE POR ID
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

  return (
    result?.data ||
    null
  );
}

/*
========================================================
 JOGOS DO DIA
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
        TODAY_INCLUDES
      )}`
    );

  return (
    result?.data ||
    []
  );
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
        TODAY_INCLUDES
      )}`
    );

  return (
    result?.data ||
    []
  );
}

/*
========================================================
 JOGOS AO VIVO
========================================================
*/

async function getLiveFixtures() {

  const result =
    await sportmonks(
      `/v3/football/livescores/inplay?include=${encodeURIComponent(
        LIVE_INCLUDES
      )}`
    );

  return (
    result?.data ||
    []
  );
}

/*
========================================================
 ODDS DE UMA PARTIDA
========================================================

 Separado para que uma limitação de odds não
 impeça a partida de ser carregada.
========================================================
*/

async function getFixtureOdds(
  fixtureId
) {

  try {

    const result =
      await sportmonks(
        `/v3/football/fixtures/${encodeURIComponent(
          fixtureId
        )}?include=${encodeURIComponent(
          'odds.market;odds.bookmaker'
        )}`
      );

    return (
      result?.data?.odds ||
      []
    );

  } catch (error) {

    console.error(
      'Odds indisponíveis:',
      error.message
    );

    return [];
  }
}

/*
========================================================
 ESTATÍSTICAS DE UMA PARTIDA
========================================================
*/

async function getFixtureStatistics(
  fixtureId
) {

  try {

    const result =
      await sportmonks(
        `/v3/football/fixtures/${encodeURIComponent(
          fixtureId
        )}?include=statistics`
      );

    return (
      result?.data?.statistics ||
      []
    );

  } catch (error) {

    console.error(
      'Estatísticas indisponíveis:',
      error.message
    );

    return [];
  }
}

/*
========================================================
 XG DE UMA PARTIDA
========================================================
*/

async function getFixtureXG(
  fixtureId
) {

  try {

    const result =
      await sportmonks(
        `/v3/football/fixtures/${encodeURIComponent(
          fixtureId
        )}?include=xGFixture.type`
      );

    return (
      result?.data?.xgfixture ||
      result?.data?.xGFixture ||
      []
    );

  } catch (error) {

    console.error(
      'xG indisponível:',
      error.message
    );

    return [];
  }
}

/*
========================================================
 BUSCAR PARTIDA
========================================================
*/

async function findSportmonksFixture(
  home,
  away
) {

  /*
   * 1 — AO VIVO
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
      'Erro no ao vivo:',
      error.message
    );
  }

  /*
   * 2 — HOJE
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
   * 3 — PRÓXIMOS 7 DIAS
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

  return (
    future.find(
      fixture =>
        fixtureMatches(
          fixture,
          home,
          away
        )
    ) ||
    null
  );
}

/*
========================================================
 DADOS DO DIA
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
    count:
      fixtures.length,
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
    count:
      fixtures.length,
    fixtures
  };
}

/*
========================================================
 API-FOOTBALL — AO VIVO
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
      result?.response ||
      [];

    const h =
      normalize(home);

    const a =
      normalize(away);

    return (
      games.find(
        game => {

          const homeName =
            normalize(
              game.teams?.home?.name
            );

          const awayName =
            normalize(
              game.teams?.away?.name
            );

          return (
            homeName === h &&
            awayName === a
          ) || (
            homeName === a &&
            awayName === h
          );
        }
      ) ||
      null
    );

  } catch (error) {

    console.error(
      'API-Football fallback:',
      error.message
    );

    return null;
  }
}

/*
========================================================
 RESUMO DA PARTIDA
========================================================
*/

function buildMatchSummary(
  fixture
) {

  const teams =
    fixtureTeams(
      fixture
    );

  const scores =
    fixture?.scores ||
    [];

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
        item =>
          item.participant_id ===
          participantId
      );

    return (
      score?.score?.goals ??
      null
    );
  }

  return {

    id:
      fixture?.id ??
      null,

    name:
      fixture?.name ??
      null,

    starting_at:
      fixture?.starting_at ??
      null,

    timestamp:
      fixture?.starting_at_timestamp ??
      null,

    state:
      fixture?.state ??
      null,

    league:
      fixture?.league ??
      null,

    venue:
      fixture?.venue ??
      null,

    home:
      teams.home
        ? {
            id:
              teams.home.id,

            name:
              teams.home.name,

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
            id:
              teams.away.id,

            name:
              teams.away.name,

            short_code:
              teams.away.short_code,

            score:
              scoreFor(
                teams.away.id
              )
          }
        : null,

    has_odds:
      fixture?.has_odds ??
      false,

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

  html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Live Match Stats V4</title>
</head>
<body>
<h1>Live Match Stats V4</h1>
<p>Servidor funcionando.</p>
</body>
</html>
`;
}

/*
========================================================
 JSON
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
    async (
      req,
      res
    ) => {

      try {

        const url =
          new URL(
            req.url,
            'http://localhost'
          );

        /*
        ================================================
        HEALTH
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
                'Live Match Stats V4',

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
        TODAY
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

              date:
                data.date,

              count:
                data.count,

              fixtures:
                data.fixtures,

              summaries:
                data.fixtures.map(
                  buildMatchSummary
                )
            }
          );
        }

        /*
        ================================================
        UPCOMING
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

              start:
                data.start,

              end:
                data.end,

              count:
                data.count,

              fixtures:
                data.fixtures,

              summaries:
                data.fixtures.map(
                  buildMatchSummary
                )
            }
          );
        }

        /*
        ================================================
        LIVE
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
        FIXTURE POR ID
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
                ok: false,

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
                ok: false,

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

              fixtureId:
                fixture.id,

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
        ODDS POR FIXTURE
        ================================================
        */

        if (
          url.pathname ===
          '/api/odds'
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
                ok: false,

                error:
                  'Informe o ID da partida.'
              }
            );
          }

          const odds =
            await getFixtureOdds(
              id
            );

          return json(
            res,
            200,
            {
              ok: true,

              source:
                'SportMonks',

              fixtureId:
                Number(id),

              count:
                odds.length,

              odds
            }
          );
        }

        /*
        ================================================
        ESTATÍSTICAS POR FIXTURE
        ================================================
        */

        if (
          url.pathname ===
          '/api/statistics'
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
                ok: false,

                error:
                  'Informe o ID da partida.'
              }
            );
          }

          const statistics =
            await getFixtureStatistics(
              id
            );

          return json(
            res,
            200,
            {
              ok: true,

              source:
                'SportMonks',

              fixtureId:
                Number(id),

              count:
                statistics.length,

              statistics
            }
          );
        }

        /*
        ================================================
        XG POR FIXTURE
        ================================================
        */

        if (
          url.pathname ===
          '/api/xg'
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
                ok: false,

                error:
                  'Informe o ID da partida.'
              }
            );
          }

          const xg =
            await getFixtureXG(
              id
            );

          return json(
            res,
            200,
            {
              ok: true,

              source:
                'SportMonks',

              fixtureId:
                Number(id),

              count:
                xg.length,

              xg
            }
          );
        }

        /*
        ================================================
        BUSCAR PARTIDA POR TIMES
        ================================================
        */

        if (
          url.pathname ===
          '/api/match'
        ) {

          const query =
            url.searchParams.get(
              'q'
            );

          if (!query) {

            return json(
              res,
              400,
              {
                ok: false,

                error:
                  'Digite os dois times.'
              }
            );
          }

          const teams =
            parseTeams(
              query
            );

          if (!teams) {

            return json(
              res,
              400,
              {
                ok: false,

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

          if (fixture) {

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
           * Fallback API-Football
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
              ok: false,

              error:
                'Partida não encontrada.',

              teams
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

        return json(
          res,
          404,
          {
            ok: false,

            error:
              'Página não encontrada.'
          }
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
      `Live Match Stats V4 ativo na porta ${PORT}`
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
