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
 LIVE MATCH STATS V5
========================================================

 Objetivo:

 - coleta automática
 - dados pré-jogo
 - dados ao vivo
 - odds
 - estatísticas quando disponíveis
 - xG quando disponível no plano
 - motor inicial de análise

 IMPORTANTE:
 Não usamos "predictions", pois o plano atual
 retornou HTTP 403 para esse include.

========================================================
*/

/*
========================================================
 HTTP
========================================================
*/

function requestHttps({
  hostname,
  path: requestPath,
  headers = {},
  timeout = 20000
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
        new Error(
          'Timeout da API.'
        )
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

function sportmonks(endpoint) {

  if (!SPORTMONKS_TOKEN) {
    throw new Error(
      'SPORTMONKS_API_TOKEN não configurada no Render.'
    );
  }

  const separator =
    endpoint.includes('?')
      ? '&'
      : '?';

  const finalEndpoint =
    endpoint +
    separator +
    'api_token=' +
    encodeURIComponent(
      SPORTMONKS_TOKEN
    );

  return requestHttps({
    hostname:
      SPORTMONKS_HOST,

    path:
      finalEndpoint
  });
}

/*
========================================================
 API FOOTBALL
========================================================
*/

function apiFootball(endpoint) {

  if (!API_FOOTBALL_KEY) {
    throw new Error(
      'API_FOOTBALL_KEY não configurada.'
    );
  }

  return requestHttps({
    hostname:
      API_FOOTBALL_HOST,

    path:
      endpoint,

    headers: {
      'x-apisports-key':
        API_FOOTBALL_KEY
    }
  });
}

/*
========================================================
 UTILIDADES
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

function fixtureTeams(fixture) {

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

  const requestedHome =
    normalize(home);

  const requestedAway =
    normalize(away);

  const fixtureHome =
    normalize(
      teams.home.name
    );

  const fixtureAway =
    normalize(
      teams.away.name
    );

  return (
    fixtureHome === requestedHome &&
    fixtureAway === requestedAway
  ) || (
    fixtureHome === requestedAway &&
    fixtureAway === requestedHome
  );
}

/*
========================================================
 INCLUDES V5
========================================================

 NÃO incluir predictions.

 Mantemos somente recursos que já fazem sentido
 para o sistema atual.
========================================================
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
    'lineups.player',
    'lineups.xGlineup.type',
    'xGFixture.type'
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
 JOGOS POR DATA
========================================================
*/

async function getFixturesByDate(
  date
) {

  const includes =
    [
      'participants',
      'league',
      'venue',
      'state',
      'scores',
      'odds.market',
      'odds.bookmaker'
    ].join(';');

  const result =
    await sportmonks(
      `/v3/football/fixtures/date/${encodeURIComponent(
        date
      )}?include=${encodeURIComponent(
        includes
      )}`
    );

  return (
    result?.data ||
    []
  );
}

/*
========================================================
 JOGOS ENTRE DATAS
========================================================
*/

async function getFixturesBetween(
  start,
  end
) {

  const includes =
    [
      'participants',
      'league',
      'venue',
      'state',
      'scores',
      'odds.market',
      'odds.bookmaker'
    ].join(';');

  const result =
    await sportmonks(
      `/v3/football/fixtures/between/${encodeURIComponent(
        start
      )}/${encodeURIComponent(
        end
      )}?include=${encodeURIComponent(
        includes
      )}`
    );

  return (
    result?.data ||
    []
  );
}

/*
========================================================
 AO VIVO
========================================================
*/

async function getLiveFixtures() {

  const includes =
    [
      'participants',
      'league',
      'venue',
      'state',
      'scores',
      'events.type',
      'events.player',
      'statistics',
      'odds.market',
      'odds.bookmaker'
    ].join(';');

  const result =
    await sportmonks(
      `/v3/football/livescores/inplay?include=${encodeURIComponent(
        includes
      )}`
    );

  return (
    result?.data ||
    []
  );
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
   * 1. AO VIVO
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
      'Erro ao consultar ao vivo:',
      error.message
    );
  }

  /*
   * 2. HOJE
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
   * 3. PRÓXIMOS 7 DIAS
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
 API FOOTBALL FALLBACK
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
      result?.response || [];

    const requestedHome =
      normalize(home);

    const requestedAway =
      normalize(away);

    return (
      games.find(
        game => {

          const gameHome =
            normalize(
              game.teams?.home?.name
            );

          const gameAway =
            normalize(
              game.teams?.away?.name
            );

          return (
            gameHome === requestedHome &&
            gameAway === requestedAway
          ) || (
            gameHome === requestedAway &&
            gameAway === requestedHome
          );
        }
      ) ||
      null
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
 SCORE
========================================================
*/

function scoreForParticipant(
  fixture,
  participantId
) {

  const scores =
    fixture?.scores || [];

  const current =
    scores.find(
      score =>
        score.description ===
          'CURRENT' &&
        score.participant_id ===
          participantId
    );

  return (
    current?.score?.goals ??
    null
  );
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
              scoreForParticipant(
                fixture,
                teams.home.id
              ),

            position:
              teams.home.meta?.position ??
              null
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
              scoreForParticipant(
                fixture,
                teams.away.id
              ),

            position:
              teams.away.meta?.position ??
              null
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
 ODDS
========================================================

 A estrutura pode variar de acordo com mercado,
 bookmaker e versão da resposta.

 O código abaixo procura de forma defensiva.
========================================================
*/

function flattenOdds(
  fixture
) {

  const odds =
    fixture?.odds || [];

  const result = [];

  for (
    const odd
    of odds
  ) {

    const market =
      odd?.market || {};

    const bookmaker =
      odd?.bookmaker || {};

    result.push({

      id:
        odd?.id ??
        null,

      market_id:
        odd?.market_id ??
        market?.id ??
        null,

      market_name:
        market?.name ??
        market?.developer_name ??
        null,

      market_code:
        market?.code ??
        market?.developer_name ??
        null,

      bookmaker_id:
        odd?.bookmaker_id ??
        bookmaker?.id ??
        null,

      bookmaker_name:
        bookmaker?.name ??
        null,

      label:
        odd?.label ??
        odd?.name ??
        odd?.value ??
        null,

      value:
        odd?.value ??
        null,

      odd:
        odd?.odd ??
        odd?.decimal ??
        odd?.price ??
        null,

      handicap:
        odd?.handicap ??
        null,

      total:
        odd?.total ??
        null
    });
  }

  return result;
}

/*
========================================================
 IDENTIFICAR MERCADO
========================================================
*/

function marketText(
  odd
) {

  return normalize(
    [
      odd.market_name,
      odd.market_code,
      odd.label,
      odd.value
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function classifyOddMarket(
  odd
) {

  const text =
    marketText(odd);

  if (
    text.includes('double chance') ||
    text.includes('dupla chance')
  ) {
    return 'DOUBLE_CHANCE';
  }

  if (
    text.includes('both teams') ||
    text.includes('both team') ||
    text.includes('btts') ||
    text.includes('ambas')
  ) {
    return 'BTTS';
  }

  if (
    text.includes('correct score') ||
    text.includes('placar correto')
  ) {
    return 'CORRECT_SCORE';
  }

  if (
    text.includes('over under') ||
    text.includes('goals over') ||
    text.includes('goals under') ||
    text.includes('total goals') ||
    text.includes('total de gols') ||
    text.includes('over') ||
    text.includes('under')
  ) {
    return 'GOALS_TOTAL';
  }

  if (
    text.includes('corner') ||
    text.includes('corners') ||
    text.includes('escanteio') ||
    text.includes('escanteios')
  ) {
    return 'CORNERS';
  }

  if (
    text.includes('handicap')
  ) {
    return 'HANDICAP';
  }

  if (
    text === '1' ||
    text === 'x' ||
    text === '2' ||
    text.includes('match winner') ||
    text.includes('winner') ||
    text.includes('full time result') ||
    text.includes('home win') ||
    text.includes('away win') ||
    text.includes('draw')
  ) {
    return 'RESULT';
  }

  return 'OTHER';
}

/*
========================================================
 MERCADOS ORGANIZADOS
========================================================
*/

function organizeMarkets(
  fixture
) {

  const odds =
    flattenOdds(fixture);

  const markets = {
    result: [],
    goals: [],
    btts: [],
    handicap: [],
    corners: [],
    doubleChance: [],
    correctScore: [],
    other: []
  };

  for (
    const odd
    of odds
  ) {

    const type =
      classifyOddMarket(odd);

    if (
      type === 'RESULT'
    ) {
      markets.result.push(odd);
    }

    else if (
      type === 'GOALS_TOTAL'
    ) {
      markets.goals.push(odd);
    }

    else if (
      type === 'BTTS'
    ) {
      markets.btts.push(odd);
    }

    else if (
      type === 'HANDICAP'
    ) {
      markets.handicap.push(odd);
    }

    else if (
      type === 'CORNERS'
    ) {
      markets.corners.push(odd);
    }

    else if (
      type === 'DOUBLE_CHANCE'
    ) {
      markets.doubleChance.push(odd);
    }

    else if (
      type === 'CORRECT_SCORE'
    ) {
      markets.correctScore.push(odd);
    }

    else {
      markets.other.push(odd);
    }
  }

  return markets;
}

/*
========================================================
 ESTATÍSTICAS
========================================================
*/

function statisticsAvailable(
  fixture
) {

  const statistics =
    fixture?.statistics;

  return (
    Array.isArray(statistics) &&
    statistics.length > 0
  );
}

/*
========================================================
 EVENTOS
========================================================
*/

function eventsAvailable(
  fixture
) {

  const events =
    fixture?.events;

  return (
    Array.isArray(events) &&
    events.length > 0
  );
}

/*
========================================================
 XG
========================================================
*/

function xgAvailable(
  fixture
) {

  const xg =
    fixture?.xGFixture;

  return (
    Array.isArray(xg) &&
    xg.length > 0
  ) || Boolean(xg);
}

/*
========================================================
 DADOS DISPONÍVEIS
========================================================
*/

function dataQuality(
  fixture,
  markets
) {

  const checks = {

    teams:
      Boolean(
        fixture?.participants?.length >= 2
      ),

    league:
      Boolean(
        fixture?.league
      ),

    state:
      Boolean(
        fixture?.state
      ),

    score:
      Boolean(
        fixture?.scores?.length
      ),

    odds:
      Object.values(markets)
        .some(
          list =>
            Array.isArray(list) &&
            list.length > 0
        ),

    statistics:
      statisticsAvailable(
        fixture
      ),

    events:
      eventsAvailable(
        fixture
      ),

    xg:
      xgAvailable(
        fixture
      )
  };

  const weights = {

    teams: 15,
    league: 10,
    state: 10,
    score: 10,
    odds: 25,
    statistics: 15,
    events: 5,
    xg: 10
  };

  let total = 0;
  let maximum = 0;

  for (
    const key
    of Object.keys(weights)
  ) {

    maximum +=
      weights[key];

    if (checks[key]) {
      total +=
        weights[key];
    }
  }

  const score =
    Math.round(
      (
        total /
        maximum
      ) * 100
    );

  return {
    score,
    checks
  };
}

/*
========================================================
 CLASSIFICAÇÃO
========================================================
*/

function classifyData(
  quality
) {

  if (
    quality < 35
  ) {
    return 'DADOS_INSUFICIENTES';
  }

  if (
    quality < 55
  ) {
    return 'NEUTRO';
  }

  if (
    quality < 75
  ) {
    return 'INTERESSANTE';
  }

  return 'FORTE';
}

/*
========================================================
 MOTOR DE ANÁLISE V5
========================================================

 IMPORTANTE:

 Este score NÃO é uma probabilidade de vitória.

 É um indicador da quantidade/qualidade dos dados
 disponíveis para análise.

 A próxima versão poderá calcular probabilidades
 estatísticas utilizando histórico.
========================================================
*/

function analyzeFixture(
  fixture
) {

  const summary =
    buildMatchSummary(
      fixture
    );

  const markets =
    organizeMarkets(
      fixture
    );

  const quality =
    dataQuality(
      fixture,
      markets
    );

  const classification =
    classifyData(
      quality.score
    );

  const marketCounts = {

    result:
      markets.result.length,

    goals:
      markets.goals.length,

    btts:
      markets.btts.length,

    handicap:
      markets.handicap.length,

    corners:
      markets.corners.length,

    doubleChance:
      markets.doubleChance.length,

    correctScore:
      markets.correctScore.length,

    other:
      markets.other.length
  };

  return {

    fixture:
      summary,

    analysis: {

      data_quality:
        quality.score,

      classification,

      live:
        Boolean(
          fixture?.state?.state === 'LIVE' ||
          fixture?.state?.state === 'INPLAY'
        ),

      market_counts:
        marketCounts,

      available_data: {

        odds:
          quality.checks.odds,

        statistics:
          quality.checks.statistics,

        events:
          quality.checks.events,

        xg:
          quality.checks.xg
      },

      note:
        'O score representa qualidade/quantidade de dados disponíveis. Não representa probabilidade de vitória.'
    },

    markets,

    raw_data_flags: {

      participants:
        Array.isArray(
          fixture?.participants
        )
          ? fixture.participants.length
          : 0,

      scores:
        Array.isArray(
          fixture?.scores
        )
          ? fixture.scores.length
          : 0,

      events:
        Array.isArray(
          fixture?.events
        )
          ? fixture.events.length
          : 0,

      statistics:
        Array.isArray(
          fixture?.statistics
        )
          ? fixture.statistics.length
          : 0,

      odds:
        Array.isArray(
          fixture?.odds
        )
          ? fixture.odds.length
          : 0
    }
  };
}

/*
========================================================
 FRONTEND
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
<title>Live Match Stats V5</title>
</head>
<body>
<h1>Live Match Stats V5</h1>
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
                'Live Match Stats V5',

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
        FIXTURE
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
        ANALYZE
        ================================================
        */

        if (
          url.pathname ===
          '/api/analyze'
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

              ...analyzeFixture(
                fixture
              )
            }
          );
        }

        /*
        ================================================
        MATCH
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
        TODAY ANALYZED
        ================================================
        */

        if (
          url.pathname ===
          '/api/today-analyzed'
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

              matches:
                data.fixtures.map(
                  analyzeFixture
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
        UPCOMING ANALYZED
        ================================================
        */

        if (
          url.pathname ===
          '/api/upcoming-analyzed'
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

              matches:
                data.fixtures.map(
                  analyzeFixture
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
        LIVE ANALYZED
        ================================================
        */

        if (
          url.pathname ===
          '/api/live-analyzed'
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

              matches:
                fixtures.map(
                  analyzeFixture
                )
            }
          );
        }

        /*
        ================================================
        ROOT
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
      `Live Match Stats V5 ativo na porta ${PORT}`
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
