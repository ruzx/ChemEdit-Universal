// SVG renderer in ChemDraw "ACS Document 1996" proportions.

import { elementColor } from "../chem/elements";
import { Atom, Bond, ChemDoc, Graph, buildGraph, hydrogenCount, isOverValent } from "../chem/model";
import { findRings, RingInfo } from "../chem/rings";
import { reversedLabel } from "../chem/abbrev";

export interface RenderOptions {
  bondLength?: number; // px per standard bond
  colorAtoms?: boolean;
  color?: string; // main ink
  fontFamily?: string;
  padding?: number;
  showCarbons?: boolean;
  showValenceErrors?: boolean;
  background?: string | null;
  /** scale factor for the outer width/height attributes */
  scale?: number;
  maxWidth?: number;
  maxHeight?: number;
  metadata?: string; // raw (already escaped) XML placed in <metadata>
  className?: string;
}

const DEF: Required<Omit<RenderOptions, "metadata" | "maxWidth" | "maxHeight" | "className">> = {
  bondLength: 24,
  colorAtoms: true,
  color: "currentColor",
  fontFamily: "Arial, Helvetica, sans-serif",
  padding: 8,
  showCarbons: false,
  showValenceErrors: false,
  background: null,
  scale: 1,
};

// ACS 1996: bond 14.4pt, line 0.6pt, bold 2pt, spacing 18%, hash 2.5pt, font 10pt, margin 1.6pt
const R_LINE = 0.6 / 14.4, R_WEDGE = 2.0 / 14.4, R_SPACING = 0.18, R_HASH = 2.5 / 14.4, R_FONT = 10 / 14.4, R_MARGIN = 1.6 / 14.4;

// rough Arial advance widths (em)
const W: Record<string, number> = {
  i: 0.222, j: 0.222, l: 0.222, f: 0.278, t: 0.278, r: 0.333, I: 0.278, J: 0.5, "(": 0.333, ")": 0.333, " ": 0.278,
  m: 0.833, w: 0.722, M: 0.833, W: 0.944, "+": 0.584, "-": 0.333, "−": 0.584, ",": 0.278, ".": 0.278, "°": 0.4,
};
const charW = (c: string) => W[c] ?? (c >= "A" && c <= "Z" ? 0.667 : c >= "0" && c <= "9" ? 0.556 : 0.556);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n2 = (v: number) => (Math.round(v * 100) / 100).toString();

interface Seg { t: string; sub?: boolean; sup?: boolean }
interface LabelBox { x0: number; x1: number; y0: number; y1: number }

interface Ctx {
  o: typeof DEF;
  bl: number; lw: number; fs: number; sp: number; margin: number;
  g: Graph; ri: RingInfo;
  boxes: Map<number, LabelBox>;
  out: string[];
  minX: number; minY: number; maxX: number; maxY: number;
}

const ext = (c: Ctx, x: number, y: number) => {
  if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x; if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
};

function splitDigits(text: string, mode: "label" | "free"): Seg[] {
  const segs: Seg[] = [];
  let prev = "";
  for (const ch of text) {
    const isDigit = ch >= "0" && ch <= "9";
    const sub = isDigit && (mode === "label" ? prev !== "" : /[A-Za-z)\]]/.test(prev) || (segs.length && segs[segs.length - 1].sub && /\d/.test(prev)));
    const last = segs[segs.length - 1];
    if (last && !!last.sub === !!sub && !last.sup) last.t += ch;
    else segs.push({ t: ch, sub: !!sub });
    prev = ch;
  }
  return segs;
}

function segWidth(s: Seg, fs: number) {
  let w = 0;
  for (const ch of s.t) w += charW(ch);
  return w * fs * (s.sub || s.sup ? 0.7 : 1);
}

/** Build label segments for an atom; returns null if no label drawn. */
interface LabelSpec { segs: Seg[]; anchor: number; anchorChar: number; color: string; vert?: { segs: Seg[]; up: boolean } }
function atomLabel(c: Ctx, a: Atom): LabelSpec | null {
  const g = c.g;
  const deg = g.adj.get(a.id)!.length;
  const color = c.o.colorAtoms ? elementColor(a.el) ?? c.o.color : c.o.color;
  const nbs = g.adj.get(a.id)!.map(({ nb }) => g.atomById.get(nb)!);
  let sumDx = 0;
  for (const nb of nbs) sumDx += nb.x - a.x;
  const fromRight = nbs.length > 0 && sumDx > 0.05;
  if (a.label) {
    const txt = fromRight && nbs.length === 1 ? reversedLabel(a.label) : a.label;
    const segs = splitDigits(txt, "label");
    if (a.charge) segs.push({ t: chargeText(a.charge), sup: true });
    const reversed = txt !== a.label;
    // anchor: first char normally, last "real" char when reversed
    if (reversed) {
      let si = segs.length - 1;
      while (si > 0 && (segs[si].sub || segs[si].sup)) si--;
      return { segs, anchor: si, anchorChar: segs[si].t.length - 1, color: c.o.color };
    }
    return { segs, anchor: 0, anchorChar: 0, color: c.o.color };
  }
  const isC = a.el === "C";
  if (isC && !c.o.showCarbons && deg > 0 && !a.isotope && !(a.charge && deg === 0)) return null;
  const h = hydrogenCount(g, a);
  const segs: Seg[] = [];
  if (a.isotope) segs.push({ t: String(a.isotope), sup: true });
  const main = a.el === "*" ? "R" : a.el;
  const hSegs: Seg[] = h ? [{ t: "H" }, ...(h > 1 ? [{ t: String(h), sub: true }] : [])] : [];
  const chg: Seg[] = a.charge ? [{ t: chargeText(a.charge), sup: true }] : [];
  const rad: Seg[] = a.radical ? [{ t: "•", sup: true }] : [];
  // choose H side: right, left, above, below (first free sector)
  const angs = nbs.map((nb) => Math.atan2(nb.y - a.y, nb.x - a.x) * 180 / Math.PI);
  const occupied = (lo: number, hi: number) => angs.some((t) => (lo <= hi ? t > lo && t < hi : t > lo || t < hi));
  let hPos: "r" | "l" | "u" | "d" = "r";
  if (h && nbs.length) {
    if (!occupied(-55, 55)) hPos = "r";
    else if (!occupied(125, -125)) hPos = "l";
    else if (!occupied(-145, -35)) hPos = "u";
    else if (!occupied(35, 145)) hPos = "d";
    else hPos = fromRight ? "l" : "r";
    if (nbs.length === 1 && hPos === "r" && fromRight) hPos = "l";
  } else if (h && !nbs.length && ["O", "S", "Se", "Te", "F", "Cl", "Br", "I"].includes(a.el)) hPos = "l"; // H2O, HCl
  if (h && hPos === "l") {
    segs.push(...hSegs);
    const anchor = segs.length;
    segs.push({ t: main }, ...chg, ...rad);
    return { segs, anchor, anchorChar: 0, color };
  }
  const anchor = segs.length;
  if (h && (hPos === "u" || hPos === "d")) {
    segs.push({ t: main }, ...chg, ...rad);
    return { segs, anchor, anchorChar: 0, color, vert: { segs: hSegs, up: hPos === "u" } };
  }
  segs.push({ t: main }, ...hSegs, ...chg, ...rad);
  return { segs, anchor, anchorChar: 0, color };
}

function chargeText(q: number) {
  const n = Math.abs(q);
  return (n > 1 ? String(n) : "") + (q > 0 ? "+" : "−");
}

function drawLabel(c: Ctx, a: Atom) {
  const lab = atomLabel(c, a);
  if (!lab) return;
  const { fs } = c;
  const widths = lab.segs.map((s) => segWidth(s, fs));
  let before = 0;
  for (let i = 0; i < lab.anchor; i++) before += widths[i];
  const as = lab.segs[lab.anchor];
  let inSeg = 0;
  for (let k = 0; k < lab.anchorChar; k++) inSeg += charW(as.t[k]) * fs;
  const anchorW = charW(as.t[lab.anchorChar] ?? "C") * fs;
  const x0 = a.x - before - inSeg - anchorW / 2;
  const base = a.y + 0.358 * fs;
  const total = widths.reduce((s, w) => s + w, 0);
  let s = `<text x="${n2(x0)}" y="${n2(base)}" font-size="${n2(fs)}" fill="${lab.color}">`;
  let dyState = 0;
  lab.segs.forEach((sg) => {
    const want = sg.sub ? 0.28 * fs : sg.sup ? -0.42 * fs : 0;
    const dy = want - dyState;
    dyState = want;
    const size = sg.sub || sg.sup ? ` font-size="${n2(fs * 0.7)}"` : "";
    s += `<tspan${dy ? ` dy="${n2(dy)}"` : ""}${size}>${esc(sg.t)}</tspan>`;
  });
  s += "</text>";
  c.out.push(s);
  const m = c.margin;
  let y0 = a.y - 0.37 * fs - m, y1 = a.y + 0.37 * fs + m;
  if (lab.vert) {
    const vw = lab.vert.segs.reduce((acc, sg) => acc + segWidth(sg, fs), 0);
    const vy = lab.vert.up ? base - fs * 0.95 : base + fs * 0.95;
    let t = `<text x="${n2(a.x - charW("H") * fs / 2)}" y="${n2(vy)}" font-size="${n2(fs)}" fill="${lab.color}">`;
    let st = 0;
    for (const sg of lab.vert.segs) { const want = sg.sub ? 0.28 * fs : 0; const dy = want - st; st = want; t += `<tspan${dy ? ` dy="${n2(dy)}"` : ""}${sg.sub ? ` font-size="${n2(fs * 0.7)}"` : ""}>${esc(sg.t)}</tspan>`; }
    c.out.push(t + "</text>");
    if (lab.vert.up) y0 -= fs * 0.95; else y1 += fs * 0.95;
    ext(c, a.x - vw, vy - fs); ext(c, a.x + vw, vy + fs * 0.3);
  }
  // clipping box: full label text +- margin
  c.boxes.set(a.id, { x0: x0 - m, x1: x0 + total + m, y0, y1 });
  // tighter box around the anchor glyph used for bonds coming from the far side
  ext(c, x0 - 2, a.y - fs * 0.7); ext(c, x0 + total + 2, a.y + fs * 0.6);
}

/** Parameter t (0..1) at which segment A->B leaves the label box around A. */
function clipT(box: LabelBox | undefined, ax: number, ay: number, bx: number, by: number): number {
  if (!box) return 0;
  const dx = bx - ax, dy = by - ay;
  let t = 1;
  if (dx > 1e-9) t = Math.min(t, (box.x1 - ax) / dx); else if (dx < -1e-9) t = Math.min(t, (box.x0 - ax) / dx);
  if (dy > 1e-9) t = Math.min(t, (box.y1 - ay) / dy); else if (dy < -1e-9) t = Math.min(t, (box.y0 - ay) / dy);
  return Math.max(0, Math.min(1, t));
}

function line(c: Ctx, x1: number, y1: number, x2: number, y2: number, extra = "") {
  c.out.push(`<line x1="${n2(x1)}" y1="${n2(y1)}" x2="${n2(x2)}" y2="${n2(y2)}"${extra}/>`);
  ext(c, x1, y1); ext(c, x2, y2);
}

function bondSide(c: Ctx, b: Bond, A: Atom, B: Atom): { side: number; inRing: boolean } {
  const rings = c.ri.bondRings.get(b.id);
  const dx = B.x - A.x, dy = B.y - A.y;
  if (rings && rings.length) {
    // prefer the ring with most double bonds, then smallest
    let best = rings[0], bestScore = -Infinity;
    for (const r of rings) {
      const dbl = c.ri.ringBondIds[r].filter((id) => c.g.adj.get(c.ri.rings[r][0]) && dblIds.has(id)).length;
      const sc = dbl * 10 - c.ri.rings[r].length;
      if (sc > bestScore) { bestScore = sc; best = r; }
    }
    let cx = 0, cy = 0;
    for (const id of c.ri.rings[best]) { const at = c.g.atomById.get(id)!; cx += at.x; cy += at.y; }
    cx /= c.ri.rings[best].length; cy /= c.ri.rings[best].length;
    const cr = dx * (cy - A.y) - dy * (cx - A.x);
    return { side: cr > 0 ? 1 : -1, inRing: true };
  }
  let s = 0;
  for (const [at, other] of [[A, B], [B, A]] as const) {
    for (const { nb } of c.g.adj.get(at.id)!) {
      if (nb === other.id) continue;
      const q = c.g.atomById.get(nb)!;
      const cr = dx * (q.y - A.y) - dy * (q.x - A.x);
      s += cr > 0 ? 1 : -1;
    }
  }
  return { side: s >= 0 ? 1 : -1, inRing: false };
}
let dblIds = new Set<number>();

function drawBond(c: Ctx, b: Bond) {
  const A = c.g.atomById.get(b.a), B = c.g.atomById.get(b.b);
  if (!A || !B) return;
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  if (L < 1e-6) return;
  const ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
  const px = -uy, py = ux; // perpendicular (left of A->B in screen coords)
  const boxA = c.boxes.get(A.id), boxB = c.boxes.get(B.id);
  const clip = (ax: number, ay: number, bx: number, by: number): [number, number, number, number] | null => {
    const t0 = clipT(boxA, ax, ay, bx, by);
    const t1 = 1 - clipT(boxB, bx, by, ax, ay);
    if (t1 - t0 < 0.02) return null;
    return [ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1];
  };
  const seg = (ax: number, ay: number, bx: number, by: number, extra = "") => {
    const r = clip(ax, ay, bx, by);
    if (r) line(c, r[0], r[1], r[2], r[3], extra);
  };

  if (b.stereo === 1 || b.stereo === 6) {
    const r = clip(A.x, A.y, B.x, B.y);
    if (!r) return;
    const [ax, ay, bx, by] = [A.x + (r[0] - A.x) * (boxA ? 1 : 0), A.y + (r[1] - A.y) * (boxA ? 1 : 0), r[2], r[3]];
    const ww = R_WEDGE * c.bl * 1.15;
    if (b.stereo === 1) {
      const nw = c.lw * 0.6;
      c.out.push(`<polygon points="${n2(ax + px * nw / 2)},${n2(ay + py * nw / 2)} ${n2(bx + px * ww / 2)},${n2(by + py * ww / 2)} ${n2(bx - px * ww / 2)},${n2(by - py * ww / 2)} ${n2(ax - px * nw / 2)},${n2(ay - py * nw / 2)}" fill="${c.o.color}" stroke="none"/>`);
    } else {
      const len = Math.hypot(bx - ax, by - ay);
      const step = R_HASH * c.bl * 0.62;
      const n = Math.max(3, Math.floor(len / step));
      let d = "";
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const w = (c.lw + (ww - c.lw) * t) / 2;
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        d += `M${n2(x + px * w)} ${n2(y + py * w)}L${n2(x - px * w)} ${n2(y - py * w)}`;
      }
      c.out.push(`<path d="${d}" stroke-width="${n2(c.lw * 0.9)}"/>`);
    }
    ext(c, ax, ay); ext(c, bx, by);
    return;
  }
  if (b.stereo === 4 && b.order === 1) {
    const r = clip(A.x, A.y, B.x, B.y);
    if (!r) return;
    const [ax, ay, bx, by] = r;
    const len = Math.hypot(bx - ax, by - ay);
    const waves = Math.max(2, Math.round(len / (c.bl * 0.16)));
    const amp = c.bl * 0.07;
    let d = `M${n2(ax)} ${n2(ay)}`;
    for (let k = 0; k < waves; k++) {
      const t1 = (k + 0.5) / waves, t2 = (k + 1) / waves;
      const sgn = k % 2 ? -1 : 1;
      const cx = ax + (bx - ax) * t1 + px * amp * 2 * sgn, cy = ay + (by - ay) * t1 + py * amp * 2 * sgn;
      d += ` Q${n2(cx)} ${n2(cy)} ${n2(ax + (bx - ax) * t2)} ${n2(ay + (by - ay) * t2)}`;
    }
    c.out.push(`<path d="${d}" fill="none"/>`);
    ext(c, ax, ay); ext(c, bx, by);
    return;
  }

  const sp = c.sp;
  if (b.order === 1 || b.order === 4) {
    seg(A.x, A.y, B.x, B.y);
    if (b.order === 4) {
      const { side } = bondSide(c, b, A, B);
      const ox = px * sp * side, oy = py * sp * side;
      seg(A.x + ox + ux * sp * 0.6, A.y + oy + uy * sp * 0.6, B.x + ox - ux * sp * 0.6, B.y + oy - uy * sp * 0.6, ` stroke-dasharray="${n2(c.lw * 3)} ${n2(c.lw * 3)}"`);
    }
    return;
  }
  if (b.order === 3) {
    seg(A.x, A.y, B.x, B.y);
    seg(A.x + px * sp, A.y + py * sp, B.x + px * sp, B.y + py * sp);
    seg(A.x - px * sp, A.y - py * sp, B.x - px * sp, B.y - py * sp);
    return;
  }
  // double
  const degA = c.g.adj.get(A.id)!.length, degB = c.g.adj.get(B.id)!.length;
  let centred = b.dbl === 2;
  const { side: autoSide, inRing } = bondSide(c, b, A, B);
  if (!b.dbl && !inRing) {
    if ((degA === 1 && boxA) || (degB === 1 && boxB) || (degA === 1 && degB === 1)) centred = true;
    if ((degA === 1 && !boxA && degB > 2) || (degB === 1 && !boxB && degA > 2)) centred = true;
  }
  if (centred) {
    const h = sp / 2;
    seg(A.x + px * h, A.y + py * h, B.x + px * h, B.y + py * h);
    seg(A.x - px * h, A.y - py * h, B.x - px * h, B.y - py * h);
    return;
  }
  const side = b.dbl === 1 ? 1 : b.dbl === -1 ? -1 : autoSide;
  seg(A.x, A.y, B.x, B.y);
  const ox = px * sp * side, oy = py * sp * side;
  const trimA = boxA ? 0 : sp * 0.9, trimB = boxB ? 0 : sp * 0.9;
  const deg1A = degA === 1 && !boxA, deg1B = degB === 1 && !boxB;
  seg(A.x + ox + ux * (deg1A ? 0 : trimA), A.y + oy + uy * (deg1A ? 0 : trimA), B.x + ox - ux * (deg1B ? 0 : trimB), B.y + oy - uy * (deg1B ? 0 : trimB));
}

function drawCarbonCharge(c: Ctx, a: Atom) {
  if (!a.charge || c.boxes.has(a.id)) return;
  const g = c.g;
  // place in the largest free direction
  const angs = g.adj.get(a.id)!.map(({ nb }) => { const q = g.atomById.get(nb)!; return Math.atan2(q.y - a.y, q.x - a.x); }).sort((x, y) => x - y);
  let th = -Math.PI / 4;
  if (angs.length) {
    let gs = angs[angs.length - 1], gap = angs[0] + 2 * Math.PI - gs;
    for (let i = 1; i < angs.length; i++) if (angs[i] - angs[i - 1] > gap) { gap = angs[i] - angs[i - 1]; gs = angs[i - 1]; }
    th = gs + gap / 2;
  }
  const r = c.fs * 0.75;
  const x = a.x + Math.cos(th) * r, y = a.y + Math.sin(th) * r;
  c.out.push(`<text x="${n2(x)}" y="${n2(y + c.fs * 0.3)}" font-size="${n2(c.fs * 0.85)}" text-anchor="middle" fill="${c.o.color}" stroke="none" font-family="${esc(c.o.fontFamily)}">${chargeText(a.charge)}</text>`);
  ext(c, x - c.fs * 0.5, y - c.fs * 0.5); ext(c, x + c.fs * 0.5, y + c.fs * 0.5);
}

function arrowHead(c: Ctx, x: number, y: number, ux: number, uy: number, half: "both" | "left" | "right" = "both") {
  const L = c.bl * 0.32, Wd = c.bl * 0.11, notch = c.bl * 0.08;
  const bx = x - ux * L, by = y - uy * L;
  const px = -uy, py = ux;
  const lx = bx + px * Wd, ly = by + py * Wd, rx = bx - px * Wd, ry = by - py * Wd;
  const nx = x - ux * (L - notch), ny = y - uy * (L - notch);
  let pts: string;
  if (half === "both") pts = `${n2(x)},${n2(y)} ${n2(lx)},${n2(ly)} ${n2(nx)},${n2(ny)} ${n2(rx)},${n2(ry)}`;
  else if (half === "left") pts = `${n2(x)},${n2(y)} ${n2(lx)},${n2(ly)} ${n2(nx)},${n2(ny)}`;
  else pts = `${n2(x)},${n2(y)} ${n2(rx)},${n2(ry)} ${n2(nx)},${n2(ny)}`;
  c.out.push(`<polygon points="${pts}" fill="${c.o.color}" stroke="none"/>`);
  ext(c, lx, ly); ext(c, rx, ry);
}

function drawArrow(c: Ctx, ar: ChemDoc["arrows"][number]) {
  const s = c.bl;
  const x1 = ar.x1 * s, y1 = ar.y1 * s, x2 = ar.x2 * s, y2 = ar.y2 * s;
  const L = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / L, uy = (y2 - y1) / L;
  const px = -uy, py = ux;
  const headL = c.bl * 0.28;
  if (ar.kind === "equilibrium") {
    const o = c.bl * 0.07;
    line(c, x1 - px * o, y1 - py * o, x2 - px * o - ux * headL, y2 - py * o - uy * headL);
    arrowHead(c, x2 - px * o, y2 - py * o, ux, uy, "right");
    line(c, x2 + px * o, y2 + py * o, x1 + px * o + ux * headL, y1 + py * o + uy * headL);
    arrowHead(c, x1 + px * o, y1 + py * o, -ux, -uy, "right");
    return;
  }
  if (ar.kind === "retro") {
    const o = c.bl * 0.065, hl = c.bl * 0.22;
    line(c, x1 + px * o, y1 + py * o, x2 + px * o - ux * hl * 0.8, y2 + py * o - uy * hl * 0.8);
    line(c, x1 - px * o, y1 - py * o, x2 - px * o - ux * hl * 0.8, y2 - py * o - uy * hl * 0.8);
    const tip = { x: x2, y: y2 };
    c.out.push(`<polyline points="${n2(tip.x - ux * hl + px * hl * 0.9)},${n2(tip.y - uy * hl + py * hl * 0.9)} ${n2(tip.x)},${n2(tip.y)} ${n2(tip.x - ux * hl - px * hl * 0.9)},${n2(tip.y - uy * hl - py * hl * 0.9)}" fill="none"/>`);
    ext(c, x1, y1); ext(c, x2 + px * hl, y2 + py * hl); ext(c, x2 - px * hl, y2 - py * hl);
    return;
  }
  const dash = ar.kind === "dashed" ? ` stroke-dasharray="${n2(c.lw * 5)} ${n2(c.lw * 4)}"` : "";
  if (ar.kind === "resonance") {
    line(c, x1 + ux * headL, y1 + uy * headL, x2 - ux * headL, y2 - uy * headL);
    arrowHead(c, x2, y2, ux, uy);
    arrowHead(c, x1, y1, -ux, -uy);
    return;
  }
  line(c, x1, y1, x2 - ux * headL, y2 - uy * headL, dash);
  arrowHead(c, x2, y2, ux, uy);
}

function drawText(c: Ctx, t: ChemDoc["texts"][number]) {
  const s = c.bl;
  const lines = t.text.split("\n");
  const fs = c.fs;
  const lh = fs * 1.2;
  const y0 = t.y * s - ((lines.length - 1) * lh) / 2 + 0.35 * fs;
  lines.forEach((ln, i) => {
    const segs = splitDigits(ln, "free");
    const w = segs.reduce((acc, sg) => acc + segWidth(sg, fs), 0);
    let str = `<text x="${n2(t.x * s)}" y="${n2(y0 + i * lh)}" font-size="${n2(fs)}" text-anchor="middle" fill="${c.o.color}" stroke="none" font-family="${esc(c.o.fontFamily)}">`;
    let dyState = 0;
    for (const sg of segs) {
      const want = sg.sub ? 0.28 * fs : 0;
      const dy = want - dyState; dyState = want;
      str += `<tspan${dy ? ` dy="${n2(dy)}"` : ""}${sg.sub ? ` font-size="${n2(fs * 0.7)}"` : ""}>${esc(sg.t)}</tspan>`;
    }
    c.out.push(str + "</text>");
    ext(c, t.x * s - w / 2, y0 + i * lh - fs); ext(c, t.x * s + w / 2, y0 + i * lh + fs * 0.3);
  });
}

export interface RenderResult {
  body: string; // inner SVG markup in px coordinates (model * bondLength)
  minX: number; minY: number; maxX: number; maxY: number;
  lineWidth: number; fontSize: number;
}

export function renderBody(doc: ChemDoc, opts: RenderOptions = {}): RenderResult {
  const o = { ...DEF, ...opts } as typeof DEF;
  const bl = o.bondLength;
  // work on px-scaled copies of atoms
  const scaled: ChemDoc = { ...doc, atoms: doc.atoms.map((a) => ({ ...a, x: a.x * bl, y: a.y * bl })) };
  const g = buildGraph(scaled);
  const ri = findRings(scaled, g);
  dblIds = new Set(scaled.bonds.filter((b) => b.order === 2).map((b) => b.id));
  const c: Ctx = {
    o, bl, lw: R_LINE * bl * 1.25, fs: R_FONT * bl, sp: R_SPACING * bl, margin: R_MARGIN * bl,
    g, ri, boxes: new Map(), out: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
  };
  const labels: string[] = [];
  const saveOut = c.out;
  c.out = labels;
  for (const a of scaled.atoms) drawLabel(c, a);
  c.out = saveOut;
  const bondsOut: string[] = [];
  c.out = bondsOut;
  for (const b of scaled.bonds) drawBond(c, b);
  for (const a of scaled.atoms) drawCarbonCharge(c, a);
  for (const ar of doc.arrows) drawArrow(c, ar);
  for (const p of doc.pluses) {
    const h = bl * 0.2;
    line(c, p.x * bl - h, p.y * bl, p.x * bl + h, p.y * bl);
    line(c, p.x * bl, p.y * bl - h, p.x * bl, p.y * bl + h);
  }
  for (const t of doc.texts) drawText(c, t);
  if (o.showValenceErrors) {
    for (const a of scaled.atoms) if (isOverValent(g, a)) {
      c.out.push(`<circle cx="${n2(a.x)}" cy="${n2(a.y)}" r="${n2(c.fs * 0.75)}" fill="none" stroke="#e5484d" stroke-width="${n2(c.lw)}" stroke-dasharray="2 2"/>`);
    }
  }
  for (const a of scaled.atoms) ext(c, a.x, a.y);
  const body =
    `<g stroke="${o.color}" stroke-width="${n2(c.lw)}" stroke-linecap="round" stroke-linejoin="round" fill="none">${bondsOut.join("")}</g>` +
    `<g font-family="${esc(o.fontFamily)}" stroke="none">${labels.join("")}</g>`;
  if (c.minX === Infinity) { c.minX = c.minY = 0; c.maxX = c.maxY = 0; }
  return { body, minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY, lineWidth: c.lw, fontSize: c.fs };
}

/** Standalone SVG document. */
export function renderSVG(doc: ChemDoc, opts: RenderOptions = {}): string {
  const o = { ...DEF, ...opts };
  const r = renderBody(doc, o);
  const pad = o.padding;
  const x = r.minX - pad, y = r.minY - pad;
  const w = Math.max(r.maxX - r.minX + 2 * pad, 10), h = Math.max(r.maxY - r.minY + 2 * pad, 10);
  let sc = o.scale ?? 1;
  if (o.maxWidth && w * sc > o.maxWidth) sc = o.maxWidth / w;
  if (o.maxHeight && h * sc > o.maxHeight) sc = Math.min(sc, o.maxHeight / h);
  const bg = o.background ? `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="${o.background}"/>` : "";
  const meta = opts.metadata ? `<metadata>${opts.metadata}</metadata>` : "";
  const cls = opts.className ? ` class="${opts.className}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg"${cls} width="${n2(w * sc)}" height="${n2(h * sc)}" viewBox="${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)}">${meta}${bg}${r.body}</svg>`;
}
