// App settings (menu bar / tray behaviour), stored as JSON in userData.
const fs = require('fs');
const path = require('path');

const GB = 1024 ** 3;
const DEFAULTS = {
  keepInTray: true, // closing the window leaves Gigapolis running in the menu bar / tray
  launchAtLogin: false,
  lowSpaceAlert: true,
  lowSpaceGB: 10,
};

function createSettings({ dir }) {
  const file = path.join(dir, 'settings.json');
  let data = { ...DEFAULTS };
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {}
  return {
    get: () => ({ ...data }),
    set(patch) {
      for (const k of Object.keys(patch)) if (k in DEFAULTS) data[k] = patch[k];
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      } catch {}
      return { ...data };
    },
  };
}

/**
 * Low-space alert: fire once when free space drops under the threshold, then
 * stay quiet until it climbs 1 GB back above it (so it never nags).
 */
function lowSpaceCheck(armed, freeBytes, thresholdGB) {
  const limit = thresholdGB * GB;
  if (armed && freeBytes > 0 && freeBytes < limit) return { notify: true, armed: false };
  if (!armed && freeBytes > limit + GB) return { notify: false, armed: true };
  return { notify: false, armed };
}

module.exports = { createSettings, lowSpaceCheck, DEFAULTS };
