// ─────────────────────────────────────────────────────────────
//  ¹H / ¹³C chemical-shift prediction by additive increments
//  (Grant–Paul, Pretsch, Shoolery, Pascual–Meier–Simon tables).
//  Accuracy is typically ±0.2 ppm (¹H) / ±3–5 ppm (¹³C) for common
//  organic molecules — good for assignment and teaching.
//  Ported from ChemSpec (same author, MIT).
// ─────────────────────────────────────────────────────────────
import { Mol, bondBetween } from "./mol";

export interface PredSignal {
  atoms: number[];      // host heavy atoms (0-based, Mol indices)
  shift: number;
  n: number;            // number of nuclei
  mult: string;
  J: number[];
  exch: boolean;        // exchangeable OH/NH (often broad or missing)
  label: string;        // "H-2,6" / "C-4"
  nucleus: "1H" | "13C";
}

type Sub = "alkyl" | "CH3" | "CH2O" | "CH2X" | "Ph" | "vinyl" | "alkynyl" | "CHO" | "COR" | "COAr" | "COOH" | "COOR" | "CONR2" | "COCl" | "CN" | "CF3"
  | "OH" | "OR" | "OAr" | "OCOR" | "NH2" | "NHR" | "NR2" | "NHCOR" | "NO2" | "F" | "Cl" | "Br" | "I" | "SR" | "SO2R" | "fused" | "other";

const isCarbonyl = (m: Mol, c: number) => m.atoms[c].el === "C" && m.adj[c].some((e) => m.atoms[e.n].el === "O" && m.bonds[e.b].order === 2);
const dblTo = (m: Mol, a: number, el: string) => m.adj[a].find((e) => m.atoms[e.n].el === el && m.bonds[e.b].order === 2 && !m.bonds[e.b].arom);
const isSp3C = (m: Mol, a: number) => m.atoms[a].el === "C" && !m.atoms[a].arom && m.adj[a].every((e) => m.bonds[e.b].order === 1 && !m.bonds[e.b].arom);
const heavyNb = (m: Mol, a: number, ex = -1) => m.adj[a].filter((e) => e.n !== ex);

export function classify(m: Mol, x: number, from: number): Sub {
  const A = m.atoms[x]; const nb = heavyNb(m, x, from);
  switch (A.el) {
    case "C": {
      if (A.arom) return "Ph";
      if (nb.some((e) => m.bonds[e.b].order === 3 && m.atoms[e.n].el === "N")) return "CN";
      if (nb.some((e) => m.bonds[e.b].order === 3)) return "alkynyl";
      if (isCarbonyl(m, x)) {
        const others = nb.filter((e) => !(m.atoms[e.n].el === "O" && m.bonds[e.b].order === 2));
        const o = others.find((e) => m.atoms[e.n].el === "O");
        if (o) return m.atoms[o.n].h > 0 ? "COOH" : "COOR";
        if (others.some((e) => m.atoms[e.n].el === "N")) return "CONR2";
        if (others.some((e) => m.atoms[e.n].el === "Cl")) return "COCl";
        if (A.h > 0 || !others.length) return "CHO";
        return others.some((e) => m.atoms[e.n].arom || !!dblTo(m, e.n, "C")) ? "COAr" : "COR";
      }
      if (dblTo(m, x, "C") || dblTo(m, x, "N")) return "vinyl";
      if (nb.filter((e) => m.atoms[e.n].el === "F").length >= 3) return "CF3";
      if (nb.some((e) => m.atoms[e.n].el === "O" || m.atoms[e.n].el === "N")) return "CH2O";
      if (nb.some((e) => ["Cl", "Br", "I"].includes(m.atoms[e.n].el))) return "CH2X";
      return A.h === 3 ? "CH3" : "alkyl";
    }
    case "O": {
      if (A.h > 0) return "OH";
      const c = nb.find((e) => m.atoms[e.n].el === "C");
      if (!c) return "OR";
      if (isCarbonyl(m, c.n)) return "OCOR";
      if (m.atoms[c.n].arom) return "OAr";
      return "OR";
    }
    case "N": {
      if (nb.filter((e) => m.atoms[e.n].el === "O").length >= 2) return "NO2";
      if (nb.some((e) => isCarbonyl(m, e.n))) return "NHCOR";
      return A.h >= 2 ? "NH2" : A.h === 1 ? "NHR" : "NR2";
    }
    case "S": return nb.filter((e) => m.atoms[e.n].el === "O" && m.bonds[e.b].order === 2).length >= 2 ? "SO2R" : "SR";
    case "F": case "Cl": case "Br": case "I": return A.el;
    default: return "other";
  }
}

// ── tables ───────────────────────────────────────────────────
const H_SP3: Partial<Record<Sub, number>> = { alkyl: 0, CH3: 0, CH2O: 0.1, CH2X: 0.25, Ph: 1.35, vinyl: 0.8, alkynyl: 0.9, CHO: 1.3, COR: 1.2, COAr: 1.7, COOH: 1.2, COOR: 1.1, CONR2: 1.1, COCl: 1.8, CN: 1.1, CF3: 0.4,
  OH: 2.5, OR: 2.4, OAr: 2.85, OCOR: 2.95, NH2: 1.6, NHR: 1.5, NR2: 1.3, NHCOR: 1.9, NO2: 3.4, F: 3.4, Cl: 2.15, Br: 1.8, I: 1.25, SR: 1.2, SO2R: 2.0, other: 0.5 };
const H_AR: Partial<Record<Sub, number[]>> = { alkyl: [-0.14, -0.06, -0.17], CH3: [-0.18, -0.11, -0.21], CH2O: [-0.07, -0.07, -0.07], CH2X: [0.0, 0.0, 0.0], Ph: [0.37, 0.20, 0.10], vinyl: [0.06, -0.03, -0.10], alkynyl: [0.15, -0.02, -0.01],
  CHO: [0.56, 0.22, 0.29], COR: [0.62, 0.14, 0.21], COAr: [0.47, 0.13, 0.22], COOH: [0.85, 0.18, 0.27], COOR: [0.71, 0.11, 0.21], CONR2: [0.61, 0.10, 0.17], COCl: [0.84, 0.22, 0.36], CN: [0.36, 0.18, 0.28], CF3: [0.32, 0.14, 0.20],
  OH: [-0.56, -0.12, -0.45], OR: [-0.48, -0.09, -0.44], OAr: [-0.29, -0.05, -0.23], OCOR: [-0.25, 0.03, -0.13], NH2: [-0.75, -0.25, -0.65], NHR: [-0.80, -0.22, -0.68], NR2: [-0.66, -0.18, -0.67], NHCOR: [0.12, -0.07, -0.28],
  NO2: [0.95, 0.26, 0.38], F: [-0.26, 0.0, -0.20], Cl: [0.03, -0.02, -0.09], Br: [0.18, -0.08, -0.04], I: [0.39, -0.21, 0.0], SR: [-0.08, -0.10, -0.24], SO2R: [0.60, 0.25, 0.33], fused: [0.40, 0.15, 0.10] };
const H_ALK: Partial<Record<Sub, number[]>> = { alkyl: [0.45, -0.22, -0.28], CH3: [0.45, -0.22, -0.28], CH2O: [0.64, -0.01, -0.02], CH2X: [0.70, 0.11, -0.04], Ph: [1.38, 0.36, -0.07], vinyl: [1.00, -0.09, -0.23], alkynyl: [0.47, 0.38, 0.12],
  COOR: [0.80, 1.18, 0.55], COOH: [0.97, 1.41, 0.71], CHO: [1.02, 0.95, 1.17], COR: [1.10, 1.12, 0.87], COAr: [1.10, 1.12, 0.87], CONR2: [1.37, 0.98, 0.46], CN: [0.27, 0.75, 0.55], OR: [1.22, -1.07, -1.21], OAr: [1.22, -1.07, -1.21],
  OCOR: [2.11, -0.35, -0.64], NR2: [0.80, -1.26, -1.21], NHR: [0.80, -1.26, -1.21], NHCOR: [2.08, -0.57, -0.72], Cl: [1.08, 0.18, 0.13], Br: [1.07, 0.45, 0.55], F: [1.54, -0.40, -1.02], SR: [1.11, -0.29, -0.13], CF3: [0.66, 0.61, 0.32] };
const C_AR: Partial<Record<Sub, number[]>> = { alkyl: [15.6, -0.5, 0.0, -2.6], CH3: [9.3, 0.7, -0.1, -2.9], CH2O: [12.4, -1.2, 0.2, -1.1], CH2X: [9.1, 0.0, 0.2, -0.2], Ph: [13.0, -1.1, 0.5, -1.0], vinyl: [9.5, -2.0, 0.2, -0.5], alkynyl: [-6.1, 3.8, 0.4, -0.2],
  CHO: [8.2, 1.2, 0.5, 5.8], COR: [8.9, 0.0, -0.1, 4.4], COAr: [9.1, 1.5, -0.2, 3.8], COOH: [2.1, 1.6, -0.1, 5.2], COOR: [2.0, 1.2, -0.1, 4.3], CONR2: [5.0, -1.2, 0.1, 3.4], COCl: [4.6, 2.9, 0.6, 7.0], CN: [-15.7, 3.6, 0.7, 4.3], CF3: [2.6, -3.1, 0.4, 3.4],
  OH: [26.9, -12.7, 1.4, -7.3], OR: [31.4, -14.4, 1.0, -7.7], OAr: [27.6, -11.2, -0.3, -6.9], OCOR: [22.4, -7.1, -0.4, -3.2], NH2: [18.2, -13.4, 0.8, -10.0], NHR: [20.0, -14.0, 0.8, -11.0], NR2: [22.4, -15.7, 0.8, -11.8], NHCOR: [9.7, -8.1, 0.2, -4.4],
  NO2: [19.6, -5.3, 0.9, 6.0], F: [34.8, -13.0, 1.6, -4.4], Cl: [6.3, 0.4, 1.4, -1.9], Br: [-5.8, 3.2, 1.6, -1.6], I: [-34.1, 8.9, 1.6, -1.1], SR: [10.2, -1.8, 0.4, -3.6], SO2R: [12.3, -1.4, 0.8, 5.1], fused: [5.0, 0.5, -1.3, -1.3] };
const C_SP3: Partial<Record<Sub, number[]>> = { Ph: [23.7, 9.0, -2.0], vinyl: [21.3, 7.0, -2.0], alkynyl: [4.5, 5.5, -3.5], CHO: [33, 0, -2], COR: [33, 1, -2], COAr: [29, 1, -2], COOH: [23, 2, -2], COOR: [23, 3, -2], CONR2: [24.5, 2.5, -3], COCl: [33, 2, -3.5],
  CN: [4, 3, -3], CF3: [7, 2, -2], OH: [48, 10, -5], OR: [58, 7, -4], OAr: [57, 7, -4], OCOR: [54, 7.5, -6], NH2: [28, 11, -5], NHR: [37, 8, -4], NR2: [42, 6, -3], NHCOR: [28, 7, -4.6], NO2: [63, 4, -5],
  F: [68, 9, -4], Cl: [31, 11, -4], Br: [20, 11, -3], I: [-6, 11, -1], SR: [20, 10, -3], SO2R: [42, 1, -3], other: [10, 5, -2] };
const C_ALK: Partial<Record<Sub, number[]>> = { alkyl: [10.6, -7.9], CH3: [12.9, -7.4], CH2O: [13.0, -8.0], CH2X: [10.2, -6.0], Ph: [12.5, -11.0], vinyl: [13.6, -7.0], alkynyl: [-13.0, 9.0], COOR: [6.3, 7.0], COOH: [4.2, 8.9], CHO: [13.1, 12.7], COR: [13.8, 4.7], COAr: [13.8, 4.7],
  CONR2: [9.6, 3.2], CN: [-15.1, 14.2], OR: [28.8, -39.0], OAr: [28.8, -39.0], OCOR: [18.4, -26.7], NR2: [28.0, -32.0], NHCOR: [13.0, -26.0], Cl: [2.8, -6.1], Br: [-8.6, -0.9], F: [24.9, -34.3], SR: [9.0, -12.0], CF3: [6.6, 2.1] };

// ── helpers ──────────────────────────────────────────────────
function ringFor(m: Mol, k: number): number[] | undefined {
  return m.rings.find((r) => r.includes(k) && r.every((x) => m.atoms[x].arom) && r.length === 6) || m.rings.find((r) => r.includes(k) && r.every((x) => m.atoms[x].arom));
}
const ringDist = (r: number[], a: number, b: number) => { const i = r.indexOf(a), j = r.indexOf(b), d = Math.abs(i - j); return Math.min(d, r.length - d); };

function ringSubs(m: Mol, r: number[]): [number, Sub][] {
  const out: [number, Sub][] = [];
  for (const x of r) for (const e of m.adj[x]) {
    if (r.includes(e.n)) continue;
    const fused = m.atoms[e.n].arom && m.rings.some((q) => q !== r && q.includes(x) && q.includes(e.n) && q.every((y) => m.atoms[y].arom));
    out.push([x, fused ? "fused" : classify(m, e.n, x)]);
  }
  return out;
}

function heteroBase(m: Mol, r: number[], k: number, nuc: "1H" | "13C"): number {
  const het = r.filter((x) => m.atoms[x].el !== "C");
  if (!het.length) return nuc === "1H" ? 7.27 : 128.5;
  const d = Math.min(...het.map((h) => ringDist(r, h, k)));
  if (r.length === 6) return nuc === "1H" ? [7.27, 8.6, 7.25, 7.65][d] : [128.5, 149.9, 123.8, 135.9][d];
  const el = m.atoms[het[0]].el;
  const T = el === "O" ? [7.42, 6.38, 142.7, 109.6] : el === "S" ? [7.33, 7.12, 125.4, 127.2] : [6.7, 6.2, 118.0, 108.0];
  const both = het.length > 1 && het.filter((h) => ringDist(r, h, k) === 1).length > 1;
  if (nuc === "1H") return both ? 7.9 : d <= 1 ? T[0] : T[1];
  return both ? 150 : d <= 1 ? T[2] : T[3];
}

// ── ¹H ───────────────────────────────────────────────────────
function shift1H(m: Mol, k: number): { s: number; exch: boolean } {
  const A = m.atoms[k];
  if (A.el === "O") {
    const c = m.adj[k].find((e) => m.atoms[e.n].el === "C");
    if (c && isCarbonyl(m, c.n)) return { s: 11.0, exch: true };
    if (c && m.atoms[c.n].arom) return { s: 5.2, exch: true };
    return { s: 2.0, exch: true };
  }
  if (A.el === "N") {
    if (A.arom) return { s: 8.1, exch: true };
    if (m.adj[k].some((e) => isCarbonyl(m, e.n))) return { s: A.h >= 2 ? 5.8 : 6.3, exch: true };
    if (m.adj[k].some((e) => m.atoms[e.n].arom)) return { s: 3.6, exch: true };
    return { s: 1.4, exch: true };
  }
  if (A.el === "S") return { s: 1.5, exch: true };
  if (A.el !== "C") return { s: 2.0, exch: true };
  if (A.arom) {
    const r = ringFor(m, k);
    if (!r) return { s: 7.27, exch: false };
    let s = heteroBase(m, r, k, "1H");
    const f = r.length === 5 ? 0.8 : 1;
    for (const [x, t] of ringSubs(m, r)) { const d = ringDist(r, x, k); const z = H_AR[t]; if (z && d >= 1 && d <= 3) s += f * z[d - 1]; }
    return { s, exch: false };
  }
  if (isCarbonyl(m, k)) {
    if (m.adj[k].some((e) => m.atoms[e.n].el === "O" && m.bonds[e.b].order === 1)) return { s: 8.05, exch: false };
    if (m.adj[k].some((e) => m.atoms[e.n].el === "N")) return { s: 8.1, exch: false };
    return { s: m.adj[k].some((e) => m.atoms[e.n].arom || !!dblTo(m, e.n, "C")) ? 9.95 : 9.75, exch: false };
  }
  if (m.adj[k].some((e) => m.bonds[e.b].order === 3)) return { s: m.adj[k].some((e) => m.adj[e.n].some((f) => m.atoms[f.n].arom)) ? 3.05 : 2.0, exch: false };
  const dC = dblTo(m, k, "C");
  if (dC) {
    let s = 5.25;
    for (const e of m.adj[k]) if (e.n !== dC.n) { const z = H_ALK[classify(m, e.n, k)]; if (z) s += z[0]; }
    for (const e of m.adj[dC.n]) if (e.n !== k) { const z = H_ALK[classify(m, e.n, dC.n)]; if (z) s += (z[1] + z[2]) / 2; }
    return { s, exch: false };
  }
  if (dblTo(m, k, "N")) return { s: 8.1, exch: false };
  let s = A.h >= 3 ? 0.9 : A.h === 2 ? 1.3 : 1.55;
  const sig = m.adj[k].map((e) => { const t = classify(m, e.n, k); return (H_SP3[t] ?? 0.5) + (t === "Ph" && A.h === 3 ? 0.12 : 0); }).sort((a, b) => b - a);
  const w = [1, 0.75, 0.6];
  sig.forEach((v, i) => { s += v * (w[i] ?? 0.5); });
  for (const e of m.adj[k]) {
    if (!isSp3C(m, e.n)) continue;
    for (const f of m.adj[e.n]) {
      if (f.n === k) continue; const B = m.atoms[f.n];
      if (B.el === "O") s += classify(m, f.n, e.n) === "OCOR" ? 0.35 : 0.25;
      else if (B.el === "N") s += 0.15;
      else if (["F", "Cl", "Br", "I"].includes(B.el)) s += 0.35;
      else if (B.arom) s += 0.3;
      else if (isCarbonyl(m, f.n)) s += 0.25;
    }
  }
  if (A.ring && m.rings.some((r) => r.length === 3 && r.includes(k))) s -= 1.0;
  return { s, exch: false };
}

function couplingJ(m: Mol, k: number, n: number): number[] {
  const a = m.atoms[k], b = m.atoms[n];
  if (a.arom && b.arom) { const r = ringFor(m, k); return [r && r.length === 5 ? 3.5 : 8.0]; }
  if (isCarbonyl(m, k) || isCarbonyl(m, n)) return [2.0];
  const bd = m.bonds[bondBetween(m, k, n)];
  if (bd && bd.order === 2) return b.h === 2 ? [17.0, 10.5] : [12.0];
  if (dblTo(m, k, "C") || dblTo(m, n, "C")) return [6.8];
  if (m.adj[k].some((e) => m.bonds[e.b].order === 3) || m.adj[n].some((e) => m.bonds[e.b].order === 3)) return [2.5];
  return [7.0];
}

const MULT_LETTER: Record<number, string> = { 1: "d", 2: "t", 3: "q", 4: "p", 5: "sext", 6: "hept" };

function multiplicity(groups: { n: number; J: number }[]): { mult: string; J: number[] } {
  if (!groups.length) return { mult: "s", J: [] };
  const g = [...groups].sort((p, q) => q.J - p.J);
  const merged: { n: number; J: number }[] = [];
  for (const x of g) { const last = merged[merged.length - 1]; if (last && Math.abs(last.J - x.J) <= 1.0) { last.J = (last.J * last.n + x.J * x.n) / (last.n + x.n); last.n += x.n; } else merged.push({ ...x }); }
  if (merged.length > 3 || merged.some((x) => x.n > 6) || (merged.length > 1 && merged.some((x) => x.n > 3))) return { mult: "m", J: [] };
  return { mult: merged.map((x) => MULT_LETTER[x.n]).join(""), J: merged.map((x) => Math.round(x.J * 10) / 10) };
}

export function predict1H(m: Mol): PredSignal[] {
  const byCls = new Map<number, number[]>();
  m.atoms.forEach((a, k) => { if (a.h > 0) { const c = m.sym[k]; byCls.set(c, [...(byCls.get(c) || []), k]); } });
  const out: PredSignal[] = [];
  for (const [cls, atoms] of byCls) {
    const k = atoms[0]; const { s, exch } = shift1H(m, k);
    let mult = exch ? "br s" : "s", J: number[] = [];
    if (!exch) {
      const partners = new Map<string, { n: number; J: number }>();
      for (const e of m.adj[k]) {
        const nb = m.atoms[e.n];
        if (!nb.h || nb.el !== "C" || m.sym[e.n] === cls) continue;
        const js = couplingJ(m, k, e.n);
        if (js.length === 2) { partners.set(`${m.sym[e.n]}a`, { n: 1, J: js[0] }); partners.set(`${m.sym[e.n]}b`, { n: 1, J: js[1] }); continue; }
        const key = `${m.sym[e.n]}|${js[0]}`;
        const p = partners.get(key); if (p) p.n += nb.h; else partners.set(key, { n: nb.h, J: js[0] });
      }
      const r = multiplicity([...partners.values()]); mult = r.mult; J = r.J;
    }
    const dk = dblTo(m, k, "C");
    if (!exch && m.atoms[k].h === 2 && dk && m.adj[dk.n].length > 1) {
      let zc = 0, zt = 0;
      for (const e of m.adj[dk.n]) if (e.n !== k) { const z = H_ALK[classify(m, e.n, dk.n)]; if (z) { zc += z[1]; zt += z[2]; } }
      const pH = m.atoms[dk.n].h > 0;
      out.push({ atoms, shift: Math.round((5.25 + zc) * 100) / 100, n: atoms.length, mult: pH ? "d" : "s", J: pH ? [17.0] : [], exch: false, label: "H-" + atoms.map((a) => a + 1).join(",") + "a", nucleus: "1H" });
      out.push({ atoms, shift: Math.round((5.25 + zt) * 100) / 100, n: atoms.length, mult: pH ? "d" : "s", J: pH ? [10.5] : [], exch: false, label: "H-" + atoms.map((a) => a + 1).join(",") + "b", nucleus: "1H" });
      continue;
    }
    const n = atoms.reduce((t, a) => t + m.atoms[a].h, 0);
    out.push({ atoms, shift: Math.round(s * 100) / 100, n, mult, J, exch, label: "H-" + atoms.map((a) => a + 1).join(","), nucleus: "1H" });
  }
  return out.sort((a, b) => b.shift - a.shift);
}

// ── ¹³C ──────────────────────────────────────────────────────
function shift13C(m: Mol, k: number): number {
  const A = m.atoms[k];
  if (isCarbonyl(m, k)) {
    const nb = m.adj[k].filter((e) => !(m.atoms[e.n].el === "O" && m.bonds[e.b].order === 2));
    const nO = nb.filter((e) => m.atoms[e.n].el === "O").length, nN = nb.filter((e) => m.atoms[e.n].el === "N").length;
    const conj = nb.some((e) => m.atoms[e.n].arom || !!dblTo(m, e.n, "C"));
    if (nO >= 2) return 155; if (nO && nN) return 156; if (nN >= 2) return 158;
    if (nb.some((e) => m.atoms[e.n].el === "Cl")) return 170;
    if (nO) { const o = nb.find((e) => m.atoms[e.n].el === "O")!; return m.atoms[o.n].h > 0 ? (conj ? 172 : 178) : (conj ? 166.5 : 171); }
    if (nN) { const nAr = nb.some((e) => m.atoms[e.n].el === "N" && m.adj[e.n].some((f) => m.atoms[f.n].arom)); return conj ? 168 : nAr ? 168.5 : 172; }
    if (A.h > 0 || nb.length < 2) return conj ? 192 : 200.5;
    return conj ? (nb.filter((e) => m.atoms[e.n].arom).length ? 197.5 : 199) : 207;
  }
  if (m.adj[k].some((e) => m.bonds[e.b].order === 3 && m.atoms[e.n].el === "N")) return m.adj[k].some((e) => m.atoms[e.n].arom) ? 119 : 118;
  const tr = m.adj[k].find((e) => m.bonds[e.b].order === 3);
  if (tr) { if (A.h > 0) return 68.5; return m.adj[k].some((e) => m.atoms[e.n].arom) ? 88 : m.atoms[tr.n].h ? 84 : 80; }
  if (m.adj[k].filter((e) => m.atoms[e.n].el === "F").length >= 3) return 124;
  if (dblTo(m, k, "N") && !A.arom) return 160;
  if (A.arom) {
    const r = ringFor(m, k);
    if (!r) return 128.5;
    let s = heteroBase(m, r, k, "13C"); const f = r.length === 5 ? 0.8 : 1;
    for (const [x, t] of ringSubs(m, r)) { const d = ringDist(r, x, k); const z = C_AR[t]; if (z && d <= 3) s += f * z[d]; }
    return s;
  }
  const dC = dblTo(m, k, "C");
  if (dC) {
    let s = 123.3;
    for (const e of m.adj[k]) if (e.n !== dC.n) { const z = C_ALK[classify(m, e.n, k)]; if (z) s += z[0]; }
    for (const e of m.adj[dC.n]) if (e.n !== k) { const z = C_ALK[classify(m, e.n, dC.n)]; if (z) s += z[1]; }
    return s;
  }
  let s = -2.3;
  const deg = (a: number) => m.adj[a].filter((e) => m.atoms[e.n].el === "C").length;
  const me = deg(k);
  const alpha: number[] = [];
  const corr: Record<string, number> = { "1-3": -1.1, "1-4": -3.4, "2-3": -2.5, "2-4": -7.2, "3-2": -3.7, "3-3": -9.5, "4-1": -1.5, "4-2": -8.4, "3-4": -15.0, "4-3": -15.0, "4-4": -25.0 };
  for (const e of m.adj[k]) {
    const t = classify(m, e.n, k);
    if (isSp3C(m, e.n)) {
      s += 9.1;
      const key = `${Math.max(1, me)}-${deg(e.n)}`; if (corr[key]) s += corr[key];
      for (const f of m.adj[e.n]) {
        if (f.n === k) continue;
        if (isSp3C(m, f.n) || (m.atoms[f.n].el === "C" && !isCarbonyl(m, f.n) && !m.atoms[f.n].arom && !dblTo(m, f.n, "C"))) {
          s += 9.4;
          for (const g of m.adj[f.n]) if (g.n !== e.n && m.atoms[g.n].el === "C") s -= 2.5;
        } else { const z = C_SP3[classify(m, f.n, e.n)] || C_SP3.Ph; s += z ? z[1] : 9.4; }
      }
    } else { const z = C_SP3[t] || C_SP3.other; if (z) alpha.push(z[0]); }
  }
  alpha.sort((a, b) => b - a).forEach((v, i) => { s += v * ([1, 0.7, 0.5][i] ?? 0.4); });
  if (m.rings.some((r) => r.length === 3 && r.includes(k))) s -= 18;
  return s;
}

export function predict13C(m: Mol): PredSignal[] {
  const byCls = new Map<number, number[]>();
  m.atoms.forEach((a, k) => { if (a.el === "C") byCls.set(m.sym[k], [...(byCls.get(m.sym[k]) || []), k]); });
  const out: PredSignal[] = [];
  for (const atoms of byCls.values()) {
    const s = shift13C(m, atoms[0]);
    out.push({ atoms, shift: Math.round(s * 10) / 10, n: atoms.length, mult: "s", J: [], exch: false, label: "C-" + atoms.map((a) => a + 1).join(","), nucleus: "13C" });
  }
  return out.sort((a, b) => b.shift - a.shift);
}
