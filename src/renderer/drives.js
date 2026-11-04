// Drives window: cloud folders (Google Drive, Dropbox, OneDrive, iCloud Drive…)
// and other drives are left out of scans and cleaning until added here.
const DRIVE_ICON = { cloud: '☁️', external: '💽', network: '🌐' };
const DEMO_DRIVES = [
  { kind: 'cloud', label: 'Google Drive (angus@sommarfilms.com)', path: '/Users/angus/Library/CloudStorage/GoogleDrive-angus@sommarfilms.com', added: false },
  { kind: 'cloud', label: 'iCloud Drive', path: '/Users/angus/Library/Mobile Documents', added: false },
  { kind: 'external', label: 'Samsung T7', path: '/Volumes/Samsung T7', added: false },
  { kind: 'cloud', label: 'Dropbox', path: '/Users/angus/Dropbox', added: false },
  { kind: 'cloud', label: 'Creative Cloud Files', path: '/Users/angus/Creative Cloud Files', added: false },
  { kind: 'external', label: 'Archive A', path: '/Volumes/Archive A', added: false },
  { kind: 'external', label: 'Archive B', path: '/Volumes/Archive B', added: false },
  { kind: 'external', label: 'Projects SSD', path: '/Volumes/Projects SSD', added: false },
  { kind: 'external', label: 'Backup HDD', path: '/Volumes/Backup HDD', added: false },
  { kind: 'network', label: 'Studio NAS', path: '/Volumes/Studio NAS', added: false },
];

export function initDrives({ api, esc, toast, runScan, DEMO }) {
  const $ = (id) => document.getElementById(id);
  let list = [];
  const demo = DEMO_DRIVES.map((d) => ({ ...d }));
  const listDrives = api.listDrives || (async () => (DEMO ? demo : []));
  const setAdded = async (path, on) => {
    if (api.addDrive) return on ? api.addDrive(path) : api.removeDrive(path);
    const d = demo.find((x) => x.path === path);
    if (d) d.added = on;
  };

  async function refresh() {
    try {
      list = await listDrives();
    } catch {
      list = [];
    }
    return list;
  }
  refresh();

  const fold = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
  /** The added cloud drive a path is in, if any (for an extra warning before deleting). */
  function cloudOf(p) {
    const f = fold(p);
    return list.find((d) => d.kind === 'cloud' && d.added && (f === fold(d.path) || f.startsWith(fold(d.path) + '/') || f.startsWith(fold(d.path) + '\\'))) || null;
  }

  function warning(d) {
    if (d.kind === 'cloud') return `Deleting anything here deletes it from ${d.label} online and on every device synced to it.`;
    if (d.kind === 'network') return 'Deleting here deletes it from the shared drive for everyone who uses it.';
    return 'Files deleted here are removed from that drive, not just from this computer.';
  }

  function render() {
    const ul = $('drive-list');
    if (!list.length) {
      ul.innerHTML = '<li class="muted">No cloud folders or other drives found.</li>';
      return;
    }
    ul.innerHTML = list
      .map(
        (d, i) => `<li class="drive ${d.added ? 'added' : ''}" data-i="${i}">
        <div class="drive-row"><span class="drive-icon">${DRIVE_ICON[d.kind] || '💽'}</span>
          <span class="drive-name"><b>${esc(d.label)}</b><small>${d.kind === 'cloud' ? 'Cloud drive' : d.kind === 'network' ? 'Network drive' : 'Other drive'} · ${d.added ? 'Added' : 'Not scanned'}</small></span>
          ${d.added ? `<button data-act="scan" class="ghost-btn">Scan</button><button data-act="remove" class="link">Remove</button>` : `<button data-act="add" class="ghost-btn">Add drive…</button>`}
        </div>
        <div class="drive-confirm" hidden><p>⚠️ ${esc(warning(d))}</p><div class="perm-actions"><button data-act="confirm" class="primary danger">Add and scan</button><button data-act="cancel" class="link">Cancel</button></div></div>
      </li>`,
      )
      .join('');
  }

  async function open() {
    $('drives').hidden = false;
    $('drive-list').innerHTML = '<li class="muted">Looking for drives…</li>';
    await refresh();
    render();
  }
  const close = () => ($('drives').hidden = true);

  $('btn-drives').onclick = open;
  $('btn-drives-close').onclick = close;
  $('drives').addEventListener('click', (e) => {
    if (e.target.id === 'drives') return close();
    const btn = e.target.closest('[data-act]');
    const li = e.target.closest('li.drive');
    if (!btn || !li) return;
    const d = list[Number(li.dataset.i)];
    const confirm = li.querySelector('.drive-confirm');
    const act = btn.dataset.act;
    if (act === 'add') confirm.hidden = false;
    else if (act === 'cancel') confirm.hidden = true;
    else if (act === 'confirm' || act === 'scan') {
      (async () => {
        if (act === 'confirm') await setAdded(d.path, true);
        await refresh();
        close();
        if (DEMO) return toast(`Demo mode: would scan ${d.label}`);
        runScan(d.path);
      })();
    } else if (act === 'remove') {
      (async () => {
        await setAdded(d.path, false);
        await refresh();
        render();
        toast(`${d.label} will be left out of scans and cleaning.`);
      })();
    }
  });

  return { open, refresh, cloudOf, list: () => list };
}
