// Which Gigapolis this is: the direct download (.dmg from GitHub Releases,
// Developer ID signed) or the Mac App Store build (sandboxed). The App Store
// build is "Gigapolis Lite": the same city and cleaning, minus what the App
// Sandbox and App Store rules forbid. Pure Node so it can be unit tested;
// main.js passes in Electron's process.mas.
//
// What changes in the App Store build and why:
// - Pro is an In-App Purchase (StoreKit via Electron's inAppPurchase). No
//   Stripe checkout link, no licence keys (App Store rule 3.1.1).
// - No auto-updater: the App Store updates the app (rule 2.4.5(vii)).
// - Files: the sandbox only opens folders the user picks. The home folder is
//   picked once and kept as a security-scoped bookmark.
// - No administrator jobs (osascript "with administrator privileges" is
//   blocked), so no Time Machine snapshot clearing, DNS flush, periodic
//   scripts, memory purge or permission repair.
// - No "System & other users" measuring (du on / and tmutil are blocked).
// - No App Uninstaller: moving apps out of /Applications needs rights the
//   sandbox doesn't give.
// - No "Quit" for other apps in the Power Station (signals to other processes
//   are blocked); the live readings still work.
function capabilities({ mas = false, platform = 'darwin' } = {}) {
  const sandboxed = !!mas;
  return {
    channel: sandboxed ? 'mas' : 'direct',
    mas: sandboxed,
    // Pro
    inAppPurchase: sandboxed,
    externalCheckout: !sandboxed,
    licenceKeys: !sandboxed,
    // Updates
    autoUpdate: !sandboxed,
    // Files
    folderBookmarks: sandboxed,
    fullDiskAccessPrompt: !sandboxed && platform === 'darwin',
    // Features
    adminJobs: !sandboxed,
    systemSpace: !sandboxed && platform === 'darwin',
    uninstaller: !sandboxed && ['darwin', 'win32'].includes(platform),
    quitApps: !sandboxed,
    browserData: true,
    photos: true,
    deepClean: true,
  };
}

// The App Store product that unlocks Pro (set up in App Store Connect as a
// non-consumable). Must match the id there exactly.
const IAP_PRODUCT_ID = 'com.sommarfilms.storagesaver.pro';

// Maintenance jobs the App Store build may offer: nothing that needs an
// administrator and nothing that touches the system volume.
function filterMaintenance(tasks, caps) {
  if (caps.adminJobs) return tasks;
  return tasks.filter((t) => !t.admin && t.id !== 'firstaid' && t.id !== 'snapshots');
}

module.exports = { capabilities, filterMaintenance, IAP_PRODUCT_ID };
