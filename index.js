// @ts-check
const cheerio = require('cheerio');
const fs = require('mz/fs');
const yaml = require('js-yaml');
const path = require('path');

let request = require('request-promise-native');
request = request.defaults({
    jar: request.jar(),
    headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'fr,en-US;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.45 Safari/537.36',
    },
    gzip: true,
});

async function loadConfig() {
    let content = await fs.readFile('config.yaml', 'utf8');
    let config = yaml.load(content);
    if (!config.shows) config.shows = [];
    if (!fs.existsSync(config.directory)) await fs.mkdir(config.directory);    
    return config;
}

async function loadHistory() {
    if (fs.existsSync('history.json')) {
        let json = await fs.readFile('history.json', 'utf8');
        return JSON.parse(json);
    } else {
        return [];
    }
}

async function saveHistory(history) {
    await fs.writeFile('history.json', JSON.stringify(history, null, 2), 'utf8');
}

async function getAllShows() {
    const html = await request.get('http://www.addic7ed.com/shows.php');
    const $ = cheerio.load(html);
    const shows = $('a').toArray()
                    .filter(elt => $(elt).attr('href') && $(elt).attr('href').indexOf('/show/') === 0)
                    .map(elt => ({
                        name: $(elt).text(),
                        id: +$(elt).attr('href').replace('/show/', ''),
                        url: 'http://www.addic7ed.com' + $(elt).attr('href'),
                    }));
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
    let seasons = $('#sl button').toArray().map(elt => $(elt).text());
    let season = seasons[seasons.length - 1];
    console.log('  season ' + season);
    html = await request.get(`http://www.addic7ed.com/ajax_loadShow.php?show=${show.id}&season=${season}&langs=&hd=undefined&hi=undefined`);
    $ = cheerio.load(html);
    let episodes = $('#season .completed').toArray().map(elt => ({
        season: +$(elt).find('td').eq(0).text(),
        episode: +$(elt).find('td').eq(1).text(),
        lang: $(elt).find('td').eq(3).text(),
        version: $(elt).find('td').eq(4).text(),
        completed: $(elt).find('td').eq(5).text() === 'Completed',
        url: 'http://www.addic7ed.com' + $(elt).find('td').eq(9).find('a').attr('href'),
    })).filter(ep => ep.completed && ep.lang === config.language);

    const showhistory = history.filter(h => h.show === show.name);
    for (const episode of episodes) {
        if (!showhistory.find(h => h.url === episode.url)) {
            console.log(`    download episode ${episode.episode}, version ${episode.version}`);
            const data = await request.get(episode.url, { 
                resolveWithFullResponse: true,
                headers: {
                    'Referer': `http://www.addic7ed.com/season/${show.id}/${episode.season}`,
                },
                encoding: null,
            });

            const filename = data.headers['content-disposition'].replace('attachment; filename=', '').replace(/("|\t)/g, '');
            await fs.writeFile(path.join(config.directory, filename), data.body);

            history.push({
                show: show.name,
                url: episode.url,
            });

            done++;
        }
    }

    return done;
}

async function main() {
    // get config and history from disk
    let config = await loadConfig();
    let history = await loadHistory();
    // get all shows from addicted website
    let shows = await getAllShows();
    console.log(`${shows.length} shows available.`);
    // filter to keep only the one defined in config.yaml
    shows = pickShows(config, shows);
    console.log(`${shows.length} filtered shows.`);
    // download episodes
    let downloaded = 0;
    for (let show of shows) {
        downloaded += await download(config, show, history);
    }
    // save history
    saveHistory(history);
    // bye
    if (downloaded > 0) {
        console.log(`${downloaded} subtitle(s) downloaded.`);
    } else {
        console.log('Nothing downloaded.');
    }
}

main()
.then(() => console.log('Done.'))
.catch(console.error);
