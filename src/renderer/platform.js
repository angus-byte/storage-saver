// Words that differ between macOS and Windows. The UI is written with the Mac
// words; on Windows a MutationObserver swaps the phrases below in every piece
// of text as it appears (toasts, panels, City Hall...). File names (.name)
// are left alone.
export const IS_WIN = !!(window.storage && window.storage.platform === 'win32');

const WIN_PHRASES = [
  [/\bFinder \/ Explorer\b/g, 'File Explorer'],
  [/\bFinder\b/g, 'File Explorer'],
  [/\bto Trash\b/g, 'to the Recycle Bin'],
  [/\bthe Trash\b/g, 'the Recycle Bin'],
  [/\bthe Bin\b/g, 'the Recycle Bin'],
  [/\bmacOS\b/g, 'Windows'],
  [/\b(this|your|another|the|a) Mac\b/g, '$1 PC'],
];

export function localize(text) {
  if (!IS_WIN || !text) return text;
  let out = text;
  for (const [re, to] of WIN_PHRASES) out = out.replace(re, to);
  return out;
}

function fixNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const p = node.parentElement;
    if (p && p.closest('.name, script, style')) return;
    const t = localize(node.nodeValue);
    if (t !== node.nodeValue) node.nodeValue = t;
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    if (node.title) node.title = localize(node.title);
    for (const c of node.childNodes) fixNode(c);
  }
}

export function localizeDom(root = document.body) {
  if (!IS_WIN) return;
  document.documentElement.classList.add('win');
  fixNode(root);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') fixNode(m.target);
      else for (const n of m.addedNodes) fixNode(n);
    }
  }).observe(root, { childList: true, subtree: true, characterData: true });
}
