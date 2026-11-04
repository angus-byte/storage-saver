const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listBrowsers, prepare, clear, locations, isRunning } = require('../src/main/browsers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-br-'));
const put = (file, bytes = 10) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
};

async function makeDb(file, sql) {
  const SQL = await require('sql.js')();
  const db = new SQL.Database();
  db.run(sql);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
}
async function query(file, sql) {
  const SQL = await require('sql.js')();
  const db = new SQL.Database(fs.readFileSync(file));
  const r = db.exec(sql);
  db.close();
  return r.length ? r[0].values : [];
}

// A fake trash that moves things into a folder, like the real one.
function fakeTrash(dir) {
  const moved = [];
  return {
    moved,
    trash: async (p) => {
      const to = path.join(dir, moved.length + '-' + path.basename(p));
      fs.renameSync(p, to);
      moved.push(p);
      return { ok: true };
    },
  };
}

async function chromeHome() {
  const home = tmp();
  const prof = path.join(home, 'Library/Application Support/Google/Chrome/Default');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'Preferences'), JSON.stringify({ profile: { name: 'Angus' } }));
  put(path.join(prof, 'Cache/Cache_Data/data_0'), 5000);
  put(path.join(prof, 'Code Cache/js/a'), 1000);
  put(path.join(home, 'Library/Caches/Google/Chrome/Default/Cache/f'), 3000);
  put(path.join(prof, 'Network/Cookies'), 700);
  put(path.join(prof, 'Local Storage/leveldb/000003.log'), 400);
  await makeDb(path.join(prof, 'History'), `
    CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT);
    INSERT INTO urls(url) VALUES ('https://example.com');
    CREATE TABLE downloads(id INTEGER PRIMARY KEY, target_path TEXT, current_path TEXT, tab_url TEXT, tab_referrer_url TEXT, site_url TEXT, referrer TEXT, mime_type TEXT);
    INSERT INTO downloads(target_path, current_path) VALUES ('/Users/a/Downloads/x.dmg', '/Users/a/Downloads/x.dmg'), ('/Users/a/Downloads/y.zip', '/Users/a/Downloads/y.zip');
    CREATE TABLE downloads_url_chains(id INTEGER, chain_index INTEGER, url TEXT);
    INSERT INTO downloads_url_chains VALUES (1, 0, 'https://example.com/x.dmg');`);
  return { home, prof };
}

test('locations cover Safari, Chromium browsers and Firefox on Mac; no Safari on Windows', () => {
  const mac = locations({ home: '/Users/a', platform: 'darwin' }).map((b) => b.id);
  assert.deepStrictEqual(mac, ['safari', 'chrome', 'edge', 'brave', 'arc', 'firefox']);
  const win = locations({ home: 'C:\\Users\\a', platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' } });
  assert.deepStrictEqual(win.map((b) => b.id), ['chrome', 'edge', 'brave', 'arc', 'firefox']);
  assert.strictEqual(win[0].root, 'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data');
  assert.strictEqual(win[4].root, 'C:\\Users\\a\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles');
});

test('running browsers are recognised on both systems', () => {
  const [, chrome] = locations({ home: '/Users/a', platform: 'darwin' });
  assert.ok(isRunning(chrome, ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'], 'darwin'));
  assert.ok(!isRunning(chrome, ['/Applications/Google Chrome.app/Contents/Frameworks/Helper'], 'darwin'));
  assert.ok(isRunning(chrome, ['explorer.exe', 'chrome.exe'], 'win32'));
});

test('Chrome: sizes each kind, download history read from the History database', async () => {
  const { home } = await chromeHome();
  const list = await listBrowsers({ home, platform: 'darwin', procs: [] });
  const chrome = list.find((b) => b.id === 'chrome');
  assert.ok(chrome && !list.find((b) => b.id === 'firefox'));
  assert.strictEqual(chrome.items.cache.size, 9000);
  assert.strictEqual(chrome.items.cookies.size, 700);
  assert.strictEqual(chrome.items.siteData.size, 400);
  assert.strictEqual(chrome.items.downloads.count, 2);
  assert.ok(chrome.items.history.size > 0);
  assert.strictEqual(chrome.historyIncludesDownloads, true);
});

test('Chrome: caches go to the Trash; download history cleared in place with a backup', async () => {
  const { home, prof } = await chromeHome();
  const bin = tmp();
  const t = fakeTrash(bin);
  const prep = await prepare('chrome', ['cache', 'downloads'], { home, platform: 'darwin' });
  const { results } = await clear(prep, { trash: t.trash, tmpDir: tmp() });
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.ok(!fs.existsSync(path.join(prof, 'Cache')));
  assert.ok(fs.existsSync(path.join(prof, 'Network/Cookies')), 'cookies untouched');
  assert.deepStrictEqual(await query(path.join(prof, 'History'), 'SELECT COUNT(*) FROM downloads'), [[0]]);
  assert.deepStrictEqual(await query(path.join(prof, 'History'), 'SELECT COUNT(*) FROM urls'), [[1]], 'browsing history kept');
  assert.ok(fs.readdirSync(bin).some((f) => /Google Chrome download history before Gigapolis/.test(f)), 'backup in the Trash');
});

test('Firefox: history cleared but bookmarks kept; busy database refused', async () => {
  const home = tmp();
  const prof = path.join(home, 'Library/Application Support/Firefox/Profiles/ab12.default-release');
  put(path.join(prof, 'prefs.js'));
  put(path.join(home, 'Library/Caches/Firefox/Profiles/ab12.default-release/cache2/entries/x'), 2000);
  put(path.join(prof, 'cookies.sqlite'), 300);
  await makeDb(path.join(prof, 'places.sqlite'), `
    CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, foreign_count INTEGER DEFAULT 0, visit_count INTEGER, last_visit_date INTEGER, origin_id INTEGER);
    CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY, place_id INTEGER, visit_type INTEGER);
    CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY, fk INTEGER);
    CREATE TABLE moz_anno_attributes(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE moz_annos(id INTEGER PRIMARY KEY, place_id INTEGER, anno_attribute_id INTEGER, content TEXT);
    CREATE TABLE moz_origins(id INTEGER PRIMARY KEY, host TEXT);
    INSERT INTO moz_origins VALUES (1,'bookmarked.com'),(2,'visited.com');
    INSERT INTO moz_places VALUES (1,'https://bookmarked.com',1,3,1,1),(2,'https://visited.com/x.zip',0,1,1,2);
    INSERT INTO moz_bookmarks VALUES (1,1);
    INSERT INTO moz_historyvisits VALUES (1,1,1),(2,2,7),(3,2,1);
    INSERT INTO moz_anno_attributes VALUES (1,'downloads/destinationFileURI');
    INSERT INTO moz_annos VALUES (1,2,1,'file:///Users/a/Downloads/x.zip');`);
  const [ff] = await listBrowsers({ home, platform: 'darwin', procs: [] });
  assert.strictEqual(ff.id, 'firefox');
  assert.strictEqual(ff.items.cache.size, 2000);
  assert.strictEqual(ff.items.downloads.count, 1);
  assert.strictEqual(ff.items.history.count, 3);

  // An unflushed write-ahead log means Firefox is (or was just) running.
  put(path.join(prof, 'places.sqlite-wal'), 100);
  let prep = await prepare('firefox', ['history'], { home, platform: 'darwin' });
  let r = await clear(prep, { trash: fakeTrash(tmp()).trash, tmpDir: tmp() });
  assert.ok(!r.results[0].ok && /Quit it/.test(r.results[0].error));
  fs.unlinkSync(path.join(prof, 'places.sqlite-wal'));

  prep = await prepare('firefox', ['history', 'downloads'], { home, platform: 'darwin' });
  assert.strictEqual(prep.edits.length, 1, 'one edit of places.sqlite covers both');
  r = await clear(prep, { trash: fakeTrash(tmp()).trash, tmpDir: tmp() });
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
  const db = path.join(prof, 'places.sqlite');
  assert.deepStrictEqual(await query(db, 'SELECT url, visit_count FROM moz_places'), [['https://bookmarked.com', 0]]);
  assert.deepStrictEqual(await query(db, 'SELECT COUNT(*) FROM moz_historyvisits'), [[0]]);
  assert.deepStrictEqual(await query(db, 'SELECT COUNT(*) FROM moz_annos'), [[0]]);
  assert.deepStrictEqual(await query(db, 'SELECT host FROM moz_origins'), [['bookmarked.com']]);
  assert.ok(fs.existsSync(path.join(prof, 'cookies.sqlite')), 'cookies untouched');
});

test('Safari: needs Full Disk Access when its folder cannot be read', { skip: process.getuid && process.getuid() === 0 }, async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'Library/Safari'), { recursive: true });
  fs.chmodSync(path.join(home, 'Library/Safari'), 0);
  const [safari] = await listBrowsers({ home, platform: 'darwin', procs: [] });
  assert.strictEqual(safari.id, 'safari');
  assert.strictEqual(safari.needsAccess, true);
});

test('Safari: history, downloads and cookies are files that go to the Trash', async () => {
  const home = tmp();
  put(path.join(home, 'Library/Safari/History.db'), 900);
  put(path.join(home, 'Library/Safari/Downloads.plist'), 100);
  put(path.join(home, 'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies'), 200);
  put(path.join(home, 'Library/Caches/com.apple.Safari/Cache.db'), 4000);
  const [safari] = await listBrowsers({ home, platform: 'darwin', procs: [] });
  assert.strictEqual(safari.items.history.size, 900);
  assert.strictEqual(safari.items.cache.size, 4000);
  const prep = await prepare('safari', ['history', 'cookies'], { home, platform: 'darwin' });
  const t = fakeTrash(tmp());
  await clear(prep, { trash: t.trash });
  assert.ok(!fs.existsSync(path.join(home, 'Library/Safari/History.db')));
  assert.ok(fs.existsSync(path.join(home, 'Library/Safari/Downloads.plist')));
  assert.ok(fs.existsSync(path.join(home, 'Library/Caches/com.apple.Safari/Cache.db')));
});
