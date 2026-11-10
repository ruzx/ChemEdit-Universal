// Predicted-spectrum simulation (first-order multiplets, Lorentzian lines), SVG rendering
// and ACS-style text ("¹H NMR (400 MHz, CDCl₃) δ 7.26 (d, J = 8.0 Hz, 2H) …").

import type { ChemDoc } from "../model";
import { molFromDoc, Mol } from "./mol";
import { predict1H, predict13C, PredSignal } from "./predict";

export type { PredSignal } from "./predict";
export type Nucleus = "1H" | "13C";

export interface Solvent { id: string; label: string; h: number[]; c: number[] }
export const SOLVENTS: Solvent[] = [
  { id: "CDCl3", label: "CDCl₃", h: [7.26], c: [77.16] },
  { id: "DMSO-d6", label: "DMSO-d₆", h: [2.50], c: [39.52] },
  { id: "CD3OD", label: "CD₃OD", h: [3.31], c: [49.0] },
  { id: "C6D6", label: "C₆D₆", h: [7.16], c: [128.06] },
  { id: "acetone-d6", label: "acetone-d₆", h: [2.05], c: [29.84, 206.26] },
  { id: "CD3CN", label: "CD₃CN", h: [1.94], c: [1.32, 118.26] },
  { id: "D2O", label: "D₂O", h: [4.79], c: [] },
];
export const solventOf = (s: string | undefined) => SOLVENTS.find((x) => x.id.toLowerCase() === String(s ?? "").toLowerCase().replace(/[₃₆]/g, (c) => (c === "₃" ? "3" : "6"))) ?? SOLVENTS[0];
export const carbonMHz = (mhz: number) => Math.round(mhz * 0.25145);

export interface NmrPrediction { mol: Mol; h: PredSignal[]; c: PredSignal[] }
export function predictNmr(doc: ChemDoc): NmrPrediction {
  const mol = molFromDoc(doc);
  if (!mol.atoms.length) throw new Error("No structure");
  return { mol, h: predict1H(mol), c: predict13C(mol) };
}

// ── multiplet simulation ─────────────────────────────────────
const TOK: Array<[string, number]> = [["sext", 5], ["hept", 6], ["d", 1], ["t", 2], ["q", 3], ["p", 4]];
const binom = (n: number) => { let row = [1]; for (let i = 0; i < n; i++) row = [...row, 0].map((v, k) => v + (row[k - 1] ?? 0)); return row; };

/** Lines (Hz offsets relative to the centre, with intensity) for one signal. */
export function multipletLines(sig: PredSignal): Array<{ hz: number; i: number }> {
  let lines = [{ hz: 0, i: 1 }];
  const m = sig.mult.replace(/^br\s*/, "");
  if (m === "m") {
    lines = [-9, -5.5, -2, 1.5, 5, 8.5].map((hz, k) => ({ hz, i: [0.35, 0.7, 1, 0.9, 0.65, 0.3][k] }));
  } else if (m !== "s") {
    let rest = m, ji = 0;
    while (rest.length) {
      const t = TOK.find(([k]) => rest.startsWith(k));
      if (!t) break;
      rest = rest.slice(t[0].length);
      const J = sig.J[ji++] ?? 7;
      const b = binom(t[1]);
      const next: typeof lines = [];
      for (const l of lines) b.forEach((c, k) => next.push({ hz: l.hz + (k - t[1] / 2) * J, i: l.i * c }));
      lines = next;
    }
  }
  const tot = lines.reduce((s, l) => s + l.i, 0) || 1;
  return lines.map((l) => ({ hz: l.hz, i: (l.i / tot) * sig.n }));
}

/** ppm extent of a multiplet (for "7.32–7.25 (m)" style ranges). */
export function multipletRange(sig: PredSignal, mhz: number): [number, number] {
  const ls = multipletLines(sig);
  const lo = Math.min(...ls.map((l) => l.hz)), hi = Math.max(...ls.map((l) => l.hz));
  return [sig.shift + lo / mhz, sig.shift + hi / mhz];
}

// ── text ─────────────────────────────────────────────────────
const f2 = (v: number) => v.toFixed(2);
export function acsText(sigs: PredSignal[], nucleus: Nucleus, mhz: number, solvent: Solvent): string {
  if (nucleus === "13C") {
    const parts = [...sigs].sort((a, b) => b.shift - a.shift).map((s) => s.shift.toFixed(1) + (s.n > 1 ? ` (${s.n}C)` : ""));
    return `¹³C NMR (${carbonMHz(mhz)} MHz, ${solvent.label}) δ ${parts.join(", ")}.`;
  }
  const parts = [...sigs].sort((a, b) => b.shift - a.shift).map((s) => {
    let d = f2(s.shift);
    if (s.mult === "m") { const [lo, hi] = multipletRange(s, mhz); d = `${f2(hi)}–${f2(lo)}`; }
    const J = s.J.length ? `, J = ${s.J.map((j) => j.toFixed(1)).join(", ")} Hz` : "";
    return `${d} (${s.mult}${J}, ${s.n}H)`;
  });
  return `¹H NMR (${mhz} MHz, ${solvent.label}) δ ${parts.join(", ")}.`;
}

// ── SVG spectrum ─────────────────────────────────────────────
export interface SpecOpts { nucleus: Nucleus; mhz: number; solvent?: Solvent | null; range?: [number, number]; width?: number; height?: number }
const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

export function spectrumRange(sigs: PredSignal[], nucleus: Nucleus): [number, number] {
  const sh = sigs.map((s) => s.shift);
  if (nucleus === "13C") { const hi = Math.max(160, Math.ceil((Math.max(0, ...sh) + 12) / 10) * 10); return [Math.min(0, Math.floor((Math.min(...sh, 0) - 5) / 10) * 10), hi]; }
  return [Math.min(-0.2, Math.floor(Math.min(...sh, 0) - 0.5)), Math.max(10, Math.ceil(Math.max(...sh, 0) + 0.6))];
}

/** spread label x-positions so they do not overlap (keeps order) */
function spread(xs: number[], gap: number, x0: number, x1: number): number[] {
  const out = [...xs];
  for (let it = 0; it < 60; it++) {
    let moved = false;
    for (let i = 1; i < out.length; i++) { const d = out[i] - out[i - 1]; if (d < gap) { const p = (gap - d) / 2; out[i - 1] -= p; out[i] += p; moved = true; } }
    for (let i = 0; i < out.length; i++) out[i] = Math.min(x1, Math.max(x0, out[i]));
    if (!moved) break;
  }
  return out;
}

export function spectrumSvg(sigs: PredSignal[], o: SpecOpts): string {
  const W = o.width ?? 760, H = o.height ?? 270;
  const L = 18, R = 18, T = 74, B = 44;
  const [lo, hi] = o.range ?? spectrumRange(sigs, o.nucleus);
  const X = (ppm: number) => L + ((hi - ppm) / (hi - lo)) * (W - L - R);
  const y0 = H - B;
  const parts: string[] = [];
  // axis
  const step = hi - lo > 60 ? 20 : hi - lo > 25 ? 10 : hi - lo > 6 ? 1 : 0.5;
  parts.push(`<line class="ce-nmr-axis" x1="${L}" y1="${y0}" x2="${W - R}" y2="${y0}"/>`);
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) {
    const x = X(t);
    parts.push(`<line class="ce-nmr-axis" x1="${n1(x)}" y1="${y0}" x2="${n1(x)}" y2="${y0 + 5}"/><text class="ce-nmr-tick" x="${n1(x)}" y="${y0 + 17}" text-anchor="middle">${+t.toFixed(1)}</text>`);
  }
  parts.push(`<text class="ce-nmr-tick" x="${W - R}" y="${y0 + 34}" text-anchor="end">δ / ppm</text>`);
  // solvent
  if (o.solvent) for (const s of o.nucleus === "13C" ? o.solvent.c : o.solvent.h) if (s > lo && s < hi) {
    const x = X(s);
    parts.push(`<line class="ce-nmr-solv" x1="${n1(x)}" y1="${y0}" x2="${n1(x)}" y2="${T + 30}"/><text class="ce-nmr-solvt" x="${n1(x)}" y="${T + 26}" text-anchor="middle">${o.solvent.label}</text>`);
  }
  const plotH = y0 - T - 10;
  const peakTops: number[] = [];
  const sigParts: string[] = [];
  if (o.nucleus === "13C") {
    const hOf = (s: PredSignal) => (s.n > 1 ? 1 : 0.62);
    sigs.forEach((s, k) => {
      const x = X(s.shift), h = plotH * hOf(s) * 0.95;
      peakTops.push(y0 - h);
      sigParts.push(`<g class="ce-nmr-sig" data-i="${k}"><rect class="ce-nmr-hit" x="${n1(x - 5)}" y="${T}" width="10" height="${y0 - T}"/><line class="ce-nmr-stick" x1="${n1(x)}" y1="${y0}" x2="${n1(x)}" y2="${n1(y0 - h)}"/></g>`);
    });
  } else {
    const ppmPerPx = (hi - lo) / (W - L - R);
    const lw = 1.1; // Hz half-width
    const all = sigs.map((s) => multipletLines(s).map((l) => ({ ppm: s.shift + l.hz / o.mhz, i: l.i * (s.exch ? 0.5 : 1), w: s.exch ? 6 : lw })));
    const lor = (ppm: number, ls: Array<{ ppm: number; i: number; w: number }>) => { let v = 0; for (const l of ls) { const d = (ppm - l.ppm) * o.mhz; if (Math.abs(d) < 60) v += (l.i * l.w * l.w) / (d * d + l.w * l.w); } return v; };
    // sample: uniform grid + dense around lines
    const xs = new Set<number>();
    for (let px = 0; px <= W - L - R; px += 1) xs.add(+(hi - px * ppmPerPx).toFixed(5));
    for (const ls of all) for (const l of ls) for (let d = -12; d <= 12; d += 0.4) xs.add(+(l.ppm + d / o.mhz).toFixed(5));
    const grid = [...xs].filter((p) => p >= lo && p <= hi).sort((a, b) => b - a);
    const flat = all.flat();
    const tot = grid.map((p) => lor(p, flat));
    const maxV = Math.max(...tot, 1e-9);
    const Y = (v: number) => y0 - (v / maxV) * plotH;
    parts.push(`<path class="ce-nmr-line" d="M${grid.map((p, i) => `${n1(X(p))},${n1(Y(tot[i]))}`).join("L")}"/>`);
    sigs.forEach((s, k) => {
      const ls = all[k];
      const a = Math.max(...ls.map((l) => l.ppm)) + 20 / o.mhz, b = Math.min(...ls.map((l) => l.ppm)) - 20 / o.mhz;
      const g = grid.filter((p) => p <= a && p >= b);
      const path = g.map((p) => `${n1(X(p))},${n1(Y(lor(p, ls)))}`).join("L");
      const top = Math.min(...g.map((p) => Y(lor(p, flat))));
      peakTops.push(top);
      const xa = X(a), xb = X(b);
      sigParts.push(`<g class="ce-nmr-sig" data-i="${k}"><rect class="ce-nmr-hit" x="${n1(xa)}" y="${T}" width="${n1(Math.max(8, xb - xa))}" height="${y0 - T}"/><path class="ce-nmr-sigpath" d="M${path}"/></g>`);
    });
  }
  // integrals under the axis (spread so they never overlap)
  if (o.nucleus === "1H") {
    const ord = sigs.map((_, k) => k).sort((a, b) => X(sigs[a].shift) - X(sigs[b].shift));
    const ix = spread(ord.map((k) => X(sigs[k].shift)), 22, L + 8, W - R - 8);
    ord.forEach((k, j) => { sigParts[k] = sigParts[k].replace(/<\/g>$/, `<text class="ce-nmr-int" x="${n1(ix[j])}" y="${y0 + 30}" text-anchor="middle">${sigs[k].n}H</text></g>`); });
  }
  // peak labels with leader lines
  const order = sigs.map((s, k) => k).sort((a, b) => X(sigs[a].shift) - X(sigs[b].shift));
  const lx = spread(order.map((k) => X(sigs[k].shift)), 15, L + 4, W - R - 4);
  order.forEach((k, j) => {
    const s = sigs[k], x = X(s.shift), tx = lx[j];
    const txt = o.nucleus === "13C" ? s.shift.toFixed(1) : s.shift.toFixed(2);
    sigParts[k] = sigParts[k].replace(/<\/g>$/, `<path class="ce-nmr-lead" d="M${n1(tx)},${T - 6}L${n1(tx)},${T + 2}L${n1(x)},${T + 12}L${n1(x)},${n1(Math.max(T + 12, peakTops[k] - 4))}"/><text class="ce-nmr-lab" transform="translate(${n1(tx + 3.5)},${T - 9}) rotate(-90)">${txt}</text></g>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" class="ce-nmr-svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}${sigParts.join("")}</svg>`;
}
