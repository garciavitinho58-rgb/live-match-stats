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
 LIVE MATCH STATS V6
========================================================

Objetivos desta versão:

1. Manter os endpoints anteriores.
2. Remover "predictions" do SportMonks,
   pois o plano atual não possui acesso.
3. Criar /api/analyze
   para transformar o JSON gigante da partida
   em uma análise compacta.
4. Extrair odds de forma genérica.
5. Calcular probabilidades implícitas.
6. Identificar mercados com maior consenso.
7. Preparar a base para o motor autônomo.
========================================================
*/

/*
========================================================
 UTILIDADES HTTP
========================================================
*/

function requestHttps({
  hostname,
  path,
  headers = {},
  timeout = 20000
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
    return null;
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

function numberOrNull(value) {

  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
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
 SPORTMONKS INCLUDES
========================================================

IMPORTANTE:

Não usamos "predictions" porque o plano atual
retornou HTTP 403 para esse include.

Mantemos apenas relacionamentos que já funcionaram
no ambiente do projeto.
========================================================
*/

const BASIC_INCLUDES =
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
        BASIC_INCLUDES
      )}`
    );

  return result?.data || null;
}

/*
========================================================
 JOGOS POR DATA
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
        'participants;league;state;scores;odds.market;odds.bookmaker'
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
        'participants;league;state;scores;odds.market;odds.bookmaker'
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
        LIVE_INCLUDES
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
      'Erro ao consultar jogos ao vivo:',
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
    ) || null
  );
}

/*
========================================================
 DADOS DE HOJE
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
      result?.response || [];

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
 SCORE
========================================================
*/

function getCurrentScore(
  fixture
) {

  const teams =
    fixtureTeams(fixture);

  const scores =
    fixture?.scores || [];

  const currentScores =
    scores.filter(
      score =>
        score?.description ===
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

    home:
      teams.home
        ? scoreFor(
            teams.home.id
          )
        : null,

    away:
      teams.away
        ? scoreFor(
            teams.away.id
          )
        : null
  };
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

  const score =
    getCurrentScore(
      fixture
    );

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
            id:
              teams.home.id,
            name:
              teams.home.name,
            short_code:
              teams.home.short_code,
            score:
              score.home
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
              score.away
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
 EXTRAÇÃO DE ODDS
========================================================

A estrutura das odds pode variar conforme:
- bookmaker
- mercado
- versão
- plano

Por isso não dependemos de um único formato.

Percorremos recursivamente os objetos procurando
estruturas que pareçam odds.
========================================================
*/

function extractOdds(
  fixture
) {

  const output = [];

  const visited =
    new WeakSet();

  function walk(
    node,
    context = {}
  ) {

    if (
      node === null ||
      node === undefined
    ) {
      return;
    }

    if (
      typeof node !== 'object'
    ) {
      return;
    }

    if (visited.has(node)) {
      return;
    }

    visited.add(node);

    /*
     * Estrutura de odd individual.
     */

    const value =
      node.value ??
      node.odds ??
      node.price ??
      node.odd ??
      null;

    const numericValue =
      numberOrNull(
        value
      );

    if (
      numericValue !== null &&
      numericValue > 1 &&
      numericValue < 1000
    ) {

      const label =
        node.label ??
        node.name ??
        node.bet ??
        node.selection ??
        node.handicap ??
        null;

      const bookmaker =
        node.bookmaker?.name ??
        node.bookmaker_name ??
        context.bookmaker ??
        null;

      const market =
        node.market?.name ??
        node.market_name ??
        context.market ??
        context.bet ??
        null;

      if (
        label ||
        market ||
        bookmaker
      ) {

        output.push({
          bookmaker,
          market,
          selection:
            label,
          value:
            numericValue,
          implied_probability:
            Number(
              (
                1 /
                numericValue *
                100
              ).toFixed(2)
            )
        });
      }
    }

    /*
     * Contexto de bookmaker.
     */

    let nextContext =
      {
        ...context
      };

    if (
      node.bookmaker?.name
    ) {

      nextContext.bookmaker =
        node.bookmaker.name;
    }

    if (
      node.name &&
      (
        node.market ||
        node.bet
      )
    ) {

      nextContext.market =
        node.name;
    }

    if (
      node.market?.name
    ) {

      nextContext.market =
        node.market.name;
    }

    if (
      node.bet?.name
    ) {

      nextContext.market =
        node.bet.name;
    }

    for (
      const key of Object.keys(node)
    ) {

      /*
       * Não precisamos percorrer imagens
       * e URLs.
       */

      if (
        key === 'image_path' ||
        key === 'url'
      ) {
        continue;
      }

      walk(
        node[key],
        nextContext
      );
    }
  }

  walk(
    fixture?.odds
  );

  /*
   * Remove duplicatas.
   */

  const unique =
    [];

  const seen =
    new Set();

  for (
    const odd of output
  ) {

    const key =
      [
        odd.bookmaker,
        odd.market,
        odd.selection,
        odd.value
      ]
        .join('|');

    if (
      !seen.has(key)
    ) {

      seen.add(key);

      unique.push(
        odd
      );
    }
  }

  return unique;
}

/*
========================================================
 ESTATÍSTICAS
========================================================
*/

function extractStatistics(
  fixture
) {

  const statistics =
    fixture?.statistics || [];

  const result =
    [];

  for (
    const teamBlock of statistics
  ) {

    const team =
      teamBlock?.participant ??
      teamBlock?.team ??
      null;

    const teamName =
      team?.name ??
      teamBlock?.name ??
      null;

    const values =
      teamBlock?.statistics ??
      teamBlock?.data ??
      [];

    const normalized =
      {};

    if (
      Array.isArray(values)
    ) {

      for (
        const item of values
      ) {

        const name =
          item?.type ??
          item?.name ??
          item?.statistic ??
          null;

        const value =
          item?.data?.value ??
          item?.value ??
          null;

        if (name) {
          normalized[name] =
            value;
        }
      }

    } else if (
      values &&
      typeof values ===
        'object'
    ) {

      Object.assign(
        normalized,
        values
      );
    }

    result.push({
      team:
        teamName,
      statistics:
        normalized
    });
  }

  return result;
}

/*
========================================================
 EVENTOS
========================================================
*/

function extractEvents(
  fixture
) {

  const events =
    fixture?.events || [];

  return events.map(
    event => ({

      id:
        event?.id ??
        null,

      minute:
        event?.minute ??
        event?.time?.minute ??
        null,

      extra_minute:
        event?.extra_minute ??
        event?.time?.extra ??
        null,

      type:
        event?.type?.name ??
        event?.type ??
        null,

      player:
        event?.player?.name ??
        null,

      related_player:
        event?.related_player?.name ??
        null,

      result:
        event?.result ??
        null
    })
  );
}

/*
========================================================
 MÉTRICAS DAS ODDS
========================================================
*/

function groupOdds(
  odds
) {

  const groups =
    new Map();

  for (
    const odd of odds
  ) {

    const market =
      odd.market ||
      'unknown';

    const selection =
      odd.selection ||
      'unknown';

    const key =
      `${market}|||${selection}`;

    if (
      !groups.has(key)
    ) {

      groups.set(
        key,
        {
          market,
          selection,
          odds: []
        }
      );
    }

    groups
      .get(key)
      .odds
      .push(odd);
  }

  const result =
    [];

  for (
    const group of groups.values()
  ) {

    const values =
      group.odds
        .map(
          x =>
            numberOrNull(
              x.value
            )
        )
        .filter(
          x =>
            x !== null &&
            x > 1
        );

    if (!values.length) {
      continue;
    }

    const average =
      values.reduce(
        (a, b) =>
          a + b,
        0
      ) /
      values.length;

    const best =
      Math.max(
        ...values
      );

    const impliedAverage =
      1 /
      average;

    result.push({

      market:
        group.market,

      selection:
        group.selection,

      bookmakers:
        group.odds.length,

      average_odd:
        Number(
          average.toFixed(3)
        ),

      best_odd:
        Number(
          best.toFixed(3)
        ),

      implied_probability_average:
        Number(
          (
            impliedAverage *
            100
          ).toFixed(2)
        ),

      odds:
        group.odds
    });
  }

  return result;
}

/*
========================================================
 MERCADOS IMPORTANTES
========================================================
*/

function classifyMarket(
  market,
  selection
) {

  const text =
    normalize(
      `${market || ''} ${selection || ''}`
    );

  if (
    text.includes('match winner') ||
    text.includes('1x2') ||
    text === 'winner'
  ) {

    return 'match_winner';
  }

  if (
    text.includes('over') ||
    text.includes('under')
  ) {

    return 'goals_over_under';
  }

  if (
    text.includes('both teams') ||
    text.includes('btts') ||
    text.includes('both to score')
  ) {

    return 'btts';
  }

  if (
    text.includes('double chance')
  ) {

    return 'double_chance';
  }

  if (
    text.includes('handicap')
  ) {

    return 'handicap';
  }

  if (
    text.includes('corner')
  ) {

    return 'corners';
  }

  if (
    text.includes('cards') ||
    text.includes('card')
  ) {

    return 'cards';
  }

  return 'other';
}

function buildMarketSummary(
  groupedOdds
) {

  const markets =
    {};

  for (
    const item of groupedOdds
  ) {

    const category =
      classifyMarket(
        item.market,
        item.selection
      );

    if (
      !markets[category]
    ) {

      markets[category] =
        [];
    }

    markets[category]
      .push(item);
  }

  return markets;
}

/*
========================================================
 CONSENSO
========================================================
*/

function calculateConsensus(
  groupedOdds
) {

  const result =
    [];

  for (
    const item of groupedOdds
  ) {

    if (
      item.bookmakers < 2
    ) {
      continue;
    }

    const probabilities =
      item.odds
        .map(
          odd =>
            numberOrNull(
              odd.implied_probability
            )
        )
        .filter(
          x =>
            x !== null
        );

    if (
      !probabilities.length
    ) {
      continue;
    }

    const average =
      probabilities.reduce(
        (a, b) =>
          a + b,
        0
      ) /
      probabilities.length;

    const min =
      Math.min(
        ...probabilities
      );

    const max =
      Math.max(
        ...probabilities
      );

    const spread =
      max - min;

    result.push({

      market:
        item.market,

      selection:
        item.selection,

      bookmakers:
        item.bookmakers,

      probability_average:
        Number(
          average.toFixed(2)
        ),

      probability_min:
        Number(
          min.toFixed(2)
        ),

      probability_max:
        Number(
          max.toFixed(2)
        ),

      spread:
        Number(
          spread.toFixed(2)
        ),

      confidence:

        average >= 70
          ? 'alta'
          :
        average >= 55
          ? 'media'
          :
        'baixa'
    });
  }

  return result
    .sort(
      (a, b) =>
        b.probability_average -
        a.probability_average
    );
}

/*
========================================================
 ANÁLISE DA PARTIDA
========================================================
*/

function analyzeFixture(
  fixture
) {

  const summary =
    buildMatchSummary(
      fixture
    );

  const odds =
    extractOdds(
      fixture
    );

  const groupedOdds =
    groupOdds(
      odds
    );

  const statistics =
    extractStatistics(
      fixture
    );

  const events =
    extractEvents(
      fixture
    );

  const consensus =
    calculateConsensus(
      groupedOdds
    );

  const marketSummary =
    buildMarketSummary(
      groupedOdds
    );

  const score =
    getCurrentScore(
      fixture
    );

  const isLive =
    fixture?.state?.state ===
      'LIVE' ||
    fixture?.state?.short_name ===
      'LIVE' ||
    fixture?.state?.developer_name ===
      'LIVE' ||
    Boolean(
      fixture?.periods?.current
    );

  return {

    engine:
      'Live Match Stats V6',

    generated_at:
      new Date().toISOString(),

    fixture:
      summary,

    status: {

      live:
        isLive,

      state:
        fixture?.state || null,

      score,

      events:
        events.length
    },

    statistics,

    odds: {

      total:
        odds.length,

      grouped:
        groupedOdds.length,

      markets:
        marketSummary
    },

    consensus,

    signals:
      buildSignals(
        fixture,
        consensus,
        statistics
      )
  };
}

/*
========================================================
 SINAIS
========================================================

ATENÇÃO:

Aqui ainda não estamos prometendo resultado.

O objetivo desta V6 é criar sinais estatísticos
iniciais.

O modelo definitivo será construído depois,
com histórico + forma + estatísticas + odds.
========================================================
*/

function buildSignals(
  fixture,
  consensus,
  statistics
) {

  const signals =
    [];

  /*
   * Mercado com maior probabilidade implícita.
   */

  const highProbability =
    consensus.filter(
      item =>
        item.probability_average >=
        65 &&
        item.bookmakers >= 2
    );

  for (
    const item of
    highProbability.slice(
      0,
      10
    )
  ) {

    signals.push({

      type:
        'market_consensus',

      strength:
        item.probability_average >=
        75
          ? 'alta'
          : 'media',

      market:
        item.market,

      selection:
        item.selection,

      probability:
        item.probability_average,

      bookmakers:
        item.bookmakers,

      note:
        'Probabilidade implícita média das odds. Não representa garantia de resultado.'
    });
  }

  /*
   * Se houver estatísticas, sinalizamos
   * que a partida possui dados para análise.
   */

  if (
    statistics.length > 0
  ) {

    signals.push({

      type:
        'statistics_available',

      strength:
        'informativo',

      note:
        'Existem estatísticas disponíveis para complementar a análise.'
    });
  }

  /*
   * Odds disponíveis.
   */

  if (
    fixture?.has_odds
  ) {

    signals.push({

      type:
        'odds_available',

      strength:
        'informativo',

      note:
        'A partida possui odds disponíveis na fonte.'
    });
  }

  return signals;
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

  html =
    `
    <!DOCTYPE html>

    <html>

    <head>

      <meta charset="utf-8">

      <meta
        name="viewport"
        content="width=device-width, initial-scale=1"
      >

      <title>
        Live Match Stats V6
      </title>

    </head>

    <body>

      <h1>
        Live Match Stats V6
      </h1>

      <p>
        Servidor funcionando.
      </p>

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
    async (req, res) => {

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

              ok:
                true,

              service:
                'Live Match Stats V6',

              sportmonks:
                Boolean(
                  SPORTMONKS_TOKEN
                ),

              apiFootball:
                Boolean(
                  API_FOOTBALL_KEY
                ),

              analysis:
                true,

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
                ok:
                  false,

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
                ok:
                  false,

                error:
                  'Partida não encontrada.'
              }
            );
          }

          return json(
            res,
            200,
            {

              ok:
                true,

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

                ok:
                  false,

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

                ok:
                  false,

                error:
                  'Partida não encontrada.'
              }
            );
          }

          const analysis =
            analyzeFixture(
              fixture
            );

          return json(
            res,
            200,
            {

              ok:
                true,

              source:
                'SportMonks',

              fixtureId:
                fixture.id,

              analysis
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
                ok:
                  false,

                error:
                  'Digite os dois times.'
              }
            );
          }

          const teams =
            parseTeams(
              q
            );

          if (!teams) {

            return json(
              res,
              400,
              {
                ok:
                  false,

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

            const finalFixture =
              complete ||
              fixture;

            return json(
              res,
              200,
              {

                ok:
                  true,

                source:
                  'SportMonks',

                fixtureId:
                  fixture.id,

                summary:
                  buildMatchSummary(
                    finalFixture
                  ),

                data:
                  finalFixture
              }
            );
          }

          /*
           * Fallback.
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

                ok:
                  true,

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

              ok:
                false,

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

              ok:
                true,

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

              ok:
                true,

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

              ok:
                true,

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
        SCAN
        ================================================

        Endpoint inicial do futuro motor autônomo.

        Ele analisa os jogos encontrados em uma janela
        e devolve somente os sinais principais.
        ================================================
        */

        if (
          url.pathname ===
          '/api/scan'
        ) {

          const days =
            url.searchParams.get(
              'days'
            ) || 7;

          const safeDays =
            Math.min(
              Math.max(
                Number(days) || 7,
                1
              ),
              14
            );

          const start =
            todayISO();

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

          const results =
            [];

          for (
            const fixture
            of fixtures
          ) {

            try {

              const analysis =
                analyzeFixture(
                  fixture
                );

              const usefulSignals =
                analysis.signals
                  .filter(
                    signal =>
                      signal.type ===
                      'market_consensus'
                  );

              results.push({

                fixture:
                  analysis.fixture,

                signals:
                  usefulSignals
              });

            } catch (error) {

              results.push({

                fixture:
                  buildMatchSummary(
                    fixture
                  ),

                signals:
                  [],

                error:
                  error.message
              });
            }
          }

          return json(
            res,
            200,
            {

              ok:
                true,

              source:
                'SportMonks',

              engine:
                'Live Match Stats V6',

              start,

              end,

              count:
                results.length,

              results
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

            ok:
              false,

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

            ok:
              false,

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
      `Live Match Stats V6 ativo na porta ${PORT}`
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

    console.log(
      'Analysis Engine:',
      'ATIVO'
    );

    console.log(
      'Prediction include:',
      'DESATIVADO'
    );
  }
);
