// @ts-check
const cheerio = require('cheerio');
const fs = require('mz/fs');
const yaml = require('js-yaml');
const path = require('path');

let request = require('request-promise-native');
request = request.defaults({
  jar: request.jar(),
  headers: {
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'fr,en-US;q=0.9,en;q=0.8',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.45 Safari/537.36'
  },
  gzip: true
});

async function loadConfig() {
  let content = await fs.readFile('config.yaml', 'utf8');
  /** @type {any} */
  let config = yaml.load(content);
  if (!config.shows) config.shows = [];
  if (!config.ignore_versions) config.ignore_versions = [];
  if (!fs.existsSync(config.directory)) await fs.mkdir(config.directory);
  return config;
}

async function loadHistory(config) {
  let history;
  if (fs.existsSync('history.json')) {
    const json = await fs.readFile('history.json', 'utf8');
    history = JSON.parse(json);
  }
  if (config.saveHistory) {
    const data = await request.get(config.saveHistory, { json: true });
    if (!history || data.when >= history.when) {
      history = data;
    }
  }
  return history || { when: Date.now(), items: [] };
}

async function saveHistory(config, history) {
  history.when = Date.now();
  await fs.writeFile('history.json', JSON.stringify(history, null, 2), 'utf8');
  if (config.saveHistory) {
    await request.put({
      url: config.saveHistory,
      body: history,
      json: true
    });
  }
}

async function getAllShows() {
  const useShowsOptions = true;
  let url = 'http://www.addic7ed.com/shows.php';
  if (useShowsOptions) url = 'http://www.addic7ed.com';
  const html = await request.get(url);
  // await fs.writeFile('shows.html', html, 'utf8');
  const $ = cheerio.load(html);
  let shows;
  if (!useShowsOptions) {
    shows = $('a')
      .toArray()
      .filter(
        elt =>
          $(elt).attr('href') &&
          $(elt)
            .attr('href')
            .indexOf('/show/') === 0
      )
      .map(elt => ({
        name: $(elt).text(),
        id: +$(elt)
          .attr('href')
          .replace('/show/', ''),
        url: 'http://www.addic7ed.com' + $(elt).attr('href')
      }));
  } else {
    shows = $('select[name=qsShow]')
      .find('option')
      .toArray()
      .map(elt => ({
        name: $(elt).text(),
        id: $(elt).attr('value'),
        url: 'http://www.addic7ed.com/show/' + $(elt).attr('value')
      }))
      .filter(elt => +elt.id !== 0);
  }
  return shows;
}

function pickShows(config, shows) {
  const filtered = [];
  for (const wanted of config.shows) {
    const show = shows.find(s => s.name === wanted);
    if (show) filtered.push(show);
  }
  return filtered;
}

async function download(config, show, history) {
  let done = 0;
  console.log(`Downloading latest from '${show.name}'`);
  let html = await request.get(show.url);
  let $ = cheerio.load(html);
  let seasons = $('#sl button')
    .toArray()
    .map(elt => $(elt).text());
  let season = seasons[seasons.length - 1];
  console.log('  season ' + season);
  html = await request.get(
    `http://www.addic7ed.com/ajax_loadShow.php?show=${
      show.id
    }&season=${season}&langs=&hd=undefined&hi=undefined`
  );
  $ = cheerio.load(html);
  let episodes = $('#season .completed')
    .toArray()
    .map(elt => ({
      season: +$(elt)
        .find('td')
        .eq(0)
        .text(),
      episode: +$(elt)
        .find('td')
        .eq(1)
        .text(),
      lang: $(elt)
        .find('td')
        .eq(3)
        .text(),
      version: $(elt)
        .find('td')
        .eq(4)
        .text(),
      completed:
        $(elt)
          .find('td')
          .eq(5)
          .text() === 'Completed',
      url:
        'http://www.addic7ed.com' +
        $(elt)
          .find('td')
          .eq(9)
          .find('a')
          .attr('href')
    }))
    .filter(ep => ep.completed && ep.lang === config.language);

  const showhistory = history.filter(h => h.show === show.name);

  episodes = episodes.filter(
    episode =>
      !showhistory.find(h => h.url === episode.url) &&
      !config.ignore_versions.includes(episode.version)
  );

  await Promise.all(
    episodes.map(async episode => {
      try {
        console.log(
          `    download episode ${episode.episode}, version ${episode.version}`
        );
        const data = await request.get(episode.url, {
          resolveWithFullResponse: true,
          headers: {
            Referer: `http://www.addic7ed.com/season/${show.id}/${
              episode.season
            }`
          },
          encoding: null
        });

        let filename = data.headers['content-disposition'];
        if (filename) {
          filename = filename
            .replace('attachment; filename=', '')
            .replace(/(:|"|\t)/g, '');
          await fs.writeFile(path.join(config.directory, filename), data.body);

          history.push({
            show: show.name,
            url: episode.url,
            episode: `S${episode.season
              .toString()
              .padStart(2, '0')}E${episode.episode.toString().padStart(2, '0')}`
          });

          done++;
        }
      } catch (e) {
        console.error('Error downloading episode: ' + e.message);
      }
    })
  );

  return done;
}

async function main() {
  // get config and history from disk
  const config = await loadConfig();
  const history = await loadHistory(config);
  // get all shows from addicted website
  let shows = await getAllShows();
  console.log(`${shows.length} shows available.`);
  // filter to keep only the one defined in config.yaml
  shows = pickShows(config, shows);
  console.log(`${shows.length} filtered shows.`);
  // download episodes
  let downloaded = 0;
  for (let show of shows) {
    downloaded += await download(config, show, history.items);
  }
  // save history
  await saveHistory(config, history);
  // bye
  if (downloaded > 0) {
    console.log(`${downloaded} subtitle(s) downloaded.`);
  } else {
    console.log('Nothing downloaded.');
  }
}

main()
  .then(() => console.log('Done.'))
  .catch(e => {
    console.error(e);
  });
