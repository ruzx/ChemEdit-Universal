// TLC photo processing — pure TypeScript on RGBA buffers (no DOM), so it runs on desktop and mobile.
//  1. detectPlate: find the bright plate (white silica / green-glowing F254 under UV) like a document scanner
//  2. warp: perspective-correct the plate to a rectangle (homography)
//  3. detectLines: pencil baseline / solvent front
//  4. detectSpots: spots that differ from the local background (dark UV shadows or coloured stains)

export interface Img { width: number; height: number; data: Uint8ClampedArray }
export interface Pt { x: number; y: number }
export interface Spot { x: number; y: number; r: number; area: number; strength: number }

export function makeImg(width: number, height: number): Img {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function luminance(img: Img): Float32Array {
  const n = img.width * img.height, L = new Float32Array(n), d = img.data;
  for (let i = 0; i < n; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return L;
}

/** Nearest-neighbour-free box downscale (area average). */
export function downscale(img: Img, maxDim: number): { img: Img; scale: number } {
  const s = Math.min(1, maxDim / Math.max(img.width, img.height));
  if (s >= 1) return { img, scale: 1 };
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const out = makeImg(w, h);
  const fx = img.width / w, fy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, c = 0;
      for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) {
        const i = (yy * img.width + xx) * 4;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; c++;
      }
      const o = (y * w + x) * 4;
      out.data[o] = r / c; out.data[o + 1] = g / c; out.data[o + 2] = b / c; out.data[o + 3] = 255;
    }
  }
  return { img: out, scale: s };
}

export function otsu(v: ArrayLike<number>): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < v.length; i++) hist[Math.max(0, Math.min(255, v[i] | 0))]++;
  const total = v.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

function erode(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    out[i] = mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w] ? 1 : 0;
  }
  return out;
}

/** Connected components (4-neighbour). Returns label array and component pixel lists sizes. */
function components(mask: Uint8Array, w: number, h: number, eight = false) {
  const lab = new Int32Array(mask.length).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    stack.push(s); lab[s] = id;
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      const x = i % w, y = (i / w) | 0;
      const nb = eight
        ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
        : [[0, -1], [-1, 0], [1, 0], [0, 1]];
      for (const [dx, dy] of nb) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (mask[j] && lab[j] < 0) { lab[j] = id; stack.push(j); }
      }
    }
    sizes.push(n);
  }
  return { lab, sizes };
}

/**
 * Find the TLC plate as the largest bright region and return its 4 corners (TL, TR, BR, BL)
 * in the coordinates of `img`, or null if nothing plate-like is found.
 */
export function detectPlate(src: Img): Pt[] | null {
  const { img, scale } = downscale(src, 320);
  const w = img.width, h = img.height;
  const L = luminance(img);
  const thr = otsu(L);
  let mask: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < L.length; i++) mask[i] = L[i] > thr ? 1 : 0;
  mask = erode(mask, w, h);
  const { lab, sizes } = components(mask, w, h);
  if (!sizes.length) return null;
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  if (sizes[best] < 0.04 * w * h) return null;
  let tl = { v: Infinity, p: { x: 0, y: 0 } }, br = { v: -Infinity, p: { x: 0, y: 0 } };
  let tr = { v: -Infinity, p: { x: 0, y: 0 } }, bl = { v: Infinity, p: { x: 0, y: 0 } };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (lab[y * w + x] !== best) continue;
    const s = x + y, d = x - y;
    if (s < tl.v) tl = { v: s, p: { x, y } };
    if (s > br.v) br = { v: s, p: { x, y } };
    if (d > tr.v) tr = { v: d, p: { x, y } };
    if (d < bl.v) bl = { v: d, p: { x, y } };
  }
  const back = (p: Pt) => ({ x: (p.x + 0.5) / scale, y: (p.y + 0.5) / scale });
  const quad = [back(tl.p), back(tr.p), back(br.p), back(bl.p)];
  if (polyArea(quad) < 0.06 * src.width * src.height) return null;
  return quad;
}

export function polyArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; }
  return Math.abs(a) / 2;
}

/** Homography H with H·(u,v,1) ∝ (x,y,1) mapping each from[i] to to[i]. */
export function homography(from: Pt[], to: Pt[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = from[i], { x, y } = to[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  // Gaussian elimination
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c] || 1e-12;
    for (let k = c; k < 9; k++) A[c][k] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f) for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [A[0][8], A[1][8], A[2][8], A[3][8], A[4][8], A[5][8], A[6][8], A[7][8], 1];
}

/** Output size that preserves the plate's aspect ratio (max side `maxDim`). */
export function warpSize(q: Pt[], maxDim = 900): { w: number; h: number } {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = (d(q[0], q[1]) + d(q[3], q[2])) / 2, h = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  const s = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.max(8, Math.round(w * s)), h: Math.max(8, Math.round(h * s)) };
}

/** Perspective-correct quad (TL, TR, BR, BL) of img into a w×h rectangle (bilinear sampling). */
export function warp(img: Img, quad: Pt[], w: number, h: number): Img {
  const H = homography([{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }], quad);
  const out = makeImg(w, h), s = img.data, W = img.width, Hh = img.height;
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
    const z = H[6] * u + H[7] * v + H[8];
    const x = (H[0] * u + H[1] * v + H[2]) / z, y = (H[3] * u + H[4] * v + H[5]) / z;
    const x0 = Math.max(0, Math.min(W - 2, Math.floor(x))), y0 = Math.max(0, Math.min(Hh - 2, Math.floor(y)));
    const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
    const o = (v * w + u) * 4;
    for (let c = 0; c < 3; c++) {
      const a = s[(y0 * W + x0) * 4 + c], b = s[(y0 * W + x0 + 1) * 4 + c];
      const cc = s[((y0 + 1) * W + x0) * 4 + c], dd = s[((y0 + 1) * W + x0 + 1) * 4 + c];
      out.data[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + dd * fx) * fy;
    }
    out.data[o + 3] = 255;
  }
  return out;
}

/** Box blur of each RGB channel with radius r (integral images). Returns Float32 RGB planes. */
function boxBlurRGB(img: Img, r: number): Float32Array[] {
  const w = img.width, h = img.height;
  const out: Float32Array[] = [];
  for (let c = 0; c < 3; c++) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += img.data[(y * w + x) * 4 + c];
        I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
      }
    }
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
        o[y * w + x] = s / ((y1 - y0) * (x1 - x0));
      }
    }
    out.push(o);
  }
  return out;
}

export interface Contrast { D: Float32Array; darker: Uint8Array; w: number; h: number; mean: number; std: number }

/** Colour distance of each pixel from the local background (large box blur). */
export function contrastMap(plate: Img): Contrast {
  const w = plate.width, h = plate.height;
  const bg = boxBlurRGB(plate, Math.max(4, Math.round(Math.min(w, h) / 9)));
  const D = new Float32Array(w * h), darker = new Uint8Array(w * h);
  let sum = 0, sum2 = 0;
  for (let i = 0; i < w * h; i++) {
    const dr = plate.data[i * 4] - bg[0][i], dg = plate.data[i * 4 + 1] - bg[1][i], db = plate.data[i * 4 + 2] - bg[2][i];
    const v = Math.sqrt(dr * dr + dg * dg + db * db);
    D[i] = v; sum += v; sum2 += v * v;
    darker[i] = dr + dg + db < 0 ? 1 : 0;
  }
  const mean = sum / D.length, std = Math.sqrt(Math.max(0, sum2 / D.length - mean * mean));
  return { D, darker, w, h, mean, std };
}

/** Pencil baseline / solvent front as fractions of plate height (null when not found). */
export function detectLines(plate: Img, cm = contrastMap(plate)): { baseline: number | null; front: number | null } {
  const { D, darker, w, h, mean, std } = cm;
  const t = Math.max(8, mean + 1.2 * std);
  const x0 = Math.round(w * 0.04), x1 = Math.round(w * 0.96);
  const rows: number[] = [];
  for (let y = Math.round(h * 0.03); y < h * 0.97; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (D[y * w + x] > t && darker[y * w + x]) n++;
    rows.push(n / (x1 - x0) > 0.45 ? y : -1);
  }
  const groups: number[] = [];
  let start = -1, last = -1;
  for (const y of rows) {
    if (y < 0) continue;
    if (start < 0 || y > last + 1) { if (start >= 0) groups.push((start + last) / 2); start = y; }
    last = y;
  }
  if (start >= 0) groups.push((start + last) / 2);
  const lower = groups.filter((g) => g > h * 0.55), upper = groups.filter((g) => g < h * 0.45);
  return {
    baseline: lower.length ? Math.max(...lower) / h : null,
    front: upper.length ? Math.min(...upper) / h : null,
  };
}

/**
 * Spots = connected regions that differ from the local background.
 * sensitivity 0..1 (0.5 default): higher finds fainter spots.
 */
export function detectSpots(plate: Img, sensitivity = 0.5, cm = contrastMap(plate), lines?: { baseline: number | null; front: number | null }): Spot[] {
  const { D, w, h, mean, std } = cm;
  const k = 3.2 - 2.4 * Math.max(0, Math.min(1, sensitivity));
  const t = Math.max(10, mean + k * std);
  const mask = new Uint8Array(w * h);
  const mx = Math.round(w * 0.035), my = Math.round(h * 0.025);
  for (let y = my; y < h - my; y++) for (let x = mx; x < w - mx; x++) if (D[y * w + x] > t) mask[y * w + x] = 1;
  const { lab, sizes } = components(mask, w, h, true);
  const acc = sizes.map(() => ({ sx: 0, sy: 0, sw: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }));
  for (let i = 0; i < lab.length; i++) {
    const id = lab[i];
    if (id < 0) continue;
    const x = i % w, y = (i / w) | 0, v = D[i];
    const a = acc[id];
    a.sx += x * v; a.sy += y * v; a.sw += v;
    if (x < a.minX) a.minX = x; if (x > a.maxX) a.maxX = x; if (y < a.minY) a.minY = y; if (y > a.maxY) a.maxY = y;
  }
  const area = w * h;
  const spots: Spot[] = [];
  sizes.forEach((n, id) => {
    const a = acc[id];
    const bw = a.maxX - a.minX + 1, bh = a.maxY - a.minY + 1;
    if (n < Math.max(6, 0.00025 * area) || n > 0.09 * area) return;
    if (bw > 0.45 * w || bw / bh > 4.5) return; // pencil lines / edges
    if (bh < 3) return;
    const cy = a.sy / a.sw;
    if (lines) for (const l of [lines.baseline, lines.front]) if (l !== null && Math.abs(cy / h - l) < 0.012 && bw / bh > 2.5) return;
    spots.push({ x: a.sx / a.sw, y: cy, r: Math.max(bw, bh) / 2 + 2, area: n, strength: a.sw });
  });
  return spots.sort((p, q) => p.x - q.x || p.y - q.y);
}

/** Group spots into lanes (columns). Returns lane index for each spot and lane centres (x). */
export function clusterLanes(spots: Spot[], width: number): { lane: number[]; centres: number[] } {
  const order = spots.map((s, i) => i).sort((a, b) => spots[a].x - spots[b].x);
  const lane = new Array<number>(spots.length).fill(0);
  const centres: number[] = [];
  let cur: number[] = [];
  const flush = () => { if (cur.length) { centres.push(cur.reduce((s, i) => s + spots[i].x, 0) / cur.length); cur.forEach((i) => (lane[i] = centres.length - 1)); cur = []; } };
  let lastX = -Infinity;
  for (const i of order) {
    if (spots[i].x - lastX > 0.08 * width) flush();
    cur.push(i);
    lastX = spots[i].x;
  }
  flush();
  return { lane, centres };
}

export function rfValue(y: number, baseline: number, front: number): number {
  const v = (baseline - y) / (baseline - front || 1);
  return Math.max(0, Math.min(1, Math.round(v * 100) / 100));
}
