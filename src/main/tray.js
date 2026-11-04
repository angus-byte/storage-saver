// Menu bar (Mac) / system tray (Windows) widget. Same menu on both:
// free space at a glance, Safe Clean quick action, open the city, settings, quit.
const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

const MAC = process.platform === 'darwin';

function fmt(bytes) {
  if (!bytes) return '0 GB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * opts: getDisk() → {free,total}, getSafe() → {state:'unknown'|'checking'|'ready'|'cleaning', bytes},
 * safeClean(), checkSafe(), open(tab), settings, onSetting(key, value), quit()
 */
function createTray(opts) {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', MAC ? 'trayTemplate.png' : 'tray-win.png'));
  if (MAC) icon.setTemplateImage(true);
  const tray = new Tray(icon);
  let disk = { free: 0, total: 0 };

  function safeItem() {
    const s = opts.getSafe();
    if (s.state === 'checking') return { label: 'Safe Clean · checking…', enabled: false };
    if (s.state === 'cleaning') return { label: 'Safe Clean · cleaning…', enabled: false };
    if (s.state === 'unknown') return { label: 'Safe Clean · check what can go', click: () => opts.checkSafe() };
    if (!s.bytes) return { label: 'Safe Clean · nothing to clear', enabled: false };
    return { label: `Safe Clean · free ${fmt(s.bytes)}`, click: () => opts.safeClean() };
  }

  function render() {
    const st = opts.settings.get();
    const used = disk.total ? Math.round(((disk.total - disk.free) / disk.total) * 100) : 0;
    const toggle = (label, key) => ({ label, type: 'checkbox', checked: !!st[key], click: (item) => opts.onSetting(key, item.checked) });
    const menu = Menu.buildFromTemplate([
      { label: disk.total ? `${fmt(disk.free)} free of ${fmt(disk.total)} (${used}% used)` : 'Checking disk…', enabled: false },
      { type: 'separator' },
      safeItem(),
      { label: 'Open Gigapolis', click: () => opts.open() },
      { type: 'separator' },
      toggle('Low-space alert', 'lowSpaceAlert'),
      toggle(MAC ? 'Keep running in menu bar' : 'Keep running in system tray', 'keepInTray'),
      toggle('Open at login', 'launchAtLogin'),
      { type: 'separator' },
      { label: 'Quit Gigapolis', click: () => opts.quit() },
    ]);
    tray.setContextMenu(menu);
    const tip = disk.total ? `Gigapolis · ${fmt(disk.free)} free` : 'Gigapolis';
    tray.setToolTip(tip);
    if (MAC) tray.setTitle(disk.total ? ` ${fmt(disk.free)}` : '', { fontType: 'monospacedDigit' });
  }

  // Windows opens the menu on right-click only; make left-click do the same so both feel identical.
  if (!MAC) tray.on('click', () => tray.popUpContextMenu());

  return {
    setDisk(d) {
      disk = d;
      render();
    },
    render,
    destroy: () => tray.destroy(),
  };
}

module.exports = { createTray, fmt };
