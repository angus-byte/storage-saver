// Demo data so the visualiser runs in a plain browser (no Electron).
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const now = Date.now();
const DAY = 86400000;

function file(name, size, kind, ageDays = 10, p = '') {
  return { name, path: p + '/' + name, size, isDir: false, kind, mtime: now - ageDays * DAY, files: 1 };
}
function dir(name, kind, children, p = '') {
  const path = p + '/' + name;
  const kids = children.map((c) => (typeof c === 'function' ? c(path) : c));
  const size = kids.reduce((s, c) => s + c.size, 0);
  const files = kids.reduce((s, c) => s + (c.files || 0), 0);
  const mtime = Math.max(0, ...kids.map((c) => c.mtime || 0));
  kids.sort((a, b) => b.size - a.size);
  return { name, path, size, isDir: true, kind, children: kids, files, mtime };
}
const small = (count, size, kind) => (p) => ({ name: `${count.toLocaleString()} small files`, path: p, size, isDir: false, kind, mtime: now - 3 * DAY, files: count, aggregate: true });

export function mockTree() {
  const home = '/Users/angus';
  return dir('angus', 'other', [
    (p) => dir('Movies', 'media', [
      (q) => dir('Projects', 'media', [
        (r) => dir('Summer Doc 2025', 'media', [
          (s) => file('A001_C004_0812.braw', 41 * GB, 'media', 120, s),
          (s) => file('A001_C005_0812.braw', 38 * GB, 'media', 120, s),
          (s) => file('Interview_cam_B.mov', 22 * GB, 'media', 118, s),
          (s) => file('Summer Doc.prproj', 180 * MB, 'documents', 20, s),
          small(312, 2.1 * GB, 'media'),
        ], r),
        (r) => dir('Brand Spot Q1', 'media', [
          (s) => file('MASTER_4K_ProRes.mov', 19 * GB, 'media', 260, s),
          (s) => file('Rushes_day1.mxf', 31 * GB, 'media', 262, s),
          (s) => file('Rushes_day2.mxf', 27 * GB, 'media', 261, s),
          small(140, 900 * MB, 'media'),
        ], r),
        (r) => dir('Wedding Reel', 'media', [
          (s) => file('final_export.mp4', 6 * GB, 'media', 400, s),
          (s) => file('final_export_v2.mp4', 6.1 * GB, 'media', 398, s),
          small(60, 300 * MB, 'media'),
        ], r),
      ], q),
      (q) => dir('Render Cache', 'cache', [small(8200, 34 * GB, 'cache')], q),
      (q) => dir('Stock', 'media', [small(420, 11 * GB, 'media')], q),
    ], p),
    (p) => dir('Library', 'other', [
      (q) => dir('Caches', 'cache', [
        (r) => dir('com.adobe.premiere', 'cache', [small(5100, 14 * GB, 'cache')], r),
        (r) => dir('com.blackmagic.resolve', 'cache', [small(2200, 9 * GB, 'cache')], r),
        (r) => dir('Google Chrome', 'cache', [small(14000, 2.4 * GB, 'cache')], r),
        (r) => dir('Homebrew', 'cache', [small(300, 1.2 * GB, 'cache')], r),
        small(30000, 3 * GB, 'cache'),
      ], q),
      (q) => dir('Application Support', 'other', [
        (r) => dir('MobileSync', 'other', [(s) => dir('Backup', 'other', [small(90000, 28 * GB, 'other')], s)], r),
        (r) => dir('Slack', 'other', [small(2000, 1.1 * GB, 'other')], r),
        small(60000, 6 * GB, 'other'),
      ], q),
      (q) => dir('Developer', 'cache', [(r) => dir('Xcode', 'cache', [(s) => dir('DerivedData', 'cache', [small(40000, 12 * GB, 'cache')], s)], r)], q),
      small(80000, 4 * GB, 'other'),
    ], p),
    (p) => dir('Downloads', 'downloads', [
      (q) => file('DaVinci_Resolve_19.1_Mac.dmg', 3.2 * GB, 'downloads', 95, q),
      (q) => file('Adobe_Premiere_Installer.dmg', 1.1 * GB, 'downloads', 200, q),
      (q) => file('stock_footage_pack.zip', 7.8 * GB, 'downloads', 75, q),
      (q) => file('client_brief_final_FINAL.pdf', 40 * MB, 'documents', 12, q),
      (q) => file('LUT_pack.zip', 600 * MB, 'downloads', 300, q),
      small(840, 2.6 * GB, 'downloads'),
    ], p),
    (p) => dir('Pictures', 'media', [
      (q) => dir('Photos Library.photoslibrary', 'media', [small(18000, 46 * GB, 'media')], q),
      (q) => dir('Lightroom', 'media', [small(5000, 15 * GB, 'media')], q),
    ], p),
    (p) => dir('Documents', 'documents', [
      (q) => dir('Invoices', 'documents', [small(600, 400 * MB, 'documents')], q),
      (q) => dir('Scripts', 'documents', [small(200, 80 * MB, 'documents')], q),
      small(3000, 1.5 * GB, 'documents'),
    ], p),
    (p) => dir('Desktop', 'other', [
      (q) => file('screen_recording.mov', 2.3 * GB, 'media', 45, q),
      small(90, 400 * MB, 'other'),
    ], p),
    (p) => dir('Music', 'media', [small(4000, 18 * GB, 'media')], p),
    (p) => dir('.Trash', 'trash', [small(120, 5.5 * GB, 'trash')], p),
    // Loose folders with no well-known name: grouped by what is inside them.
    (p) => dir('Client Work 2024', 'other', [
      (q) => file('Nike_spot_rushes.mov', 14 * GB, 'media', 300, q),
      (q) => file('Nike_spot_grade.mov', 6 * GB, 'media', 290, q),
      (q) => file('call_sheet.pdf', 2 * MB, 'documents', 300, q),
    ], p),
    (p) => dir('old laptop stuff', 'other', [
      (q) => file('MacBook_2019_backup.zip', 9 * GB, 'downloads', 700, q),
      (q) => file('photos_export.zip', 3 * GB, 'downloads', 690, q),
    ], p),
    (p) => dir('samples', 'other', [
      (q) => file('drum_kit_vol2.wav', 900 * MB, 'media', 200, q),
      (q) => file('ambience_rain.wav', 600 * MB, 'media', 210, q),
    ], p),
    (p) => dir('Tax 2025', 'other', [(q) => file('receipts.pdf', 300 * MB, 'documents', 100, q), (q) => file('return.pdf', 40 * MB, 'documents', 100, q)], p),
    (p) => dir('Dropbox', 'other', [small(2600, 8.5 * GB, 'other')], p),
    (p) => dir('.vscode', 'other', [small(900, 700 * MB, 'other')], p),
    (p) => dir('.npm', 'cache', [small(20000, 1.6 * GB, 'cache')], p),
    (p) => dir('code', 'other', [
      (q) => dir('website', 'other', [(r) => dir('node_modules', 'cache', [small(45000, 1.8 * GB, 'cache')], r), small(500, 60 * MB, 'other')], q),
      (q) => dir('tools', 'other', [(r) => dir('node_modules', 'cache', [small(30000, 1.1 * GB, 'cache')], r), small(400, 40 * MB, 'other')], q),
    ], p),
  ], home.replace(/\/angus$/, ''));
}

export function mockSuggestions(tree) {
  const DAYS = (d) => now - d * DAY;
  const strip = (n) => ({ name: n.name, path: n.path, size: n.size, kind: n.kind, mtime: n.mtime, isDir: n.isDir });
  const walk = (n, out) => {
    out.push(n);
    (n.children || []).forEach((c) => walk(c, out));
    return out;
  };
  const all = walk(tree, []);
  const seen = [];
  const caches = all.filter((n) => n.isDir && n.kind === 'cache' && n.size > 50 * MB && !seen.some((p) => n.path.startsWith(p + '/')) && seen.push(n.path));
  const oldDownloads = all.filter((n) => !n.isDir && !n.aggregate && n.kind === 'downloads' && n.mtime < DAYS(60));
  const largeStale = all.filter((n) => !n.isDir && !n.aggregate && n.size > 500 * MB && n.mtime < DAYS(180) && n.kind !== 'cache');
  const trash = all.filter((n) => n.isDir && n.kind === 'trash' && n.name === '.Trash');
  const total = (l) => l.reduce((s, n) => s + n.size, 0);
  return {
    caches: { items: caches.map(strip), total: total(caches) },
    oldDownloads: { items: oldDownloads.map(strip), total: total(oldDownloads) },
    largeStale: { items: largeStale.sort((a, b) => b.size - a.size).map(strip), total: total(largeStale) },
    trash: { items: trash.map(strip), total: total(trash) },
  };
}

export const mockDisk = { platform: 'darwin', home: '/Users/angus', roots: [{ path: '/Users/angus', total: 620 * GB, free: 46 * GB }] };
