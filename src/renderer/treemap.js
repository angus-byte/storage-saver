// Squarified treemap layout (Bruls, Huizing, van Wijk).
// items: [{size}] sorted desc. rect: {x, y, w, h}. Returns [{x, y, w, h, item}].
export function squarify(items, rect) {
  const total = items.reduce((s, i) => s + i.size, 0);
  if (total <= 0 || items.length === 0) return [];
  const area = rect.w * rect.h;
  const scaled = items.map((item) => ({ item, area: (item.size / total) * area }));
  const out = [];
  let { x, y, w, h } = rect;
  let row = [];
  let i = 0;

  const worst = (row, side) => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    if (sum === 0) return Infinity;
    let max = 0;
    let min = Infinity;
    for (const r of row) {
      max = Math.max(max, r.area);
      min = Math.min(min, r.area);
    }
    const s2 = sum * sum;
    return Math.max((side * side * max) / s2, s2 / (side * side * min));
  };

  const layoutRow = (row) => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    if (w >= h) {
      // Lay the row along the left edge, vertically.
      const rw = sum / h;
      let cy = y;
      for (const r of row) {
        const rh = r.area / rw;
        out.push({ x, y: cy, w: rw, h: rh, item: r.item });
        cy += rh;
      }
      x += rw;
      w -= rw;
    } else {
      const rh = sum / w;
      let cx = x;
      for (const r of row) {
        const rw = r.area / rh;
        out.push({ x: cx, y, w: rw, h: rh, item: r.item });
        cx += rw;
      }
      y += rh;
      h -= rh;
    }
  };

  while (i < scaled.length) {
    const side = Math.min(w, h);
    const next = scaled[i];
    if (row.length === 0 || worst([...row, next], side) <= worst(row, side)) {
      row.push(next);
      i++;
    } else {
      layoutRow(row);
      row = [];
    }
    if (w <= 0 || h <= 0) break;
  }
  if (row.length) layoutRow(row);
  return out;
}
