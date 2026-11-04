// A stable per-computer id, used to tie a Pro activation to the computer it
// was made on (so copying the plan file to another computer doesn't copy Pro).
// Only a hash leaves this function; it is never sent anywhere.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');

function rawId() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    } else if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
      if (m) return m[1];
    } else {
      const fs = require('fs');
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = fs.readFileSync(f, 'utf8').trim();
          if (id) return id;
        } catch {}
      }
    }
  } catch {}
  return [os.hostname(), os.platform(), os.arch(), (os.cpus()[0] || {}).model].join('|');
}

let cached;
function machineId() {
  if (!cached) cached = crypto.createHash('sha256').update('gigapolis:' + rawId()).digest('hex').slice(0, 32);
  return cached;
}

module.exports = { machineId };
