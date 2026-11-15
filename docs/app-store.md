# Gigapolis on the Mac App Store

The App Store version is **Gigapolis Lite**: the same city, Safe Clean, Deep
Clean (Pro), Photo Studio, browser privacy and Power Station readings, built
inside Apple's App Sandbox. The direct download from getgigapolis.com stays the
full version. Both come from this repo; `process.mas` picks the behaviour
(`src/main/distribution.js`).

## What is different in the App Store build

| Area | Direct (.dmg) | App Store (Lite) | Why |
|---|---|---|---|
| Pro purchase | Stripe checkout on getgigapolis.com, GP- licence keys | In-App Purchase `com.sommarfilms.storagesaver.pro` (non-consumable), "Restore purchase" | Guideline 3.1.1: digital unlocks must use IAP, no outside payment links |
| Updates | electron-updater from GitHub Releases | App Store | Guideline 2.4.5(vii) |
| Reading files | Full Disk Access switch | User picks the home folder once (security-scoped bookmark); other folders/drives via the folder picker | Sandbox |
| Maintenance (Public Works) | All jobs, one admin password | Only jobs that need no administrator (Launch Services rebuild, Spotlight reindex) | `osascript … with administrator privileges` is blocked |
| Time Machine snapshots | Clear | Hidden | needs admin + tmutil |
| System & other users | Measured breakdown | Explanation only | `du /` and `tmutil` blocked |
| App Uninstaller (Moving Day) | Yes | Hidden (Deep Clean still finds leftovers) | can't move items out of /Applications |
| Power Station "Quit" | Yes | Hidden (readings stay) | can't signal other processes |
| Everything else | same | same | |

## Build

- Local: `npm run dist:mas` → `dist/Gigapolis-<version>-mas.pkg` (universal).
  Needs `build/embedded.provisionprofile` (Mac App Store profile for the bundle
  id, not committed) and the two distribution certificates in the keychain.
- `npm run dist:mas-dev` → a sandboxed .app signed for development
  (`build/embedded-dev.provisionprofile`) to test the sandbox on your own Mac.
  Test IAP with a Sandbox Apple Account from App Store Connect → Users and Access.
- CI: **Build Mac App Store app** action (`.github/workflows/release-mas.yml`),
  run by hand; tick *Upload* to send it to App Store Connect.

Files: `build/entitlements.mas.plist`, `build/entitlements.mas.inherit.plist`,
`build/PrivacyInfo.xcprivacy` (copied to Contents/Resources), `build/icon.icns`.
Bundle id `com.sommarfilms.storagesaver`, team `Q5N8US95TK`, category Utilities.

## Checklist for App Store Connect (only Angus can do these)

1. **Certificates** (developer.apple.com → Certificates): *Apple Distribution*
   and *Mac Installer Distribution*. Export both to one .p12 → secrets
   `MAS_CSC_LINK` (base64) + `MAS_CSC_KEY_PASSWORD`.
2. **Identifier**: register App ID `com.sommarfilms.storagesaver` with App
   Sandbox + In-App Purchase capabilities.
3. **Provisioning profile**: Mac App Store distribution profile for that App ID
   → `MAS_PROVISIONING_PROFILE` secret (base64). Also a Development profile for
   `mas-dev` builds locally.
4. **App Store Connect → New app**: macOS, name *Gigapolis*, bundle id above,
   SKU `gigapolis-mac`, primary language English (Australia or U.S.).
5. **In-App Purchase**: non-consumable, product id
   `com.sommarfilms.storagesaver.pro`, reference name *Gigapolis Pro*, price
   tier matching US$19.99, display name *Gigapolis Pro*, description below.
   Must be submitted with the first build.
6. **API key** (Users and Access → Integrations → App Store Connect API, role
   App Manager) → `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, `ASC_API_KEY` (base64 .p8).
7. **Agreements**: Paid Apps agreement, banking and tax forms (needed before a
   paid IAP can go live).
8. **App Privacy**: "Data not collected". Privacy policy URL
   https://getgigapolis.com/privacy.
9. **Export compliance**: already answered in the bundle
   (`ITSAppUsesNonExemptEncryption = NO`, only HTTPS).
10. **Age rating**: 4+. **Category**: Utilities (secondary: Productivity).
11. **Screenshots**: 1280×800, 1440×900, 2560×1600 or 2880×1800, 16:10, at least
    one, up to ten. Ready-made 2880×1800 set in the project's
    `app-store/screenshots/` folder (from the demo city).
12. Run the **Build Mac App Store app** action with *Upload* ticked, pick the
    build in App Store Connect, fill in the metadata below, submit.

## Metadata (copy-paste)

**Name**: Gigapolis
**Subtitle** (30): Your storage as a 3D city
**Promotional text** (170): See where your space went, then demolish what you don't need. Caches, old downloads, duplicates and render junk all go to the Trash first, never straight to oblivion.
**Keywords** (100): disk space,storage,clean,cleaner,duplicate,cache,free space,disk,junk,uninstall,files,3D
**Description**:

Gigapolis turns your Mac's storage into a city. Every folder is a building, every suburb a kind of file: the Media District, Cache Town, Downloads. Tall buildings are big files. Parks are free space. One look and you know where the gigabytes went.

Click a building to walk in, show it in Finder or demolish it. Demolishing moves things to the Trash, never a permanent delete, so you can always change your mind.

FREE
• Full scan of your home folder, any folder or drive you choose
• The 3D city, by day or by night
• Safe Clean: caches and the Trash in one click
• Street Sweep: old downloads, leftover installers, stale large files
• Photo Studio: the biggest photos and videos
• Power Station: live memory, processor, disk and battery readings
• Public Works: rebuild "Open With" menus and Spotlight
• Browser privacy: clear history, cookies and site data
• Demolish up to 20 GB a month

PRO (one purchase, no subscription)
• Unlimited Demolish
• Deep Clean: video render caches (Final Cut, Premiere, Resolve), exact duplicates, app leftovers, old iPhone backups, developer junk, logs and installers, Mail attachments
• Weekly check-up in the background
• Seasons for the city

Gigapolis reads your files only to measure them. Nothing leaves your Mac.

**What's new** (first version): Gigapolis arrives on the App Store.

**Support URL**: https://getgigapolis.com  **Marketing URL**: https://getgigapolis.com
**Copyright**: 2026 Sommarfilms

**IAP display name**: Gigapolis Pro
**IAP description** (45): Unlimited Demolish, Deep Clean, weekly check-up

## Review notes (App Review → Notes)

Gigapolis is a storage visualiser and cleaner. On first scan it asks the
reviewer to choose their home folder in a standard Open dialog (App Sandbox,
security-scoped bookmark); nothing is read before that. Every "Demolish" moves
items to the Trash with a confirmation; there is no permanent deletion. Pro is
a single non-consumable In-App Purchase (com.sommarfilms.storagesaver.pro);
there are no accounts, no external purchase links and no licence keys in this
build. The app makes no network requests. No sign-in is needed to test.

## Not covered by this build (known gaps)

- Receipt validation is StoreKit's transaction state; there is no server-side
  receipt check (fine for a $19.99 unlock, revisit if piracy matters).
- The free 20 GB/month cap applies in Lite too (same as direct).
- Windows and the direct Mac build are unchanged.
