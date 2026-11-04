#!/usr/bin/env python3
"""Generates site/guides/*.html and site/alternatives/*.html. Edit the content here, then run: python3 scripts/site-guides.py ."""
import json, os, re, sys

ROOT = sys.argv[1]
DATE = "2026-11-04"
DATE_H = "4 November 2026"
BASE = "https://getgigapolis.com"

CSS = """
:root{--cream:#f6efe3;--cream-2:#eadfcb;--rust:#b9583c;--ink:#2b1d16;--muted:#6e5a4c;--card:#fffaf2;--line:rgba(43,29,22,.12)}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--ink);font:17px/1.65 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--rust)}
img{max-width:100%;height:auto;display:block}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
header.nav{display:flex;align-items:center;justify-content:space-between;padding:18px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;text-decoration:none;color:var(--ink)}
.brand img{width:36px;height:36px;border-radius:9px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:12px 20px;border-radius:12px;font-weight:600;text-decoration:none;font-size:16px}
.btn-primary{background:var(--rust);color:#fff;box-shadow:0 6px 18px rgba(185,88,60,.35)}
.btn-dark{background:var(--ink);color:#fff}
article{max-width:740px;margin:0 auto;padding:10px 0 40px}
.crumbs{font-size:14px;color:var(--muted);margin:10px 0 0}.crumbs a{color:var(--muted)}
h1{font-size:clamp(30px,5vw,44px);line-height:1.12;letter-spacing:-.02em;margin:14px 0 10px}
.meta{font-size:14px;color:var(--muted);margin:0 0 22px}
.lead{font-size:19px}
h2{font-size:clamp(23px,3vw,28px);line-height:1.2;margin:40px 0 10px;letter-spacing:-.01em}
h3{font-size:19px;margin:26px 0 6px}
p,li{color:#3d2c22}
li{margin:6px 0}
code{background:var(--cream-2);padding:2px 6px;border-radius:6px;font-size:.9em;word-break:break-word}
pre{background:var(--ink);color:#f6efe3;padding:14px 16px;border-radius:12px;overflow-x:auto;font-size:14px}
pre code{background:none;padding:0;color:inherit}
.note{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--rust);border-radius:12px;padding:14px 18px;margin:20px 0}
.note p{margin:0}
.toc{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 20px;margin:20px 0}
.toc p{margin:0 0 4px;font-weight:600}.toc ol{margin:0;padding-left:20px}
.cta{background:var(--cream-2);border-radius:18px;padding:24px;margin:36px 0;display:grid;grid-template-columns:1fr;gap:12px}
.cta h2{margin:0;font-size:24px}.cta p{margin:0}
.cta img{border-radius:12px;box-shadow:0 14px 34px rgba(43,29,22,.2)}
table{width:100%;border-collapse:collapse;font-size:15px;margin:16px 0;display:block;overflow-x:auto}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--cream-2)}
.related{border-top:1px solid var(--line);margin-top:40px;padding-top:10px}
.related ul{padding-left:20px}
footer{padding:30px 0 60px;color:var(--muted);font-size:14px;text-align:center}
footer a{color:var(--muted)}
"""

TRACK = """<script>
// Privacy-friendly visit count: no cookies, no IDs (see /privacy).
(function () {
  if (navigator.webdriver || !navigator.sendBeacon) return;
  var src = null;
  try { src = sessionStorage.getItem('gp_src'); } catch (e) {}
  if (src) return;
  var q = new URLSearchParams(location.search);
  src = q.get('ref') || q.get('utm_source') || '';
  if (!src && document.referrer) { try { var h = new URL(document.referrer).hostname; if (h !== location.hostname) src = h; } catch (e) {} }
  src = src || 'direct';
  try { sessionStorage.setItem('gp_src', src); } catch (e) {}
  try { navigator.sendBeacon('/api/track', new Blob([JSON.stringify({ k: 'visit', p: '', s: src })], { type: 'text/plain' })); } catch (e) {}
})();
</script>"""

def cta(title, text, img="/img/ui-day.jpg", alt="Gigapolis showing a Mac's storage as a 3D city"):
    return f"""<div class="cta">
  <img src="{img}" width="1440" height="900" alt="{alt}" loading="lazy">
  <h2>{title}</h2>
  <p>{text}</p>
  <p><a class="btn btn-primary" href="/#download">Download Gigapolis free</a></p>
</div>"""

PAGES = {}

def page(path, *, title, desc, h1, section, section_url, body, related, faqs=None):
    PAGES[path] = dict(title=title, desc=desc, h1=h1, section=section, section_url=section_url, body=body, related=related, faqs=faqs or [])

TITLES = {}

# ---------------------------------------------------------------- pillar
page("guides/free-up-space-mac",
  title="How to Free Up Disk Space on a Mac (2026 Guide) · Gigapolis",
  desc="See what's using storage on your Mac, then free up disk space safely: caches, System Data, large files, old downloads, apps and duplicate photos.",
  h1="How to free up disk space on a Mac",
  section="Guides", section_url="/guides/free-up-space-mac",
  body=f"""
<p class="lead">To free up disk space on a Mac, first find out what's using it, then clear the biggest things you don't need: caches, local Time Machine snapshots, old downloads, large files you've forgotten, unused apps and duplicate photos. This guide walks through each one using only what's built into macOS, and shows the faster route with Gigapolis at the end of each step.</p>

<div class="toc"><p>In this guide</p><ol>
<li><a href="#see">See what's using your storage</a></li>
<li><a href="#trash">Empty the Trash</a></li>
<li><a href="#downloads">Clear out old downloads</a></li>
<li><a href="#large">Find and remove large files</a></li>
<li><a href="#caches">Clear caches</a></li>
<li><a href="#system-data">Shrink System Data</a></li>
<li><a href="#apps">Uninstall apps you don't use</a></li>
<li><a href="#photos">Remove duplicate photos</a></li>
<li><a href="#icloud">Let iCloud store older files</a></li>
</ol></div>

<div class="note"><p><b>Before you delete anything:</b> make sure you have a recent backup. Move things to the Trash rather than deleting them outright, so you can put them back if something goes wrong.</p></div>

<h2 id="see">1. See what's using your storage</h2>
<p>Open <b>System Settings → General → Storage</b>. The bar at the top splits your disk into Applications, Documents, Photos, System Data and so on. Underneath, macOS offers a few recommendations, and the ⓘ button next to each category lists its files.</p>
<p>The built-in view is a good start, but it can't show you inside System Data, and it doesn't show which folders are biggest. A disk space analyzer fills that gap. <a href="/">Gigapolis</a> scans your whole disk and draws it as a 3D city, with one building per category: the tallest building is what's using the most space, and clicking it lists the files inside, biggest first.</p>

<h2 id="trash">2. Empty the Trash</h2>
<p>Files you've deleted still take up space until the Trash is emptied. Right-click the Trash in the Dock and choose <b>Empty Trash</b>. To do this automatically, open Finder, choose <b>Finder → Settings → Advanced</b> and turn on <b>Remove items from the Trash after 30 days</b>.</p>
<p>Apps like Photos and Mail have their own trash too: check <b>Recently Deleted</b> in Photos and the Deleted folder in Mail.</p>

<h2 id="downloads">3. Clear out old downloads</h2>
<p>The Downloads folder quietly fills up with installers (<code>.dmg</code> and <code>.pkg</code> files), zips and one-off documents. In Finder, open Downloads, switch to list view (<b>⌘2</b>) and sort by <b>Size</b> or <b>Date Added</b>. Installers for apps you've already installed are safe to remove.</p>
<p>Gigapolis's free <b>Street Sweep</b> lists downloads you haven't touched in over 60 days, alongside caches and the Trash, so you can clear them in one go.</p>

<h2 id="large">4. Find and remove large files</h2>
<p>A handful of big files, such as old video projects, disk images or virtual machines, often take more space than thousands of small ones. Our guide on <a href="/guides/find-large-files-mac">how to find large files on a Mac</a> covers three ways to track them down, including Finder search by file size.</p>

<h2 id="caches">5. Clear caches</h2>
<p>Caches are files apps keep to load things faster. They're safe to clear because apps rebuild what they need, but some grow to several gigabytes. See <a href="/guides/clear-cache-mac">how to clear cache on a Mac</a> for the user cache folder and each browser.</p>

<h2 id="system-data">6. Shrink System Data</h2>
<p>If the Storage bar shows a huge grey <b>System Data</b> section, it's usually local Time Machine snapshots, caches and logs. Our guide <a href="/guides/system-data-mac">What is System Data on a Mac?</a> explains what's in it and what's safe to remove.</p>

<h2 id="apps">7. Uninstall apps you don't use</h2>
<p>Dragging an app to the Trash removes the app, but often leaves its support files behind in <code>~/Library/Application Support</code>, <code>~/Library/Caches</code> and <code>~/Library/Containers</code>. In <b>System Settings → General → Storage → Applications</b> you can sort apps by size and see when you last used them.</p>
<p>Gigapolis's free <b>App Uninstaller</b> removes an app together with the leftovers it can match to it, and Pro's Deep Clean finds leftovers from apps you removed in the past.</p>

<h2 id="photos">8. Remove duplicate photos</h2>
<p>The Photos app has a built-in <b>Duplicates</b> album (macOS Ventura and later) in the sidebar under Utilities, where you can merge exact and near-exact copies. Gigapolis's <b>Photo Studio</b> also finds look-alike shots, such as bursts of the same scene, and picks the sharpest copy for you to keep.</p>

<h2 id="icloud">9. Let iCloud store older files</h2>
<p>If you pay for iCloud storage, <b>Store in iCloud</b> (in the Storage settings) keeps recent files on your Mac and older ones in the cloud, downloading them when you open them. It doesn't delete anything, but it does mean those files need the internet to open.</p>

{cta("Do all of this from one window", "Gigapolis shows your storage as a 3D city, so the space hogs stand out at a glance. Street Sweep, Maintenance and the App Uninstaller are free (up to 20 GB of clean-up a month). Everything goes to the Trash first, and system folders are never touched.")}
""",
  related=["guides/system-data-mac", "guides/find-large-files-mac", "guides/clear-cache-mac", "alternatives/daisydisk"],
  faqs=[
    ("How much free space should a Mac have?", "Aim to keep at least 10–15% of your disk free, or around 20 GB on smaller drives. macOS needs room for updates, swap files and caches, and gets slow when the disk is nearly full."),
    ("Is it safe to delete System Data on a Mac?", "Not all of it. Caches, old logs and local Time Machine snapshots are safe to remove. Core macOS files are not, and you can't delete them anyway without turning off system protection."),
  ])

# ---------------------------------------------------------------- system data
page("guides/system-data-mac",
  title="What Is System Data on Mac and How to Clear It · Gigapolis",
  desc="System Data on a Mac is mostly Time Machine snapshots, caches and logs. Here's what's in it, what's safe to delete and how to shrink it.",
  h1="What is System Data on a Mac, and how do you clear it?",
  section="Guides", section_url="/guides/free-up-space-mac",
  body=f"""
<p class="lead">System Data (called “Other” in older versions of macOS) is the catch-all for everything macOS doesn't sort into a category like Apps, Photos or Documents. On most Macs, the big parts are <b>local Time Machine snapshots</b>, <b>caches</b> and <b>logs</b>. Those can be cleared safely. The rest is macOS itself, which you should leave alone.</p>

<div class="toc"><p>In this guide</p><ol>
<li><a href="#whats-in">What's in System Data</a></li>
<li><a href="#why-big">Why System Data gets so big</a></li>
<li><a href="#snapshots">Remove local Time Machine snapshots</a></li>
<li><a href="#caches">Clear caches and logs</a></li>
<li><a href="#other">Other things hiding in System Data</a></li>
<li><a href="#dont">What not to delete</a></li>
</ol></div>

<h2 id="whats-in">What's in System Data?</h2>
<p>Apple doesn't publish an exact list, but System Data usually includes:</p>
<ul>
<li><b>Local Time Machine snapshots</b>: copies of changed files that Time Machine keeps on your Mac between backups.</li>
<li><b>Caches</b>: files apps and macOS keep so things load faster.</li>
<li><b>Logs and diagnostic reports</b>.</li>
<li><b>Virtual memory</b> (swap files) and the sleep image.</li>
<li><b>iPhone and iPad backups</b> made in Finder.</li>
<li><b>Files in hidden or system folders</b> that macOS can't put in another category, such as virtual machines, app support files and some developer tools.</li>
<li><b>macOS itself</b>: the system volume and its updates.</li>
</ul>

<h2 id="why-big">Why is System Data so big?</h2>
<p>The usual cause is local snapshots. If Time Machine can't reach its backup drive for a while, it keeps snapshots on your Mac, and they can grow to tens of gigabytes. macOS is meant to remove them automatically when space runs low, but the Storage bar still counts them, which is why System Data can look alarming. Large caches (from browsers, video apps, Xcode or Docker) are the next most common cause.</p>

<h2 id="snapshots">Remove local Time Machine snapshots</h2>
<p>Open <b>Terminal</b> (in Applications → Utilities) and list the snapshots:</p>
<pre><code>tmutil listlocalsnapshots /</code></pre>
<p>Each line ends in a date like <code>2026-11-01-093015</code>. To delete one, use that date:</p>
<pre><code>sudo tmutil deletelocalsnapshots 2026-11-01-093015</code></pre>
<p>You'll be asked for your Mac's password. This only removes the copies on your Mac. <b>Backups on your Time Machine drive aren't touched.</b> Connecting your backup drive and letting a backup finish also lets macOS clear old snapshots on its own.</p>
<p>In Gigapolis, the free <b>Maintenance</b> tab has a <b>Clear Time Machine snapshots</b> button that does the same thing without Terminal.</p>

<h2 id="caches">Clear caches and logs</h2>
<p>In Finder, press <b>⇧⌘G</b> and go to <code>~/Library/Caches</code>. Each folder belongs to an app. Quit the app, then move its folder's contents to the Trash. Logs live in <code>~/Library/Logs</code>. Restart your Mac afterwards. Our <a href="/guides/clear-cache-mac">guide to clearing cache on a Mac</a> has more detail, including browsers.</p>
<p>Gigapolis's free <b>Street Sweep</b> lists the larger cache folders it can safely clear, and Maintenance can run macOS's own log clean-up scripts.</p>

<h2 id="other">Other things hiding in System Data</h2>
<ul>
<li><b>iPhone and iPad backups.</b> In Finder, select your device and click <b>Manage Backups</b> to delete old ones.</li>
<li><b>Developer files.</b> Xcode's DerivedData, simulators and Docker images can take tens of gigabytes.</li>
<li><b>Video editing caches.</b> Final Cut, Premiere and DaVinci Resolve keep render files that can be rebuilt.</li>
<li><b>Mail attachments</b> saved in the Mail library.</li>
</ul>
<p>Gigapolis Pro's <b>Deep Clean</b> looks for all four of these, and shows each item before anything is removed.</p>

<h2 id="dont">What not to delete</h2>
<p>Don't delete files in <code>/System</code>, <code>/Library</code> or <code>/private</code> by hand, and don't turn off System Integrity Protection to make room. macOS needs a certain amount of System Data to run, and on a modern Mac 12–20 GB of it is normal.</p>

{cta("See what's really in System Data", "Gigapolis scans the folders behind System Data, like caches, logs and app support files, and shows them in a 3D city of your disk, so you can see what is really taking the space. Free to download for Mac and Windows.")}
""",
  related=["guides/free-up-space-mac", "guides/clear-cache-mac", "guides/find-large-files-mac"],
  faqs=[
    ("Is it safe to delete System Data on a Mac?", "Parts of it. Local Time Machine snapshots, caches and logs are safe to remove. Core macOS files are not, and macOS stops you deleting them anyway."),
    ("Why does System Data keep growing?", "Usually because Time Machine keeps local snapshots while your backup drive is disconnected, and because app caches grow over time. Connecting your backup drive and clearing large caches normally brings it down."),
    ("What is a normal size for System Data?", "There's no fixed number, but 12–20 GB is common on a modern Mac. Anything much over 50 GB usually means snapshots or a large cache."),
  ])

# ---------------------------------------------------------------- large files
page("guides/find-large-files-mac",
  title="How to Find Large Files on a Mac (3 Easy Ways) · Gigapolis",
  desc="Find the biggest files on your Mac with Finder search, the Storage settings or a disk space analyzer, then remove what you don't need.",
  h1="How to find large files on a Mac",
  section="Guides", section_url="/guides/free-up-space-mac",
  body=f"""
<p class="lead">The quickest way to find large files on a Mac is a Finder search filtered by file size. macOS's Storage settings and a visual disk space analyzer are the other two options. Here's how each works, and when to use which.</p>

<h2 id="finder">1. Search by size in Finder</h2>
<ol>
<li>Open Finder and press <b>⌘F</b>.</li>
<li>Click <b>This Mac</b> so it searches everywhere.</li>
<li>Click the first menu (it says <b>Kind</b>) and choose <b>Other…</b>.</li>
<li>Tick <b>File Size</b> and click OK.</li>
<li>Set it to <b>is greater than 1 GB</b> (or 500 MB).</li>
</ol>
<p>Click the <b>Size</b> column header to sort the results, biggest first. Click the ＋ button to save the search to the sidebar for next time. Finder won't search inside system folders or some app libraries, so it can miss things.</p>

<h2 id="storage">2. Use the Storage settings</h2>
<p>Open <b>System Settings → General → Storage</b> and click ⓘ next to <b>Documents</b>. The <b>Large Files</b> tab lists your biggest documents, and you can delete them from there. It only covers your own documents, not apps, caches or System Data.</p>

<h2 id="analyzer">3. Use a disk space analyzer</h2>
<p>A disk space analyzer scans every folder and shows you where the space is going, which catches the large files Finder misses and the folders full of medium-sized files that add up.</p>
<p><a href="/">Gigapolis</a> draws your disk as a 3D city. Every category, such as Movies, Downloads or Apps, is a building, and the tallest buildings are the biggest. Click one to see its files, biggest first, tick the ones you don't need and move them to the Trash. Its free Street Sweep also lists files over 500 MB you haven't opened in six months.</p>

<h2 id="usual-suspects">Large files worth checking first</h2>
<ul>
<li>Old video projects and exports in Movies.</li>
<li>Disk images (<code>.dmg</code>, <code>.iso</code>) and installers in Downloads.</li>
<li>Virtual machines (Parallels, VMware, UTM).</li>
<li>iPhone backups (see <a href="/guides/system-data-mac">System Data</a>).</li>
<li>Game files and Steam libraries.</li>
</ul>

{cta("Spot the biggest files at a glance", "In Gigapolis, the tallest buildings are what's eating your space. Click one to see its files, biggest first. Free for Mac and Windows.", img="/img/files.jpg", alt="Gigapolis file list showing the biggest files in a category")}
""",
  related=["guides/free-up-space-mac", "guides/system-data-mac", "guides/clear-cache-mac"])

# ---------------------------------------------------------------- caches
page("guides/clear-cache-mac",
  title="How to Clear Cache on a Mac (System, App and Browser) · Gigapolis",
  desc="Clear user caches, app caches and browser caches on a Mac safely, step by step, and see which caches are worth clearing.",
  h1="How to clear cache on a Mac",
  section="Guides", section_url="/guides/free-up-space-mac",
  body=f"""
<p class="lead">Caches are files apps keep so they can load things faster. Clearing them is safe, because apps rebuild what they need, and it can free several gigabytes. The two places that matter are your user cache folder and your web browsers.</p>

<div class="note"><p>Clearing caches frees space for a while, but apps will gradually fill them up again. It's worth doing when a cache has grown very large, or when an app misbehaves.</p></div>

<h2 id="user">Clear your user caches</h2>
<ol>
<li>Quit the apps whose cache you want to clear.</li>
<li>In Finder, press <b>⇧⌘G</b>, type <code>~/Library/Caches</code> and press Return.</li>
<li>Switch to list view (<b>⌘2</b>) and choose <b>View → Show View Options → Calculate all sizes</b> to see which folders are biggest.</li>
<li>Open a big folder and move its <b>contents</b> to the Trash. Leave the folder itself in place.</li>
<li>Restart your Mac, then empty the Trash.</li>
</ol>
<p>There's also a system-wide cache folder at <code>/Library/Caches</code>. It's usually small and best left alone.</p>

<h2 id="safari">Clear the Safari cache</h2>
<p>In Safari, choose <b>Safari → Settings → Advanced</b> and turn on <b>Show features for web developers</b>. Then choose <b>Develop → Empty Caches</b> (<b>⌥⌘E</b>). This keeps your history and logins. To remove history and cookies too, use <b>History → Clear History</b>.</p>

<h2 id="chrome">Clear the Chrome, Edge or Brave cache</h2>
<p>Press <b>⇧⌘⌫</b> (Shift-Command-Delete) to open <b>Delete browsing data</b>. Choose a time range of <b>All time</b>, tick only <b>Cached images and files</b>, and click <b>Delete data</b>.</p>

<h2 id="firefox">Clear the Firefox cache</h2>
<p>Open <b>Firefox → Settings → Privacy &amp; Security</b>, scroll to <b>Cookies and Site Data</b>, click <b>Clear Data…</b>, tick <b>Temporary cached files and pages</b> only, and click Clear.</p>

<h2 id="big-caches">Caches that get really big</h2>
<ul>
<li><b>Video editors</b>: render and media caches from Final Cut, Premiere and DaVinci Resolve.</li>
<li><b>Developer tools</b>: Xcode DerivedData, package manager caches, Docker.</li>
<li><b>Music and streaming apps</b> that keep offline copies, like Spotify.</li>
</ul>

<h2 id="gigapolis">The one-click way</h2>
<p>Gigapolis's free <b>Street Sweep</b> lists every cache folder over 50 MB that's safe to clear, alongside the Trash and old downloads, and moves what you pick to the Trash. <b>Browser privacy</b> clears the cache for Safari, Chrome, Edge, Brave, Arc and Firefox for free (history and cookies need Pro), and Pro's Deep Clean handles video and developer caches.</p>

{cta("Clear caches in one click", "Street Sweep finds the caches, logs and leftovers your Mac and apps leave behind. Everything goes to the Trash first. Free for Mac and Windows.")}
""",
  related=["guides/free-up-space-mac", "guides/system-data-mac", "guides/find-large-files-mac"])

# ---------------------------------------------------------------- daisydisk
page("alternatives/daisydisk",
  title="DaisyDisk Alternatives for Mac, Free and Paid (2026) · Gigapolis",
  desc="Looking for a DaisyDisk alternative? Compare free and paid disk space analyzers for Mac: GrandPerspective, OmniDiskSweeper, Disk Inventory X and Gigapolis.",
  h1="DaisyDisk alternatives for Mac",
  section="Alternatives", section_url="/alternatives/daisydisk",
  body=f"""
<p class="lead">DaisyDisk is a well-loved, paid disk space analyzer for Mac that shows your disk as a sunburst of rings. If you want something free, something that also cleans, or something that runs on Windows too, these are the alternatives worth a look.</p>

<div class="note"><p><b>Full disclosure:</b> we make Gigapolis, one of the apps on this list. We've tried to describe every app fairly, including our own. Check each app's website for current prices.</p></div>

<h2 id="table">At a glance</h2>
<table>
<thead><tr><th>App</th><th>Price</th><th>Platforms</th><th>How it shows your disk</th><th>Cleaning tools</th></tr></thead>
<tbody>
<tr><td>DaisyDisk</td><td>Paid</td><td>Mac</td><td>Sunburst rings</td><td>Delete from the map</td></tr>
<tr><td>GrandPerspective</td><td>Free (open source)</td><td>Mac</td><td>Treemap of blocks</td><td>Delete from the map</td></tr>
<tr><td>OmniDiskSweeper</td><td>Free</td><td>Mac</td><td>Sorted folder list</td><td>Delete from the list</td></tr>
<tr><td>Disk Inventory X</td><td>Free (open source)</td><td>Mac</td><td>Treemap + folder list</td><td>Delete from the list</td></tr>
<tr><td>Gigapolis</td><td>Free, Pro $19.99 once</td><td>Mac + Windows</td><td>3D city, one building per category</td><td>Cache cleaner, uninstaller, duplicate photos, maintenance</td></tr>
</tbody>
</table>

<h2 id="grandperspective">GrandPerspective</h2>
<p>A free, open-source Mac app that draws your disk as a treemap: every file is a rectangle sized by how much space it takes. It's fast and light, and great for spotting one huge file. It has no cleaning tools beyond deleting what you find.</p>

<h2 id="omnidisksweeper">OmniDiskSweeper</h2>
<p>A free app from the Omni Group that lists your folders sorted by size, so you can drill down column by column. No visuals, but very simple and quick.</p>

<h2 id="disk-inventory-x">Disk Inventory X</h2>
<p>A free, open-source treemap app that pairs the map with a folder list. It's been around for many years, so it looks dated, but it still does the job.</p>

<h2 id="gigapolis">Gigapolis</h2>
<p><a href="/">Gigapolis</a> turns your disk into a 3D city, with a building for each category (Movies, Photos, Apps, Downloads, System Data and more). The tallest buildings are the biggest. Click one to list its files, biggest first.</p>
<p>Unlike the apps above, it also includes cleaning tools: <b>Street Sweep</b> for caches and old downloads, an <b>App Uninstaller</b> that removes leftovers, <b>Photo Studio</b> for duplicate photos, <b>Browser privacy</b> and <b>Maintenance</b> tasks like clearing Time Machine snapshots. It runs on both Mac and Windows. The free version includes the full scan, Street Sweep, the uninstaller and Maintenance, with a 20 GB monthly clean-up limit. Pro ($19.99, one-time) removes the limit and adds Deep Clean and full browser privacy.</p>
<p>Where DaisyDisk is better: it's a mature, polished app focused purely on mapping your disk, and many people prefer its rings for drilling into deep folder trees.</p>

<h2 id="which">Which should you pick?</h2>
<ul>
<li><b>Free and simple:</b> GrandPerspective or OmniDiskSweeper.</li>
<li><b>A map and clean-up tools in one app, on Mac and PC:</b> Gigapolis.</li>
<li><b>The most polished pure disk map on Mac:</b> DaisyDisk.</li>
</ul>

{cta("Try Gigapolis free", "See your disk as a 3D city and clean it up safely. Free for Mac and Windows, with a one-time Pro upgrade.")}
""",
  related=["guides/free-up-space-mac", "guides/find-large-files-mac", "guides/system-data-mac"])

# ---------------------------------------------------------------- render
for p, d in PAGES.items():
    TITLES[p] = d["h1"]

def render(path, d):
    url = f"{BASE}/{path}"
    crumbs = [("Home", f"{BASE}/"), (d["section"], BASE + d["section_url"]), (d["h1"], url)]
    graph = [
        {"@type": "Article", "headline": d["h1"], "description": d["desc"], "datePublished": DATE, "dateModified": DATE,
         "mainEntityOfPage": url, "image": f"{BASE}/img/og.jpg",
         "author": {"@type": "Organization", "name": "Gigapolis", "url": f"{BASE}/"},
         "publisher": {"@type": "Organization", "name": "Gigapolis", "logo": {"@type": "ImageObject", "url": f"{BASE}/img/icon.png"}}},
        {"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": n, "item": u} for i, (n, u) in enumerate(crumbs)]},
    ]
    faq_html = ""
    if d["faqs"]:
        graph.append({"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in d["faqs"]]})
        faq_html = '<h2 id="faq">Questions</h2>\n' + "\n".join(f"<h3>{q}</h3>\n<p>{a}</p>" for q, a in d["faqs"])
    ld = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False)
    rel = "\n".join(f'<li><a href="/{r}">{TITLES[r]}</a></li>' for r in d["related"])
    crumb_html = f'<a href="/">Home</a> › <a href="{d["section_url"]}">{d["section"]}</a>'
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{d["title"]}</title>
<meta name="description" content="{d["desc"]}">
<link rel="canonical" href="{url}">
<link rel="icon" href="/img/icon.png">
<meta name="theme-color" content="#b9583c">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Gigapolis">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{d["h1"]}">
<meta property="og:description" content="{d["desc"]}">
<meta property="og:image" content="{BASE}/img/og.jpg">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">
{ld}
</script>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="nav"><a class="brand" href="/"><img src="/img/icon.png" alt="" width="36" height="36">Gigapolis</a><nav><a class="btn btn-dark" style="padding:9px 16px" href="/#download">Download</a></nav></header>
  <article>
    <p class="crumbs">{crumb_html}</p>
    <h1>{d["h1"]}</h1>
    <p class="meta">By the Gigapolis team · Updated {DATE_H}</p>
{d["body"].strip()}
{faq_html}
    <div class="related"><h2>Related guides</h2><ul>
{rel}
    </ul></div>
  </article>
</div>
<footer><div class="wrap">© 2026 <a href="/">Gigapolis disk space analyzer</a> · <a href="/guides/free-up-space-mac">Free up space on Mac</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/refund">Refunds</a> · <a href="mailto:hello@getgigapolis.com">Contact</a></div></footer>
{TRACK}
</body>
</html>
"""

for p, d in PAGES.items():
    out = os.path.join(ROOT, "site", p + ".html")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w").write(render(p, d))
    print(out, len(d["title"]), len(d["desc"]))
