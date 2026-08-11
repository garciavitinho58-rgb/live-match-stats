const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;

const API_HOST = 'v3.football.api-sports.io';

function api(endpoint) {
  return new Promise((resolve, reject) => {

    if (!API_KEY) {
      reject(new Error('API_FOOTBALL_KEY não configurada.'));
      return;
    }

    const req = https.request({
      hostname: API_HOST,
      path: endpoint,
      method: 'GET',
      headers: {
        'x-apisports-key': API_KEY,
        'Accept': 'application/json'
      }
    }, res => {

      let body = '';

      res.on('data', chunk => {
        body += chunk;
      });

      res.on('end', () => {

        try {

          const json = JSON.parse(body);

          if (json.errors &&
              Object.keys(json.errors).length) {

            reject(
              new Error(
                JSON.stringify(json.errors)
              )
            );

            return;
          }

          resolve(json);

        } catch (e) {

          reject(
            new Error(
              'Resposta inválida da API-Football.'
            )
          );
        }
      });
    });

    req.on('error', reject);

    req.setTimeout(10000, () => {
      req.destroy();
      reject(
        new Error('Timeout da API-Football.')
      );
    });

    req.end();
  });
}

function normalize(text) {

  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function parseTeams(text) {

  const m = String(text || '')
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

async function findTeam(name) {

  const result =
    await api(
      '/teams?search=' +
      encodeURIComponent(name)
    );

  const list =
    result.response || [];

  if (!list.length) {
    throw new Error(
      'Time não encontrado: ' + name
    );
  }

  const exact =
    list.find(
      x =>
        normalize(x.team.name) ===
        normalize(name)
    );

  return (
    exact || list[0]
  ).team;
}

async function findLiveFixture(home, away) {

  const result =
    await api('/fixtures?live=all');

  const games =
    result.response || [];

  const h =
    normalize(home);

  const a =
    normalize(away);

  const game =
    games.find(f => {

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
      ) ||
      (
        homeName === a &&
        awayName === h
      );
    });

  return game || null;
}

async function findFixture(home, away) {

  /*
   * PRIMEIRO:
   * tenta encontrar a partida ao vivo.
   */

  const live =
    await findLiveFixture(
      home,
      away
    );

  if (live) {
    return live;
  }

  /*
   * SEGUNDO:
   * usa a data atual.
   *
   * O plano gratuito permite
   * a janela indicada pela API.
   */

  const today =
    new Date();

  const yyyy =
    today.getFullYear();

  const mm =
    String(
      today.getMonth() + 1
    ).padStart(2, '0');

  const dd =
    String(
      today.getDate()
    ).padStart(2, '0');

  const date =
    `${yyyy}-${mm}-${dd}`;

  const result =
    await api(
      '/fixtures?date=' + date
    );

  const games =
    result.response || [];

  const h =
    normalize(home);

  const a =
    normalize(away);

  const game =
    games.find(f => {

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
      ) ||
      (
        homeName === a &&
        awayName === h
      );
    });

  return game || null;
}

async function matchData(fixtureId) {

  const fixture =
    await api(
      '/fixtures?id=' +
      fixtureId
    );

  const statistics =
    await api(
      '/fixtures/statistics?fixture=' +
      fixtureId
    );

  const events =
    await api(
      '/fixtures/events?fixture=' +
      fixtureId
    );

  return {

    fixture:
      fixture.response?.[0] || null,

    statistics:
      statistics.response || [],

    events:
      events.response || []
  };
}

const html =
  fs.readFileSync(
    path.join(
      __dirname,
      'public',
      'index.html'
    ),
    'utf8'
  );

function json(res, status, data) {

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
            'http://localhost'
          );

        if (
          url.pathname ===
          '/api/match'
        ) {

          const q =
            url.searchParams.get('q');

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
                  'Use o formato: Time A x Time B'
              }
            );
          }

          /*
           * Confirmamos que os times
           * existem na API.
           */

          await findTeam(
            teams.home
          );

          await findTeam(
            teams.away
          );

          const fixture =
            await findFixture(
              teams.home,
              teams.away
            );

          if (!fixture) {

            return json(
              res,
              404,
              {
                error:
                  'Partida não encontrada.',
                details:
                  'Verifique os nomes dos times ou se a partida está na janela disponível do plano gratuito.'
              }
            );
          }

          const data =
            await matchData(
              fixture.fixture.id
            );

          return json(
            res,
            200,
            {
              ok: true,
              source:
                'API-Football',
              fixtureId:
                fixture.fixture.id,
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
                'text/html; charset=utf-8'
            }
          );

          return res.end(html);
        }

        res.writeHead(404);
        res.end(
          'Página não encontrada.'
        );

      } catch (error) {

        console.error(error);

        json(
          res,
          500,
          {
            error:
              'Erro ao consultar a API.',
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
      'Live Match Stats V5 ativo na porta ' +
      PORT
    );
  }
);
