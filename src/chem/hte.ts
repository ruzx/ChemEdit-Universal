import { str } from "./util";
// HTE planner engine: per-well recipes, stock solutions, plate layouts, screening designs
// (full factorial, balanced subset, one-factor-at-a-time) and Bayesian optimisation
// (Gaussian process + expected improvement, batch via "kriging believer").

export interface HLevel { name: string; smiles?: string; mw?: number; eq?: number; density?: number; solid?: boolean; components?: unknown; [k: string]: unknown }
export interface HComp { name: string; role?: string; smiles?: string; mw?: number; eq?: number; density?: number; conc_M?: number; solid?: boolean }
/** param: a level value that changes the set-up instead of adding a chemical (conc_M, volume_ul, temperature, time) */
export interface HFactor { name: string; eq?: number; solid?: boolean; param?: "conc_M" | "volume_ul" | "temperature" | "time" | "eq"; levels: Array<HLevel | string> }
export interface HFixed { in_prep?: boolean; name: string; smiles?: string; mw?: number; eq?: number; density?: number; conc_M?: number; solid?: boolean; limiting?: boolean; from_prep?: boolean; after?: boolean }
export interface HPrep { reagents_note?: string; name?: string; smiles?: string; mmol?: number; solvent?: string; volume_ml?: number; product?: string; product_smiles?: string; conversion?: number; reagents?: Array<{ name: string; eq?: number; mw?: number; density?: number }> }
export interface HRes { yield?: number | null; area_p?: number | null; area_is?: number | null; conv?: number | null }
export interface HRun extends HRes { well: string; batch?: number; f: Record<string, string>; note?: string; skip?: boolean; t?: Record<string, HRes> }
export interface HteData {
  type: "hte"; title?: string; temperature?: string; time?: string; atmosphere?: string; product?: { name?: string; smiles?: string }; plate?: string | number; scale_mmol?: number; volume_ul?: number; overage_percent?: number; solvent?: string;
  stock_ul?: number; prep?: HPrep; fixed?: HFixed[]; factors?: HFactor[]; runs?: HRun[]; batch_size?: number;
  analysis?: { method?: "yield" | "hplc"; rf?: number; is_eq?: number; timepoints?: string[] }; [k: string]: unknown;
}

export const PLATES: Record<string, { rows: number; cols: number; label: string }> = {
  "4": { rows: 1, cols: 4, label: "4 vials" }, "6": { rows: 2, cols: 3, label: "6 vials" }, "8": { rows: 2, cols: 4, label: "8 vials" },
  "12": { rows: 3, cols: 4, label: "12-well" }, "24": { rows: 4, cols: 6, label: "24-well" }, "48": { rows: 6, cols: 8, label: "48-well" }, "96": { rows: 8, cols: 12, label: "96-well" },
};
export const wellIds = (plate: string) => { const p = PLATES[plate] ?? PLATES["24"]; const out: string[] = []; for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) out.push(String.fromCharCode(65 + r) + (c + 1)); return out; };

export const lvl = (l: HLevel | string | number): HLevel => (typeof l === "object" && l ? l : { name: String(l) });
export const numVal = (s: string): number | null => { const m = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(String(s)); return m ? parseFloat(m[1].replace(",", ".")) : null; };
export const isNumericFactor = (f: HFactor) => !!f.param || (f.levels.length > 1 && f.levels.map(lvl).every((l) => numVal(l.name) !== null && !l.mw && !l.smiles && !l.components));
const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : isFinite(Number(v)) ? Number(v) : null);

export function combos(factors: HFactor[]): Array<Record<string, string>> {
  let out: Array<Record<string, string>> = [{}];
  for (const f of factors) {
    const ls = f.levels.map(lvl).map((l) => l.name).filter(Boolean);
    const next: Array<Record<string, string>> = [];
    for (const c of out) for (const l of ls.length ? ls : ["–"]) next.push({ ...c, [f.name]: l });
    out = next;
  }
  return factors.length ? out : [];
}
const key = (f: Record<string, string>, factors: HFactor[]) => factors.map((x) => f[x.name] ?? "").join("|");

// ------------------------------------------------------------------ amounts

export interface Line { stockKey?: string; name: string; mmol: number | null; mg: number | null; ul: number | null; how: string; warn?: string; stock?: { conc: number; totalUl: number; mg: number | null } ; after?: boolean }
export interface Recipe { lines: Line[]; solventUl: number | null; warnings: string[]; volumeUl?: number | null }

export function prepInfo(d: HteData) {
  const p = d.prep;
  if (!p || !num(p.mmol) || !num(p.volume_ml)) return null;
  const mmol = num(p.mmol)! * ((num(p.conversion) ?? 100) / 100);
  const conc = mmol / num(p.volume_ml)!; // mmol/mL = M
  const fx = (d.fixed ?? []).find((f) => f.from_prep);
  const per = fx ? (num(d.scale_mmol) ?? 0.1) * (num(fx.eq) ?? 1) : null;
  const ov = 1 + (num(d.overage_percent) ?? 10) / 100;
  return { mmol, conc, perWell: per, maxWells: per ? Math.floor(mmol / (per * ov) + 1e-9) : null, reagents: (p.reagents ?? []).map((r) => ({ ...r, mmol: num(p.mmol)! * (num(r.eq) ?? 1), mg: num(r.mw) ? num(p.mmol)! * (num(r.eq) ?? 1) * num(r.mw)! : null })) };
}

/** amount line for one component in one well; nWells = how many wells use it (for stock prep) */
function line(name: string, mmol: number, c: { mw?: number; density?: number; conc_M?: number; solid?: boolean; from_prep?: boolean; after?: boolean }, d: HteData, nWells: number, prepConc: number | null, mwOf: (s: string) => number | null, smiles?: string): Line {
  const mw = num(c.mw) ?? (smiles ? mwOf(smiles) : null);
  const mg = mw ? mmol * mw : null;
  const ov = 1 + (num(d.overage_percent) ?? 10) / 100;
  const stockUl = num(d.stock_ul) ?? 50;
  if (c.from_prep && prepConc) return { name, mmol, mg, ul: (mmol / prepConc) * 1000, how: "from prep solution", after: c.after };
  if (num(c.conc_M)) return { name, mmol, mg, ul: (mmol / num(c.conc_M)!) * 1000, how: `${c.conc_M} M solution`, after: c.after };
  if (c.solid) {
    const warn = mg !== null && mg < 1 ? `${mg.toFixed(2)} mg is hard to weigh — use a stock/slurry or scale up` : undefined;
    return { name, mmol, mg, ul: null, how: "weigh solid into each vial", warn, after: c.after };
  }
  if (num(c.density) && mg !== null && mg / num(c.density)! >= 5) return { name, mmol, mg, ul: mg / num(c.density)!, how: "neat liquid", after: c.after };
  // stock solution so each well receives `stockUl`
  const conc = mmol / (stockUl / 1000); // M
  const totalUl = Math.ceil((nWells * ov * stockUl + 50) / 50) * 50;
  return { name, mmol, mg, ul: stockUl, how: "stock solution", stock: { conc, totalUl, mg: mw ? conc * (totalUl / 1000) * mw : null }, after: c.after };
}

export function recipe(d: HteData, f: Record<string, string>, mwOf: (s: string) => number | null, runsUsing: (factor: string | null, level: string | null, comp?: string) => number): Recipe {
  const scale = num(d.scale_mmol) ?? 0.1;
  const pi = prepInfo(d);
  const lines: Line[] = [];
  const replaced = new Set<string>();
  for (const fac of d.factors ?? []) { const L = fac.levels.map(lvl).find((l) => l.name === f[fac.name]); if (L?.replaces) replaced.add(String(L.replaces).toLowerCase()); }
  for (const c of d.fixed ?? []) {
    if (replaced.has(c.name.toLowerCase())) { lines.push({ name: c.name, mmol: null, mg: null, ul: null, how: "omitted (replaced by preformed complex)" }); continue; }
    const mmol = scale * (num(c.eq) ?? 1);
    if (c.in_prep) { const mw = num(c.mw) ?? (c.smiles ? mwOf(c.smiles) : null); lines.push({ name: c.name, mmol, mg: mw ? mmol * mw : null, ul: null, how: "contained in the prep / master-mix solution", stockKey: "__inprep" }); continue; }
    lines.push(line(c.name, mmol, c, d, runsUsing(null, null), pi?.conc ?? null, mwOf, c.smiles));
  }
  for (const fac of d.factors ?? []) {
    const L = (fac.levels.map(lvl)).find((l) => l.name === f[fac.name]);
    if (fac.param) continue; // set-up parameter, no chemical
    if (L && Array.isArray(L.components) && L.components.length) {
      (L.components as HComp[]).forEach((c, i) => {
        const role = c.role || `part ${i + 1}`;
        const mmol = scale * (num(c.eq) ?? 1);
        const ln = line(`${fac.name} · ${role}: ${c.name}`, mmol, c, d, runsUsing(fac.name, L.name, c.name), pi?.conc ?? null, mwOf, c.smiles);
        ln.stockKey = c.name;
        lines.push(ln);
      });
      continue;
    }
    if (!L || /^(none|no |blank|control|–|-)/i.test(L.name) || (!num(L.eq ?? fac.eq) && !L.mw && !L.smiles)) { lines.push({ name: `${fac.name}: ${f[fac.name] ?? "–"}`, mmol: null, mg: null, ul: null, how: "—" }); continue; }
    const mmol = scale * (num(L.eq) ?? num(fac.eq) ?? 1);
    lines.push(line(`${fac.name}: ${L.name}`, mmol, { ...L, solid: L.solid ?? fac.solid }, d, runsUsing(fac.name, L.name), pi?.conc ?? null, mwOf, L.smiles));
  }
  const used = lines.filter((l) => !l.after).reduce((s, l) => s + (l.ul ?? 0), 0);
  let V = num(d.volume_ul);
  for (const fac of d.factors ?? []) {
    const v = numVal(f[fac.name] ?? "");
    if (v === null) continue;
    if (fac.param === "volume_ul") V = v;
    if (fac.param === "conc_M" && v > 0) V = (scale / v) * 1000;
  }
  const warnings: string[] = [];
  const solventUl = V !== null ? V - used : null;
  if (solventUl !== null && solventUl < -1) warnings.push(`Dispensed volumes (${used.toFixed(0)} µL) exceed the well volume (${V} µL) — use more concentrated stocks.`);
  return { lines, solventUl, warnings, volumeUl: V };
}

// ------------------------------------------------------------------ designs

/** greedy balanced / space-filling subset: maximise min Hamming distance + level balance */
export function balancedSubset(all: Array<Record<string, string>>, n: number, factors: HFactor[], already: Array<Record<string, string>> = []): Array<Record<string, string>> {
  const chosen = [...already];
  const pool = all.filter((c) => !already.some((a) => key(a, factors) === key(c, factors)));
  const out: Array<Record<string, string>> = [];
  const ham = (a: Record<string, string>, b: Record<string, string>) => factors.reduce((s, f) => s + (a[f.name] !== b[f.name] ? 1 : 0), 0);
  while (out.length < n && pool.length) {
    let best = -Infinity, bi = 0;
    pool.forEach((c, i) => {
      const md = chosen.length ? Math.min(...chosen.map((x) => ham(x, c))) : factors.length;
      const bal = factors.reduce((s, f) => s - chosen.filter((x) => x[f.name] === c[f.name]).length, 0);
      const sc = md * 10 + bal - i * 1e-6;
      if (sc > best) { best = sc; bi = i; }
    });
    const [c] = pool.splice(bi, 1);
    out.push(c); chosen.push(c);
  }
  return out;
}

export function ofat(factors: HFactor[]): Array<Record<string, string>> {
  const base: Record<string, string> = {};
  for (const f of factors) base[f.name] = lvl(f.levels[0]).name;
  const out = [base];
  for (const f of factors) for (const l of f.levels.slice(1)) out.push({ ...base, [f.name]: lvl(l).name });
  return out;
}

// ------------------------------------------------------------------ results

export const timepoints = (d: HteData): string[] => (d.analysis?.timepoints?.length ? d.analysis.timepoints : [""]);
export function resOf(r: HRun, tp: string): HRes { if (!tp) return r; r.t = r.t ?? {}; return (r.t[tp] = r.t[tp] ?? {}); }
function yieldOfRes(d: HteData, x: HRes): number | null {
  if (num(x.yield) !== null) return num(x.yield);
  const a = num(x.area_p), b = num(x.area_is);
  if (a === null || !b) return null;
  const rf = num(d.analysis?.rf) ?? 1, isEq = num(d.analysis?.is_eq) ?? 1;
  return (100 * (a / b) * isEq) / rf; // assay yield vs limiting reagent
}
/** yield at a timepoint, or the latest available one */
export function runYield(d: HteData, r: HRun, tp?: string): number | null {
  if (tp !== undefined) return yieldOfRes(d, tp ? r.t?.[tp] ?? {} : r);
  const tps = timepoints(d);
  for (let i = tps.length - 1; i >= 0; i--) { const y = yieldOfRes(d, tps[i] ? r.t?.[tps[i]] ?? {} : r); if (y !== null) return y; }
  return tps[0] ? yieldOfRes(d, r) : null;
}

export function mainEffects(d: HteData) {
  const res: Array<{ factor: string; levels: Array<{ name: string; mean: number | null; n: number; best: number | null }> }> = [];
  const done = (d.runs ?? []).map((r) => ({ r, y: runYield(d, r) })).filter((x) => x.y !== null && !x.r.skip);
  for (const f of d.factors ?? []) {
    res.push({ factor: f.name, levels: f.levels.map(lvl).map((l) => { const ys = done.filter((x) => x.r.f[f.name] === l.name).map((x) => x.y!); return { name: l.name, n: ys.length, mean: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null, best: ys.length ? Math.max(...ys) : null }; }) });
  }
  return res;
}

// ------------------------------------------------------------------ Bayesian optimisation

/** level index per factor (categorical encoding) */
function encode(c: Record<string, string>, factors: HFactor[]): number[] {
  return factors.map((f) => {
    if (!isNumericFactor(f)) return f.levels.map(lvl).findIndex((l) => l.name === c[f.name]);
    const vals = f.levels.map(lvl).map((l) => numVal(l.name) ?? 0);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return hi > lo ? ((numVal(c[f.name] ?? "") ?? lo) - lo) / (hi - lo) : 0;
  });
}
function chol(A: number[][]): number[][] | null {
  const n = A.length, L = A.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    if (i === j) { if (s <= 0) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
  }
  return L;
}
const solveL = (L: number[][], b: number[]) => { const x = b.slice(); for (let i = 0; i < x.length; i++) { for (let k = 0; k < i; k++) x[i] -= L[i][k] * x[k]; x[i] /= L[i][i]; } return x; };
const solveLT = (L: number[][], b: number[]) => { const x = b.slice(); for (let i = x.length - 1; i >= 0; i--) { for (let k = i + 1; k < x.length; k++) x[i] -= L[k][i] * x[k]; x[i] /= L[i][i]; } return x; };
const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const Phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
const phi = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

export interface Suggestion { f: Record<string, string>; mean: number; sd: number; ei: number }

function gpFit(X: number[][], y: number[], isNum: boolean[]) {
  // categorical kernel: additive main effects (share of matching factors) + interaction term (all factors equal)
  // mixed kernel: categorical factors → match/no match; numeric factors → smooth RBF on the scaled value.
  // additive main effects + product interaction term
  const kern = (a: number[], b: number[], rho: number) => {
    let m = 0, prod = 1;
    for (let i = 0; i < a.length; i++) {
      const sim = isNum[i] ? Math.exp(-((a[i] - b[i]) ** 2) / (2 * 0.35 * 0.35)) : a[i] === b[i] ? 1 : 0;
      m += sim; prod *= sim;
    }
    return (1 - rho) * (m / a.length) + rho * prod + 0.05;
  };
  let best: { L: number[][]; alpha: number[]; l: number; noise: number; lml: number; amp: number } | null = null;
  for (const l of [0.05, 0.2, 0.4, 0.7]) for (const noise of [0.03, 0.08]) for (const amp of [1, 2, 4]) {
    const K = X.map((a, i) => X.map((b, j) => amp * kern(a, b, l) + (i === j ? noise : 0)));
    const L = chol(K);
    if (!L) continue;
    const alpha = solveLT(L, solveL(L, y));
    const lml = -0.5 * y.reduce((s, v, i) => s + v * alpha[i], 0) - L.reduce((s, r, i) => s + Math.log(r[i]), 0);
    if (!best || lml > best.lml) best = { L, alpha, l, noise, lml, amp };
  }
  if (!best) return null;
  const { L, alpha, l, amp } = best;
  return (x: number[]) => {
    const k = X.map((a) => amp * kern(a, x, l));
    const mean = k.reduce((s, v, i) => s + v * alpha[i], 0);
    const v = solveL(L, k);
    const varr = Math.max(1e-9, amp * kern(x, x, l) - v.reduce((s, q) => s + q * q, 0));
    return { mean, sd: Math.sqrt(varr) };
  };
}

/** Suggest the next `n` untested combinations by expected improvement (yields 0–100). */
export function suggestBO(d: HteData, n: number): { picks: Suggestion[]; ranked: Suggestion[]; mode: "bo" | "explore" } {
  const factors = d.factors ?? [];
  const all = combos(factors);
  const done = (d.runs ?? []).filter((r) => !r.skip).map((r) => ({ f: r.f, y: runYield(d, r) }));
  const measured = done.filter((x) => x.y !== null) as Array<{ f: Record<string, string>; y: number }>;
  const tested = new Set(done.map((x) => key(x.f, factors)));
  const untested = all.filter((c) => !tested.has(key(c, factors)));
  if (measured.length < 3) {
    const picks = balancedSubset(untested, n, factors, done.map((x) => x.f)).map((f) => ({ f, mean: NaN, sd: NaN, ei: NaN }));
    return { picks, ranked: picks, mode: "explore" };
  }
  const ys = measured.map((m) => m.y);
  const mu = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sdY = Math.sqrt(ys.reduce((a, b) => a + (b - mu) ** 2, 0) / ys.length) || 10;
  const X = measured.map((m) => encode(m.f, factors));
  let Y = ys.map((v) => (v - mu) / sdY);
  const isNum = factors.map(isNumericFactor);
  let gp = gpFit(X, Y, isNum);
  if (!gp) return { picks: [], ranked: [], mode: "bo" };
  const score = (pred: (x: number[]) => { mean: number; sd: number }, bestY: number) => (c: Record<string, string>): Suggestion => {
    const p = pred(encode(c, factors));
    const z = (p.mean - bestY - 0.01) / p.sd;
    const ei = (p.mean - bestY - 0.01) * Phi(z) + p.sd * phi(z);
    return { f: c, mean: p.mean * sdY + mu, sd: p.sd * sdY, ei: ei * sdY };
  };
  const ranked = untested.map(score(gp, Math.max(...Y))).sort((a, b) => b.ei - a.ei);
  // batch: kriging believer
  const picks: Suggestion[] = [];
  const Xb = X.slice(), Yb = Y.slice();
  let pool = untested.slice();
  for (let i = 0; i < n && pool.length; i++) {
    const sc = pool.map(score(gp, Math.max(...Yb))).sort((a, b) => b.ei - a.ei);
    const top = sc[0];
    picks.push(ranked.find((r) => key(r.f, factors) === key(top.f, factors)) ?? top);
    Xb.push(encode(top.f, factors)); Yb.push((top.mean - mu) / sdY);
    pool = pool.filter((c) => key(c, factors) !== key(top.f, factors));
    gp = gpFit(Xb, Yb, isNum) ?? gp;
  }
  return { picks, ranked, mode: "bo" };
}

export function mlCsv(d: HteData): string {
  const factors = d.factors ?? [];
  const oneHot = factors.flatMap((f) => f.levels.map(lvl).map((l) => `${f.name}=${l.name}`));
  const head = ["well", "batch", ...factors.map((f) => f.name), ...oneHot, "yield"];
  const q = (s: unknown) => `"${str(s).replace(/"/g, '""')}"`;
  const rows = (d.runs ?? []).filter((r) => !r.skip).map((r) => [r.well, r.batch ?? 1, ...factors.map((f) => r.f[f.name]), ...factors.flatMap((f) => f.levels.map(lvl).map((l) => (r.f[f.name] === l.name ? 1 : 0))), runYield(d, r) ?? ""]);
  return [head.map(q).join(","), ...rows.map((r) => r.map((v, i) => (i < 2 + factors.length ? q(v) : v)).join(","))].join("\n");
}

// ------------------------------------------------------------------ plan checker

export interface Check { k: "warn" | "info" | "ok"; t: string }
export function planChecks(d: HteData, recipeFor: (f: Record<string, string>) => Recipe): Check[] {
  const out: Check[] = [];
  const runs = (d.runs ?? []).filter((r) => !r.skip);
  const scale = num(d.scale_mmol), V = num(d.volume_ul);
  const allNames = [...(d.fixed ?? []).map((c) => c.name), ...(d.factors ?? []).flatMap((f) => [f.name, ...f.levels.map(lvl).flatMap((l) => [l.name, ...((l.components as HComp[] | undefined) ?? []).map((c) => c.name)])])].join(" ");
  if (scale && V) {
    const c = scale / (V / 1000);
    if (c < 0.1) out.push({ k: "warn", t: `Dilute: ${c.toFixed(2)} M in the limiting reagent. Ni cross-couplings usually run at 0.1–0.5 M — reduce the volume per vial.` });
    else out.push({ k: "ok", t: `Concentration ${c.toFixed(2)} M (limiting reagent).` });
  }
  if (!(d.fixed ?? []).some((c) => c.limiting)) out.push({ k: "info", t: "Mark the limiting reagent (yields are calculated against it)." });
  if (/\bni|nickel/i.test(allNames + " " + (d.title ?? "")) && !/\b(zn|mn|zinc|manganese|tdae|phnhnh2|reductant|b2pin2|hantzsch|silane|electro)/i.test(allNames)) out.push({ k: "warn", t: "No reductant found — reductive Ni cross-electrophile coupling needs Zn or Mn dust (≈2–3 eq) or another reductant." });
  const pi = prepInfo(d);
  if (pi?.maxWells !== null && pi?.maxWells !== undefined && runs.length > pi.maxWells) out.push({ k: "warn", t: `Prep solution only covers ${pi.maxWells} wells but ${runs.length} are planned.` });
  if (!(d.factors ?? []).some((f) => f.levels.map(lvl).some((l) => /^(none|no |blank|control)/i.test(l.name)))) out.push({ k: "info", t: "Tip: one control vial (e.g. Ni without ligand) shows the background reactivity." });
  const keys = runs.map((r) => JSON.stringify(r.f));
  if (runs.length >= 4 && new Set(keys).size === keys.length) out.push({ k: "info", t: "Tip: duplicate the expected best condition once to see the reproducibility (noise) — it makes the Bayesian model much better calibrated." });
  if ((d.analysis?.method ?? "hplc") === "hplc" && !(d.fixed ?? []).some((c) => c.after)) out.push({ k: "info", t: "Add an internal standard (mark it “added after”) for HPLC/GC assay yields." });
  if (timepoints(d).length < 2) out.push({ k: "info", t: "Tip: sample each vial at two timepoints (e.g. 4 h and 16 h) — free kinetic information. Set them in Results → Timepoints." });
  const warns = new Set<string>();
  for (const r of runs) { const rc = recipeFor(r.f); rc.warnings.forEach((w) => warns.add(w)); rc.lines.filter((l) => l.warn).forEach((l) => warns.add(`${l.name}: ${l.warn}`)); }
  for (const w of warns) out.push({ k: "warn", t: w });
  if (!out.some((c) => c.k === "warn") && runs.length) out.push({ k: "ok", t: `${runs.length} reactions planned — plan is consistent.` });
  return out;
}

export const XEC_EXAMPLE: HteData = {
  type: "hte",
  title: "XEC screen — 3-phenylpropyl iodide + 4-bromoanisole",
  plate: "6", scale_mmol: 0.1, volume_ul: 500, overage_percent: 10, solvent: "DMA", stock_ul: 50, batch_size: 6,
  prep: { name: "3-phenylpropyl tosylate", smiles: "Cc1ccc(S(=O)(=O)OCCCc2ccccc2)cc1", mmol: 1.0, solvent: "DMA", volume_ml: 1.5, product: "3-phenylpropyl iodide", product_smiles: "ICCCc1ccccc1", conversion: 100, reagents: [{ name: "TBAI", eq: 1.5, mw: 369.37 }] },
  fixed: [
    { name: "4-bromoanisole (ArBr)", smiles: "COc1ccc(Br)cc1", eq: 1, density: 1.494, limiting: true },
    { name: "3-phenylpropyl iodide (prep)", eq: 1.5, from_prep: true },
    { name: "NiBr2·glyme", mw: 308.62, eq: 0.1 },
    { name: "1,3,5-trimethoxybenzene (HPLC IS, after)", mw: 168.19, eq: 0.33, after: true },
  ],
  factors: [
    { name: "ligand", eq: 0.12, levels: [{ name: "dtbbpy", mw: 268.4 }, { name: "bpy", mw: 156.19 }, { name: "4,4'-(MeO)2bpy", mw: 216.24 }, { name: "phen", mw: 180.21 }, { name: "BiOX", mw: 240.3 }, { name: "(dtbbpy)NiCl2 preformed", mw: 398.0, eq: 0.1, replaces: "NiBr2·glyme" }] },
    { name: "reductant", levels: [{ name: "Mn", mw: 54.94, eq: 2, solid: true }, { name: "Zn", mw: 65.38, eq: 2, solid: true }, { name: "PhNHNH2", mw: 108.14, eq: 2, density: 1.098 }] },
  ],
  analysis: { method: "hplc", rf: 1, is_eq: 0.33 },
  runs: [],
};

const NI = { role: "Ni", name: "NiBr2·glyme", mw: 308.62, eq: 0.1 };
const lig = (name: string, mw: number, smiles?: string) => ({ name: `NiBr2·glyme + ${name}`, components: [NI, { role: "ligand", name, mw, eq: 0.1, ...(smiles ? { smiles } : {}) }] });

/** Your first XEC test: one variable (catalyst system), everything else fixed. */
export const XEC_CATSYS: HteData = {
  type: "hte",
  title: "XEC test — Ni catalyst systems (3-phenylpropyl iodide + 4-bromoanisole)",
  plate: "6", scale_mmol: 0.06667, volume_ul: 650, overage_percent: 0, solvent: "DMA", stock_ul: 50, batch_size: 6,
  temperature: "60 °C", time: "16 h", atmosphere: "N₂",
  product: { name: "1-methoxy-4-(3-phenylpropyl)benzene", smiles: "COc1ccc(CCCc2ccccc2)cc1" },
  prep: { name: "3-phenylpropyl tosylate", smiles: "Cc1ccc(S(=O)(=O)OCCCc2ccccc2)cc1", mmol: 1.0, solvent: "DMA", volume_ml: 5, product: "3-phenylpropyl iodide (+ ArBr, TMSCl master mix)", product_smiles: "ICCCc1ccccc1", conversion: 100, reagents: [{ name: "TBAI", eq: 1.5, mw: 369.37 }, { name: "4-bromoanisole (add after iodide formation)", eq: 0.667, mw: 187.04, density: 1.494 }, { name: "TMSCl (add just before dispensing)", eq: 0.133, mw: 108.64, density: 0.856 }] },
  fixed: [
    { name: "4-bromoanisole (ArBr)", smiles: "COc1ccc(Br)cc1", eq: 1, limiting: true, in_prep: true },
    { name: "3-phenylpropyl iodide", smiles: "ICCCc1ccccc1", eq: 1.5, in_prep: true },
    { name: "TMSCl (Mn activator)", mw: 108.64, eq: 0.2, in_prep: true },
    { name: "master mix: RI 0.2 M + ArBr 0.133 M in DMA", eq: 1.5, from_prep: true },
    { name: "Mn powder", mw: 54.94, eq: 3, solid: true },
    { name: "1,3,5-trimethoxybenzene (IS, after)", mw: 168.19, eq: 0.33, after: true },
  ],
  factors: [
    { name: "catalyst system", levels: [
      lig("dtbbpy", 268.4, "CC(C)(C)c1ccnc(-c2cc(C(C)(C)C)ccn2)c1"),
      { name: "(dtbbpy)NiCl2 preformed", components: [{ role: "Ni", name: "(dtbbpy)NiCl2", mw: 398.0, eq: 0.1 }] },
      lig("4,4'-(MeO)2bpy", 216.24, "COc1ccnc(-c2cc(OC)ccn2)c1"),
      lig("PyBCam·2HCl", 236.1, "NC(=N)c1cccc(C(N)=N)n1.Cl.Cl"),
      lig("1,10-phen", 180.21, "c1cnc2c(c1)ccc1cccnc12"),
      { name: "control: NiBr2·glyme, no ligand", components: [NI] },
    ] },
  ],
  analysis: { method: "hplc", rf: 1, is_eq: 0.33, timepoints: ["4 h", "16 h"] },
  runs: [],
  notes: "Vigorous stirring (Mn is heterogeneous). Pre-stir Ni + ligand 10 min in DMA, then add the master mix (with TMSCl) last.",
};

/** A typical second round: best ligands × reductant × temperature × concentration (Bayesian). */
export const XEC_ROUND2: HteData = {
  type: "hte", title: "XEC round 2 — Bayesian (ligand × reductant × T × conc.)", plate: "24", scale_mmol: 0.05, volume_ul: 250, overage_percent: 10, solvent: "DMA", stock_ul: 25, batch_size: 6,
  fixed: [{ name: "4-bromoanisole", smiles: "COc1ccc(Br)cc1", eq: 1, limiting: true, conc_M: 1 }, { name: "3-phenylpropyl iodide", smiles: "ICCCc1ccccc1", eq: 1.5, conc_M: 1 }, { name: "NiBr2·glyme", mw: 308.62, eq: 0.1 }, { name: "1,3,5-trimethoxybenzene (IS, after)", mw: 168.19, eq: 0.33, after: true }],
  factors: [
    { name: "ligand", eq: 0.1, levels: [{ name: "dtbbpy", mw: 268.4 }, { name: "4,4'-(MeO)2bpy", mw: 216.24 }, { name: "PyBCam·2HCl", mw: 236.1 }] },
    { name: "reductant", levels: [{ name: "Zn", mw: 65.38, eq: 3, solid: true }, { name: "Mn", mw: 54.94, eq: 3, solid: true }] },
    { name: "temperature", param: "temperature", levels: ["40 °C", "60 °C", "80 °C"] },
    { name: "concentration", param: "conc_M", levels: ["0.1 M", "0.2 M", "0.4 M"] },
  ],
  analysis: { method: "hplc", rf: 1, is_eq: 0.33, timepoints: ["16 h"] }, runs: [],
};

export const BLANK_HTE: HteData = { type: "hte", title: "", plate: "24", scale_mmol: 0.05, volume_ul: 250, overage_percent: 10, solvent: "", stock_ul: 25, batch_size: 6, fixed: [], factors: [{ name: "variable 1", levels: [{ name: "A" }, { name: "B" }] }], runs: [], analysis: { method: "hplc", rf: 1, is_eq: 0.33 } };

export const HTE_PRESETS: Array<{ id: string; title: string; desc: string; data: HteData }> = [
  { id: "xec1", title: "XEC — 6 Ni catalyst systems", desc: "Your first test: one variable, master mix, control vial, 2 timepoints", data: XEC_CATSYS },
  { id: "xec2", title: "XEC — round 2 (Bayesian)", desc: "Ligand × reductant × temperature × concentration, batches of 6", data: XEC_ROUND2 },
  { id: "full", title: "Ligand × reductant (18 combos)", desc: "The earlier two-variable example", data: XEC_EXAMPLE },
  { id: "blank", title: "Empty planner", desc: "Start from scratch", data: BLANK_HTE },
];
