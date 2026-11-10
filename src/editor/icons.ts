// Inline SVG icons (20x20, stroke = currentColor).

const wrap = (inner: string, fill = false) =>
  `<svg viewBox="0 0 20 20" width="20" height="20" fill="${fill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const poly = (n: number, r = 7, cx = 10, cy = 10.5, inner = false) => {
  const off = n === 4 || n === 8 ? -90 + 180 / n : -90;
  const pts = Array.from({ length: n }, (_, k) => {
    const a = ((off + (360 * k) / n) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
  let s = `<polygon points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}"/>`;
  if (inner) {
    for (let k = 0; k < n; k += 2) {
      const [a, b] = [pts[k], pts[(k + 1) % n]];
      const sh = (p: number[]) => [cx + (p[0] - cx) * 0.68, cy + (p[1] - cy) * 0.68];
      const A = sh(a), B = sh(b);
      s += `<line x1="${A[0].toFixed(1)}" y1="${A[1].toFixed(1)}" x2="${B[0].toFixed(1)}" y2="${B[1].toFixed(1)}"/>`;
    }
  }
  return s;
};

export const ICONS: Record<string, string> = {
  select: wrap(`<path d="M5 3l10 6.5-4.6 1 2.8 5-1.9 1-2.8-5L5 14.5z" fill="currentColor" stroke-width="1"/>`),
  lasso: wrap(`<rect x="3" y="4" width="14" height="11" rx="1" stroke-dasharray="2.5 2"/>`),
  erase: wrap(`<path d="M8.5 16.5h8M3.6 12.4l7.8-7.8a1.4 1.4 0 0 1 2 0l2.9 2.9a1.4 1.4 0 0 1 0 2L10 16.5H6.4l-2.8-2.8a.9.9 0 0 1 0-1.3z"/><path d="M7.2 8.8l4.9 4.9"/>`),
  single: wrap(`<line x1="4" y1="15" x2="16" y2="5"/>`),
  double: wrap(`<line x1="3.5" y1="13.5" x2="14.5" y2="4.5"/><line x1="5.5" y1="16" x2="16.5" y2="7"/>`),
  triple: wrap(`<line x1="3" y1="12.5" x2="13.5" y2="3.5"/><line x1="4.7" y1="14.8" x2="15.3" y2="5.6"/><line x1="6.5" y1="17" x2="17" y2="8"/>`),
  wedge: wrap(`<path d="M4 15.5 L15 3.8 L17.2 6.4 Z" fill="currentColor"/>`),
  hash: wrap(`<path d="M5 15l.6.6M7 12.7l1.2 1.3M9 10.3l1.8 1.9M11 8l2.4 2.5M13 5.7l3 3.1"/>`),
  wavy: wrap(`<path d="M3 15c1.2-2.6 2.6.2 3.8-2.4s2.6.2 3.8-2.4 2.6.2 3.8-2.4 2.2-.4 2.6-2.8"/>`),
  chain: wrap(`<path d="M2.5 13l3.75-5 3.75 5 3.75-5 3.75 5"/>`),
  r3: wrap(poly(3)), r4: wrap(poly(4)), r5: wrap(poly(5)), r6: wrap(poly(6)), r7: wrap(poly(7)), r8: wrap(poly(8)),
  benzene: wrap(poly(6, 7, 10, 10.5, true)),
  plusCharge: wrap(`<circle cx="10" cy="10" r="6.5"/><path d="M10 6.8v6.4M6.8 10h6.4"/>`),
  minusCharge: wrap(`<circle cx="10" cy="10" r="6.5"/><path d="M6.8 10h6.4"/>`),
  arrow: wrap(`<path d="M2.5 10h13"/><path d="M12.5 6.5 17 10l-4.5 3.5z" fill="currentColor"/>`),
  equilibrium: wrap(`<path d="M3 8h13l-3.5-3M17 12H4l3.5 3"/>`),
  retro: wrap(`<path d="M2.5 8h12M2.5 12h12M12.5 4.5 17 10l-4.5 5.5"/>`),
  resonance: wrap(`<path d="M5 10h10"/><path d="M14 7l4 3-4 3zM6 7l-4 3 4 3z" fill="currentColor"/>`),
  dashed: wrap(`<path d="M2.5 10h2M6.5 10h2M10.5 10h3" /><path d="M13 6.5 17.5 10 13 13.5z" fill="currentColor"/>`),
  plus: wrap(`<path d="M10 4v12M4 10h12" stroke-width="2"/>`),
  text: wrap(`<path d="M4.5 5V3.8h11V5M10 3.8v12.4M7.5 16.2h5"/>`),
  undo: wrap(`<path d="M7.5 5 3.8 8.6l3.7 3.6"/><path d="M4 8.6h7.5a4.5 4.5 0 0 1 0 9H8"/>`),
  redo: wrap(`<path d="m12.5 5 3.7 3.6-3.7 3.6"/><path d="M16 8.6H8.5a4.5 4.5 0 0 0 0 9H12"/>`),
  clean: wrap(`<path d="M10 2.5l1.4 3.6 3.6 1.4-3.6 1.4L10 12.5 8.6 8.9 5 7.5l3.6-1.4zM15.5 12l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8zM4.5 13l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4L2.5 15l1.4-.6z"/>`),
  flipH: wrap(`<path d="M10 2.5v15" stroke-dasharray="2 2"/><path d="M7.5 5 3 15h4.5zM12.5 5 17 15h-4.5z"/>`),
  flipV: wrap(`<path d="M2.5 10h15" stroke-dasharray="2 2"/><path d="M5 7.5 15 3v4.5zM5 12.5 15 17v-4.5z"/>`),
  zoomIn: wrap(`<circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.6 12.6 17 17M6 8.5h5M8.5 6v5"/>`),
  zoomOut: wrap(`<circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.6 12.6 17 17M6 8.5h5"/>`),
  fit: wrap(`<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/><rect x="7" y="7" width="6" height="6" rx="1"/>`),
  copy: wrap(`<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7"/>`),
  help: wrap(`<circle cx="10" cy="10" r="7.5"/><path d="M7.8 7.8a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5v.4M10 14.6v.1"/>`),
  table: wrap(`<rect x="2.5" y="4" width="3.5" height="3.5"/><rect x="14" y="4" width="3.5" height="3.5"/><rect x="2.5" y="8.5" width="3.5" height="3.5"/><rect x="7" y="8.5" width="3" height="3.5"/><rect x="11" y="8.5" width="2.5" height="3.5"/><rect x="14" y="8.5" width="3.5" height="3.5"/><path d="M4 15h12"/>`),
  trash: wrap(`<path d="M3.5 5.5h13M8 5.5V3.8h4v1.7M5 5.5l.8 11h8.4l.8-11"/>`),
  import: wrap(`<path d="M10 3v9M6.5 8.5 10 12l3.5-3.5M3.5 13.5v3h13v-3"/>`),
  tmpl: wrap(`<path d="M6.5 4.2 10 2.2l3.5 2v4L10 10.2l-3.5-2zM10 10.2v3.6M10 13.8l-3.5 2v0M10 13.8l3.5 2"/><circle cx="6.5" cy="16" r="1.3"/><circle cx="13.5" cy="16" r="1.3"/>`),
  more: wrap(`<circle cx="4.5" cy="10" r="1.3" fill="currentColor"/><circle cx="10" cy="10" r="1.3" fill="currentColor"/><circle cx="15.5" cy="10" r="1.3" fill="currentColor"/>`),
  sigma: wrap(`<path d="M15 4H5l5.5 6L5 16h10"/>`),
  download: wrap(`<path d="M10 3v9M6.5 8.5 10 12l3.5-3.5M3.5 13.5v3h13v-3"/>`),
  open: wrap(`<path d="M2.8 15.5V5a1 1 0 0 1 1-1h4l1.6 1.8h6.8a1 1 0 0 1 1 1v1.4"/><path d="M2.8 15.5 5 9h13l-2.2 6.5z"/>`),
  rotate: wrap(`<path d="M15.5 7A6.5 6.5 0 1 0 16.5 11"/><path d="M16 3v4.2h-4.2"/>`),
};
