// Lab calculators (pure functions, no DOM). Each definition describes its inputs, tables and results,
// so one renderer can draw all of them. Values are computed at render time; only inputs are stored in YAML.

export type FieldType = "num" | "text" | "bool" | "smiles" | "select";
export interface Field { k: string; l: string; u?: string; t?: FieldType; opts?: string[]; ph?: string }
export interface TableDef { k: string; title: string; cols: Field[]; outs?: Field[] }
export interface Result { k: string; l: string; u?: string; d?: number; hero?: boolean; grade?: [number, number]; lowGood?: boolean; text?: boolean }
export type OutVal = number | string | null | undefined;
export interface CalcOut { v: Record<string, OutVal>; rows?: Record<string, Array<Record<string, OutVal>>>; notes?: string[]; plot?: Plot }
/** One table row as stored in YAML (values are whatever the user typed). */
export type Row = Record<string, unknown>;
/** Calculator inputs as stored in YAML. */
export type CalcData = Record<string, unknown>;
export interface Plot { kind: "xy"; extendX?: boolean; points: Array<{ x: number; y: number; off?: boolean }>; line?: { m: number; b: number }; xl: string; yl: string; step?: boolean }
export interface CalcDef {
  id: string; title: string; group: "Organic" | "Analytical" | "Bio" | "Polymer" | "HTE"; icon: string; desc: string;
  fields: Field[]; tables?: TableDef[]; results: Result[]; example: CalcData;
  calc: (d: CalcData, mw: (smiles: string) => number | null) => CalcOut;
}

export const n = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "" || v === false) return null;
  const x = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return isFinite(x) ? x : null;
};
const z = (v: unknown, def = 0) => n(v) ?? def;
const str = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? "" : String(v as string | number | boolean));
const F = 96485.332;
const rows = (d: CalcData, k: string): Row[] => { const v = d[k]; if (Array.isArray(v)) return v as Row[]; const r: Row[] = []; d[k] = r; return r; };

export function linreg(pts: Array<{ x: number; y: number }>) {
  const N = pts.length;
  if (N < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxy += p.x * p.y; sxx += p.x * p.x; }
  const den = N * sxx - sx * sx;
  if (!den) return null;
  const m = (N * sxy - sx * sy) / den, b = (sy - m * sx) / N;
  const my = sy / N;
  let ssT = 0, ssR = 0;
  for (const p of pts) { ssT += (p.y - my) ** 2; ssR += (p.y - (m * p.x + b)) ** 2; }
  const syx = N > 2 ? Math.sqrt(ssR / (N - 2)) : 0;
  return { m, b, r2: ssT ? 1 - ssR / ssT : 1, syx };
}

const CODONS: Record<string, string> = {};
"TTT F TTC F TTA L TTG L CTT L CTC L CTA L CTG L ATT I ATC I ATA I ATG M GTT V GTC V GTA V GTG V TCT S TCC S TCA S TCG S CCT P CCC P CCA P CCG P ACT T ACC T ACA T ACG T GCT A GCC A GCA A GCG A TAT Y TAC Y TAA * TAG * CAT H CAC H CAA Q CAG Q AAT N AAC N AAA K AAG K GAT D GAC D GAA E GAG E TGT C TGC C TGA * TGG W CGT R CGC R CGA R CGG R AGT S AGC S AGA R AGG R GGT G GGC G GGA G GGG G"
  .split(" ").forEach((v, i, a) => { if (i % 2 === 0) CODONS[v] = a[i + 1]; });

export const CALCS: CalcDef[] = [
  // ------------------------------------------------------------ ORGANIC
  {
    id: "nmr_yield", title: "qNMR / NMR yield", group: "Organic", icon: "activity", desc: "Yield from an internal standard integral.",
    fields: [
      { k: "standard_name", l: "Standard", t: "text", ph: "1,3,5-trimethoxybenzene" }, { k: "standard_mw", l: "Standard MW", u: "g/mol" },
      { k: "standard_mass_mg", l: "Standard mass", u: "mg" }, { k: "standard_purity", l: "Standard purity", u: "%" },
      { k: "standard_protons", l: "Standard H (N)" }, { k: "standard_integral", l: "Standard integral" },
      { k: "product_mw", l: "Product MW", u: "g/mol" }, { k: "product_protons", l: "Product H (N)" },
      { k: "product_integral", l: "Product integral" }, { k: "theory_mmol", l: "Theoretical", u: "mmol" },
    ],
    results: [{ k: "std_mmol", l: "Standard", u: "mmol", d: 4 }, { k: "product_mmol", l: "Product", u: "mmol", d: 4 }, { k: "product_mass_mg", l: "Product", u: "mg", d: 1 }, { k: "yield", l: "NMR yield", u: "%", d: 1, hero: true, grade: [80, 40] }],
    example: { standard_name: "1,3,5-trimethoxybenzene", standard_mw: 168.19, standard_mass_mg: 16.8, standard_purity: 99, standard_protons: 3, standard_integral: 1, product_mw: 250, product_protons: 1, product_integral: 1.3, theory_mmol: 0.5 },
    calc: (d) => {
      const std = (z(d.standard_mass_mg) * z(d.standard_purity, 100) / 100) / z(d.standard_mw, 1);
      const ns = z(d.standard_integral) / z(d.standard_protons, 1), np = z(d.product_integral) / z(d.product_protons, 1);
      const pm = ns > 0 ? std * (np / ns) : null;
      return { v: { std_mmol: std, product_mmol: pm, product_mass_mg: pm !== null && n(d.product_mw) ? pm * z(d.product_mw) : null, yield: pm !== null && n(d.theory_mmol) ? (100 * pm) / z(d.theory_mmol) : null } };
    },
  },
  {
    id: "faradaic_efficiency", title: "Faradaic efficiency", group: "Organic", icon: "zap", desc: "Charge passed, F/mol and current efficiency of an electrolysis.",
    fields: [{ k: "current_mA", l: "Current", u: "mA" }, { k: "time_hours", l: "Time", u: "h" }, { k: "charge_C", l: "…or charge", u: "C" }, { k: "electrons_z", l: "Electrons (z)" }, { k: "substrate_mmol", l: "Substrate", u: "mmol" }, { k: "product_mmol", l: "Product formed", u: "mmol" }],
    results: [{ k: "Q", l: "Charge Q", u: "C", d: 1 }, { k: "Fmol", l: "Charge", u: "F/mol", d: 2 }, { k: "nmax", l: "Theoretical max", u: "mmol", d: 3 }, { k: "fe", l: "Faradaic efficiency", u: "%", d: 1, hero: true, grade: [80, 40] }],
    example: { current_mA: 10, time_hours: 2.68, electrons_z: 2, substrate_mmol: 0.5, product_mmol: 0.38 },
    calc: (d) => {
      const Q = n(d.charge_C) ?? z(d.current_mA) * z(d.time_hours) * 3.6;
      const zz = z(d.electrons_z, 2);
      const nmax = (Q / F / zz) * 1000;
      return { v: { Q, Fmol: n(d.substrate_mmol) ? Q / F / (z(d.substrate_mmol) / 1000) : null, nmax, fe: nmax > 0 && n(d.product_mmol) !== null ? (100 * z(d.product_mmol)) / nmax : null } };
    },
  },
  {
    id: "catalyst_metrics", title: "Catalyst TON / TOF", group: "Organic", icon: "gauge", desc: "Turnover number, frequency and loading.",
    fields: [{ k: "product_mmol", l: "Product", u: "mmol" }, { k: "catalyst_mmol", l: "Catalyst", u: "mmol" }, { k: "substrate_mmol", l: "Substrate", u: "mmol" }, { k: "time_hours", l: "Time", u: "h" }],
    results: [{ k: "loading", l: "Loading", u: "mol%", d: 2 }, { k: "ton", l: "TON", d: 1, hero: true }, { k: "tof", l: "TOF", u: "h⁻¹", d: 2, hero: true }],
    example: { product_mmol: 0.92, catalyst_mmol: 0.005, substrate_mmol: 1, time_hours: 4 },
    calc: (d) => { const ton = n(d.catalyst_mmol) ? z(d.product_mmol) / z(d.catalyst_mmol) : null; return { v: { ton, tof: ton !== null && n(d.time_hours) ? ton / z(d.time_hours) : null, loading: n(d.substrate_mmol) ? (100 * z(d.catalyst_mmol)) / z(d.substrate_mmol) : null } }; },
  },
  {
    id: "titration", title: "Organometallic titration", group: "Organic", icon: "pipette", desc: "Molarity of BuLi, Grignards… from replicate titrations (mean ± RSD).",
    fields: [{ k: "titrant_name", l: "Titrant", t: "text", ph: "n-BuLi" }, { k: "standard_name", l: "Standard", t: "text", ph: "diphenylacetic acid" }, { k: "standard_mw", l: "Standard MW", u: "g/mol" }, { k: "stoichiometry_ratio", l: "Ratio titrant:std" }, { k: "label_molarity", l: "Label", u: "M" }],
    tables: [{ k: "trials", title: "Trials", cols: [{ k: "mass_mg", l: "Std mass", u: "mg" }, { k: "vol_ml", l: "Titrant", u: "mL" }], outs: [{ k: "M", l: "Molarity", u: "M" }] }],
    results: [{ k: "mean", l: "Molarity", u: "M", d: 3, hero: true }, { k: "rsd", l: "RSD", u: "%", d: 1, grade: [2, 5], lowGood: true }, { k: "vsLabel", l: "vs. label", u: "%", d: 0 }],
    example: { titrant_name: "n-BuLi", standard_name: "diphenylacetic acid", standard_mw: 212.24, stoichiometry_ratio: 1, label_molarity: 2.5, trials: [{ mass_mg: 106.1, vol_ml: 0.21 }, { mass_mg: 105.3, vol_ml: 0.205 }] },
    calc: (d) => {
      const r = z(d.stoichiometry_ratio, 1), mw = z(d.standard_mw, 1);
      const trials = rows(d, "trials");
      if (!trials.length && n(d.standard_mass_mg)) trials.push({ mass_mg: d.standard_mass_mg, vol_ml: d.titrant_vol_ml });
      const out = trials.map((t) => ({ M: n(t.mass_mg) && n(t.vol_ml) ? ((z(t.mass_mg) / mw) * r) / z(t.vol_ml) : null }));
      const ms = out.map((o) => o.M).filter((x): x is number => x !== null);
      const mean = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
      const sd = ms.length > 1 && mean ? Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / (ms.length - 1)) : null;
      return { v: { mean, rsd: sd !== null && mean ? (100 * sd) / mean : null, vsLabel: mean && n(d.label_molarity) ? (100 * mean) / z(d.label_molarity) : null }, rows: { trials: out } };
    },
  },
  {
    id: "chromatography", title: "Column planner (ΔCV)", group: "Organic", icon: "columns-3", desc: "Separation difficulty from TLC Rf, column volume and silica amount.",
    fields: [{ k: "rf_product", l: "Rf product" }, { k: "rf_impurity", l: "Rf closest impurity" }, { k: "crude_mass_mg", l: "Crude", u: "mg" }, { k: "column_diameter_cm", l: "Column Ø", u: "cm" }, { k: "silica_height_cm", l: "Silica height", u: "cm" }],
    results: [{ k: "dcv", l: "ΔCV", d: 2, hero: true, grade: [0.4, 0.2] }, { k: "difficulty", l: "Separation", text: true }, { k: "silica_g", l: "Silica (suggested)", u: "g", d: 0 }, { k: "cv", l: "Column volume", u: "mL", d: 0 }, { k: "elute", l: "Product elutes after", u: "mL", d: 0 }],
    example: { rf_product: 0.3, rf_impurity: 0.45, crude_mass_mg: 500, column_diameter_cm: 3, silica_height_cm: 15 },
    calc: (d) => {
      const a = z(d.rf_product), b = z(d.rf_impurity);
      const dcv = a > 0 && b > 0 ? Math.abs(1 / a - 1 / b) : null;
      const diff = dcv === null ? "–" : dcv > 1 ? "Easy" : dcv > 0.4 ? "Good (flash)" : dcv > 0.2 ? "Moderate (shallow gradient)" : "Difficult";
      const ratio = dcv === null ? 50 : dcv > 1 ? 20 : dcv > 0.4 ? 40 : dcv > 0.2 ? 80 : 150;
      const cv = n(d.column_diameter_cm) && n(d.silica_height_cm) ? Math.PI * (z(d.column_diameter_cm) / 2) ** 2 * z(d.silica_height_cm) * 0.65 : null;
      const notes: string[] = [];
      if (a && (a < 0.15 || a > 0.4)) notes.push("Aim for Rf 0.15–0.35 of the product on TLC for a flash column.");
      return { v: { dcv, difficulty: diff, silica_g: n(d.crude_mass_mg) ? (z(d.crude_mass_mg) / 1000) * ratio : null, cv, elute: cv && a ? cv / a : null }, notes };
    },
  },
  {
    id: "green_metrics", title: "Green chemistry metrics", group: "Organic", icon: "leaf", desc: "PMI, E-factor and atom economy.",
    fields: [{ k: "total_reagents_mass_g", l: "Reagents", u: "g" }, { k: "total_solvent_mass_g", l: "Reaction solvents", u: "g" }, { k: "workup_mass_g", l: "Work-up & purification", u: "g" }, { k: "product_mass_g", l: "Product", u: "g" }, { k: "total_reactants_mw", l: "Σ MW reactants", u: "g/mol" }, { k: "target_product_mw", l: "MW product", u: "g/mol" }],
    results: [{ k: "pmi", l: "PMI", d: 1, hero: true, grade: [20, 100], lowGood: true }, { k: "ef", l: "E-factor", d: 1, grade: [5, 50], lowGood: true }, { k: "ae", l: "Atom economy", u: "%", d: 1, grade: [80, 50] }],
    example: { total_reagents_mass_g: 3.2, total_solvent_mass_g: 40, workup_mass_g: 120, product_mass_g: 2.1, total_reactants_mw: 320, target_product_mw: 250 },
    calc: (d) => { const p = z(d.product_mass_g); const tot = z(d.total_reagents_mass_g) + z(d.total_solvent_mass_g) + z(d.workup_mass_g); return { v: { pmi: p ? tot / p : null, ef: p ? (tot - p) / p : null, ae: n(d.total_reactants_mw) ? (100 * z(d.target_product_mw)) / z(d.total_reactants_mw) : null } }; },
  },
  {
    id: "recrystallization", title: "Recrystallisation", group: "Organic", icon: "snowflake", desc: "Recovery and concentration.",
    fields: [{ k: "solvent_name", l: "Solvent", t: "text" }, { k: "crude_mass_mg", l: "Crude", u: "mg" }, { k: "solvent_vol_ml", l: "Solvent", u: "mL" }, { k: "recovered_mass_mg", l: "Recovered", u: "mg" }, { k: "purity_before", l: "Purity before", u: "%" }, { k: "purity_after", l: "Purity after", u: "%" }],
    results: [{ k: "rec", l: "Recovery", u: "%", d: 1, hero: true, grade: [70, 40] }, { k: "conc", l: "Concentration", u: "mg/mL", d: 1 }, { k: "pureRec", l: "Recovery of pure compound", u: "%", d: 1 }],
    example: { solvent_name: "EtOH", crude_mass_mg: 1200, solvent_vol_ml: 15, recovered_mass_mg: 930 },
    calc: (d) => { const c = z(d.crude_mass_mg); return { v: { rec: c ? (100 * z(d.recovered_mass_mg)) / c : null, conc: n(d.solvent_vol_ml) ? c / z(d.solvent_vol_ml) : null, pureRec: n(d.purity_before) && n(d.purity_after) && c ? (100 * z(d.recovered_mass_mg) * z(d.purity_after)) / (c * z(d.purity_before)) : null } }; },
  },
  {
    id: "solution_prep", title: "Solution preparation", group: "Organic", icon: "beaker", desc: "Mass (or volume) to weigh for a target molarity.",
    fields: [{ k: "compound", l: "Compound", t: "text" }, { k: "smiles", l: "SMILES (→ MW)", t: "smiles" }, { k: "mw", l: "MW", u: "g/mol" }, { k: "purity", l: "Purity", u: "%" }, { k: "density", l: "Density (liquids)", u: "g/mL" }, { k: "molarity_M", l: "Target", u: "M" }, { k: "volume_ml", l: "Final volume", u: "mL" }],
    results: [{ k: "mmol", l: "Amount", u: "mmol", d: 3 }, { k: "mass", l: "Weigh", u: "mg", d: 1, hero: true }, { k: "vol", l: "…or measure", u: "µL", d: 0 }],
    example: { compound: "NaOH", mw: 40.0, purity: 98, molarity_M: 1, volume_ml: 100 },
    calc: (d, mw) => { const M = n(d.mw) ?? (d.smiles ? mw(str(d.smiles)) : null); const mmol = z(d.molarity_M) * z(d.volume_ml); const mass = M ? (mmol * M) / (z(d.purity, 100) / 100) : null; return { v: { mmol, mass, vol: mass && n(d.density) ? mass / z(d.density) : null } }; },
  },
  {
    id: "dilution", title: "Dilution (C₁V₁ = C₂V₂)", group: "Organic", icon: "droplets", desc: "Stock volume for a target concentration.",
    fields: [{ k: "stock_conc", l: "Stock C₁" }, { k: "target_conc", l: "Target C₂" }, { k: "target_vol_ml", l: "Final V₂", u: "mL" }, { k: "units", l: "Units", t: "text", ph: "M" }],
    results: [{ k: "v1", l: "Stock", u: "mL", d: 3, hero: true }, { k: "solv", l: "Diluent", u: "mL", d: 3 }, { k: "factor", l: "Dilution factor", d: 1 }],
    example: { stock_conc: 2.5, target_conc: 0.5, target_vol_ml: 10, units: "M" },
    calc: (d) => { const c1 = z(d.stock_conc), c2 = z(d.target_conc), v2 = z(d.target_vol_ml); const v1 = c1 ? (c2 * v2) / c1 : null; return { v: { v1, solv: v1 !== null ? v2 - v1 : null, factor: c2 ? c1 / c2 : null } }; },
  },

  // ------------------------------------------------------------ ANALYTICAL
  {
    id: "calibration", title: "Calibration curve", group: "Analytical", icon: "line-chart", desc: "Linear regression with LOD/LOQ and unknown samples.",
    fields: [{ k: "units", l: "Concentration units", t: "text", ph: "µg/mL" }, { k: "analyte", l: "Analyte", t: "text" }],
    tables: [
      { k: "standards", title: "Standards", cols: [{ k: "name", l: "Name", t: "text" }, { k: "conc", l: "Conc." }, { k: "area", l: "Response" }, { k: "exclude", l: "Exclude", t: "bool" }], outs: [{ k: "res", l: "Residual %" }] },
      { k: "samples", title: "Samples", cols: [{ k: "name", l: "Name", t: "text" }, { k: "dilution_factor", l: "Dilution" }, { k: "area", l: "Response" }], outs: [{ k: "vial", l: "Vial conc." }, { k: "orig", l: "Original conc." }] },
    ],
    results: [{ k: "eq", l: "Equation", text: true }, { k: "r2", l: "R²", d: 4, hero: true, grade: [0.995, 0.98] }, { k: "lod", l: "LOD", d: 3 }, { k: "loq", l: "LOQ", d: 3 }],
    example: { units: "µg/mL", analyte: "product", standards: [{ name: "S1", conc: 5, area: 1020 }, { name: "S2", conc: 10, area: 2050 }, { name: "S3", conc: 25, area: 5110 }, { name: "S4", conc: 50, area: 10190 }], samples: [{ name: "crude", dilution_factor: 10, area: 3300 }] },
    calc: (d) => {
      const st = rows(d, "standards"), sa = rows(d, "samples");
      const pts = st.map((s) => ({ x: z(s.conc), y: z(s.area), off: !!s.exclude })).filter((p, i: number) => n(st[i].conc) !== null && n(st[i].area) !== null);
      const lr = linreg(pts.filter((p) => !p.off));
      const res = st.map((s) => ({ res: lr && n(s.conc) && n(s.area) ? (100 * (z(s.area) - (lr.m * z(s.conc) + lr.b))) / z(s.area) : null }));
      const smp = sa.map((s) => { const vial = lr && lr.m && n(s.area) !== null ? (z(s.area) - lr.b) / lr.m : null; return { vial, orig: vial !== null ? vial * z(s.dilution_factor, 1) : null }; });
      return { v: { eq: lr ? `y = ${lr.m.toPrecision(4)}·x ${lr.b >= 0 ? "+" : "−"} ${Math.abs(lr.b).toPrecision(4)}` : "–", r2: lr?.r2 ?? null, lod: lr && lr.m ? (3.3 * lr.syx) / lr.m : null, loq: lr && lr.m ? (10 * lr.syx) / lr.m : null }, rows: { standards: res, samples: smp }, plot: { kind: "xy", points: pts, line: lr ? { m: lr.m, b: lr.b } : undefined, xl: `conc. (${str(d.units)})`, yl: "response" } };
    },
  },
  {
    id: "standard_addition", title: "Standard addition", group: "Analytical", icon: "trending-up", desc: "Unknown concentration from the x-intercept.",
    fields: [{ k: "units", l: "Units", t: "text", ph: "ppm" }, { k: "dilution_factor", l: "Sample dilution" }],
    tables: [{ k: "standards", title: "Additions", cols: [{ k: "added_conc", l: "Added conc." }, { k: "area", l: "Response" }, { k: "exclude", l: "Exclude", t: "bool" }] }],
    results: [{ k: "eq", l: "Regression", text: true }, { k: "r2", l: "R²", d: 4, grade: [0.995, 0.98] }, { k: "unknown", l: "Unknown conc.", d: 3, hero: true }],
    example: { units: "ppm", dilution_factor: 1, standards: [{ added_conc: 0, area: 210 }, { added_conc: 1, area: 405 }, { added_conc: 2, area: 612 }, { added_conc: 4, area: 1004 }] },
    calc: (d) => {
      const pts = rows(d, "standards").filter((s) => n(s.added_conc) !== null && n(s.area) !== null).map((s) => ({ x: z(s.added_conc), y: z(s.area), off: !!s.exclude }));
      const lr = linreg(pts.filter((p) => !p.off));
      return { v: { eq: lr ? `y = ${lr.m.toPrecision(4)}·x + ${lr.b.toPrecision(4)}` : "–", r2: lr?.r2 ?? null, unknown: lr && lr.m ? Math.abs(lr.b / lr.m) * z(d.dilution_factor, 1) : null }, plot: { kind: "xy", extendX: true, points: pts, line: lr ? { m: lr.m, b: lr.b } : undefined, xl: "added", yl: "response" } };
    },
  },
  {
    id: "serial_dilution", title: "Serial / standard dilutions", group: "Analytical", icon: "flask-round", desc: "Stock and diluent volumes for a set of standards.",
    fields: [{ k: "stock_conc", l: "Stock conc." }, { k: "stock_units", l: "Units", t: "text" }, { k: "diluent", l: "Diluent", t: "text" }],
    tables: [{ k: "targets", title: "Targets", cols: [{ k: "target_conc", l: "Target conc." }, { k: "target_vol", l: "Final vol." }], outs: [{ k: "stock_vol", l: "Stock" }, { k: "diluent_vol", l: "Diluent" }] }],
    results: [{ k: "total", l: "Total stock needed", d: 3, hero: true }],
    example: { stock_conc: 1000, stock_units: "µg/mL", diluent: "MeCN", targets: [{ target_conc: 100, target_vol: 1 }, { target_conc: 50, target_vol: 1 }, { target_conc: 10, target_vol: 1 }] },
    calc: (d) => { const s = z(d.stock_conc); const out = rows(d, "targets").map((t) => { const sv = s ? (z(t.target_conc) * z(t.target_vol)) / s : null; return { stock_vol: sv, diluent_vol: sv !== null ? z(t.target_vol) - sv : null }; }); return { v: { total: out.reduce((a: number, o) => a + (o.stock_vol ?? 0), 0) }, rows: { targets: out } }; },
  },
  {
    id: "acid_base_prep", title: "Acid / base from concentrate", group: "Analytical", icon: "test-tube", desc: "Volume of concentrated reagent for a target molarity.",
    fields: [{ k: "reagent", l: "Reagent", t: "text", ph: "HCl 37%" }, { k: "density", l: "Density", u: "g/mL" }, { k: "mw", l: "MW", u: "g/mol" }, { k: "w_w_percent", l: "Assay", u: "% w/w" }, { k: "target_molarity", l: "Target", u: "M" }, { k: "target_volume_ml", l: "Final volume", u: "mL" }],
    results: [{ k: "stockM", l: "Concentrate", u: "M", d: 2 }, { k: "vol", l: "Dispense", u: "mL", d: 2, hero: true }],
    example: { reagent: "HCl 37%", density: 1.19, mw: 36.46, w_w_percent: 37, target_molarity: 1, target_volume_ml: 250 },
    calc: (d) => { const M = n(d.mw) && n(d.density) && n(d.w_w_percent) ? (z(d.density) * 10 * z(d.w_w_percent)) / z(d.mw) : null; return { v: { stockM: M, vol: M ? (z(d.target_molarity) * z(d.target_volume_ml)) / M : null }, notes: ["Always add acid to water, slowly, with cooling."] }; },
  },
  {
    id: "hplc_method", title: "HPLC / GC method", group: "Analytical", icon: "waves", desc: "Method record with gradient profile.",
    fields: [{ k: "column", l: "Column", t: "text", ph: "C18, 150×4.6 mm, 5 µm" }, { k: "mobile_a", l: "Phase A", t: "text", ph: "H₂O + 0.1% HCOOH" }, { k: "mobile_b", l: "Phase B", t: "text", ph: "MeCN" }, { k: "flow_rate", l: "Flow", u: "mL/min" }, { k: "temp", l: "Temperature", u: "°C" }, { k: "detection", l: "Detection", t: "text", ph: "UV 254 nm" }, { k: "injection_ul", l: "Injection", u: "µL" }],
    tables: [{ k: "gradient", title: "Gradient", cols: [{ k: "time", l: "Time (min)" }, { k: "b_percent", l: "% B (or °C)" }] }],
    results: [{ k: "runtime", l: "Run time", u: "min", d: 1, hero: true }, { k: "solvent", l: "Solvent per run", u: "mL", d: 1 }],
    example: { column: "C18, 150×4.6 mm, 5 µm", mobile_a: "H₂O + 0.1% HCOOH", mobile_b: "MeCN", flow_rate: 1, temp: 30, detection: "UV 254 nm", injection_ul: 5, gradient: [{ time: 0, b_percent: 5 }, { time: 10, b_percent: 95 }, { time: 12, b_percent: 95 }, { time: 12.5, b_percent: 5 }, { time: 15, b_percent: 5 }] },
    calc: (d) => { const g = rows(d, "gradient").filter((r) => n(r.time) !== null); const rt = g.length ? Math.max(...g.map((r) => z(r.time))) : null; return { v: { runtime: rt, solvent: rt !== null && n(d.flow_rate) ? rt * z(d.flow_rate) : null }, plot: g.length > 1 ? { kind: "xy", points: g.map((r) => ({ x: z(r.time), y: z(r.b_percent) })), xl: "time (min)", yl: "% B", step: true } : undefined }; },
  },

  // ------------------------------------------------------------ BIO
  {
    id: "pcr", title: "PCR master mix", group: "Bio", icon: "dna", desc: "Component volumes with overage; water fills up.",
    fields: [{ k: "reactions", l: "Reactions" }, { k: "overage_percent", l: "Overage", u: "%" }, { k: "total_volume_ul", l: "Volume / rxn", u: "µL" }],
    tables: [{ k: "components", title: "Components", cols: [{ k: "name", l: "Component", t: "text" }, { k: "stock", l: "Stock", t: "text" }, { k: "final", l: "Final", t: "text" }, { k: "volume_ul", l: "1× (µL)" }, { k: "add_to_mm_separately", l: "Separate", t: "bool" }], outs: [{ k: "v1", l: "1× µL" }, { k: "mm", l: "Mix µL" }] }],
    results: [{ k: "calcRxns", l: "Mix prepared for", u: "rxn", d: 1, hero: true }, { k: "mmTotal", l: "Master mix total", u: "µL", d: 1 }],
    example: { reactions: 8, overage_percent: 10, total_volume_ul: 25, components: [{ name: "2× Master mix", stock: "2x", final: "1x" }, { name: "Primer F", stock: "10 µM", final: "0.5 µM" }, { name: "Primer R", stock: "10 µM", final: "0.5 µM" }, { name: "Template", volume_ul: 1, add_to_mm_separately: true }, { name: "Water" }] },
    calc: (d) => {
      const comps = rows(d, "components"); const tot = z(d.total_volume_ul, 25); const cr = z(d.reactions, 1) * (1 + z(d.overage_percent, 10) / 100);
      let used = 0, water = -1;
      const out = comps.map((c, i: number) => {
        if (/water|h2o|h₂o/i.test(str(c.name))) { water = i; return { v1: null, mm: null }; }
        let v = n(c.volume_ul);
        if (v === null) { const s = parseFloat(str(c.stock).replace(/[^\d.]/g, "")), f = parseFloat(str(c.final).replace(/[^\d.]/g, "")); v = s > 0 && f >= 0 ? (f / s) * tot : 0; }
        used += v;
        return { v1: v, mm: c.add_to_mm_separately ? null : v * cr };
      });
      if (water >= 0) { const w = Math.max(0, tot - used); out[water] = { v1: w, mm: w * cr }; }
      return { v: { calcRxns: cr, mmTotal: out.reduce((a: number, o) => a + (o.mm ?? 0), 0) }, rows: { components: out }, notes: used > tot ? ["Components exceed the reaction volume!"] : [] };
    },
  },
  {
    id: "buffer", title: "Buffer recipe", group: "Bio", icon: "flask-conical", desc: "Masses for a buffer of given volume.",
    fields: [{ k: "volume_L", l: "Volume", u: "L" }, { k: "ph", l: "Target pH", t: "text" }],
    tables: [{ k: "components", title: "Components", cols: [{ k: "name", l: "Reagent", t: "text" }, { k: "mw", l: "MW" }, { k: "target_M", l: "Conc. (M)" }, { k: "target_mg_ml", l: "…or mg/mL" }], outs: [{ k: "g", l: "Weigh (g)" }] }],
    results: [{ k: "total", l: "Total solids", u: "g", d: 2, hero: true }],
    example: { volume_L: 1, ph: "7.4", components: [{ name: "Tris", mw: 121.14, target_M: 0.05 }, { name: "NaCl", mw: 58.44, target_M: 0.15 }] },
    calc: (d) => { const V = z(d.volume_L, 1); const out = rows(d, "components").map((c) => ({ g: n(c.target_M) && n(c.mw) ? z(c.target_M) * V * z(c.mw) : n(c.target_mg_ml) ? z(c.target_mg_ml) * V : null })); return { v: { total: out.reduce((a: number, o) => a + (o.g ?? 0), 0) }, rows: { components: out } }; },
  },
  {
    id: "cell_seeding", title: "Cell seeding", group: "Bio", icon: "grid-3x3", desc: "Suspension and media volumes.",
    fields: [{ k: "current_cells_per_ml", l: "Cell density", u: "cells/mL" }, { k: "target_cells_per_well", l: "Cells / well" }, { k: "wells", l: "Wells" }, { k: "vol_per_well_ml", l: "Volume / well", u: "mL" }, { k: "overage_percent", l: "Overage", u: "%" }],
    results: [{ k: "susp", l: "Cell suspension", u: "mL", d: 2, hero: true }, { k: "media", l: "Fresh media", u: "mL", d: 2 }, { k: "total", l: "Total", u: "mL", d: 2 }],
    example: { current_cells_per_ml: 1.2e6, target_cells_per_well: 1e4, wells: 96, vol_per_well_ml: 0.1, overage_percent: 10 },
    calc: (d) => { const w = z(d.wells, 1) * (1 + z(d.overage_percent, 10) / 100); const cells = z(d.target_cells_per_well) * w, tot = z(d.vol_per_well_ml, 1) * w; const s = n(d.current_cells_per_ml) ? cells / z(d.current_cells_per_ml) : null; return { v: { susp: s, media: s !== null ? Math.max(0, tot - s) : null, total: tot }, notes: s !== null && s > tot ? ["Cell density too low — concentrate the suspension."] : [] }; },
  },
  {
    id: "ngs_pooling", title: "NGS library pooling", group: "Bio", icon: "layers", desc: "Equimolar pooling volumes.",
    fields: [{ k: "target_fmol_per_sample", l: "Target / sample", u: "fmol" }],
    tables: [{ k: "samples", title: "Libraries", cols: [{ k: "name", l: "Library", t: "text" }, { k: "length_bp", l: "Length (bp)" }, { k: "conc_ng_ul", l: "ng/µL" }], outs: [{ k: "nM", l: "nM" }, { k: "vol", l: "Pool µL" }] }],
    results: [{ k: "total", l: "Pool volume", u: "µL", d: 1, hero: true }],
    example: { target_fmol_per_sample: 100, samples: [{ name: "L1", length_bp: 420, conc_ng_ul: 12.1 }, { name: "L2", length_bp: 390, conc_ng_ul: 8.4 }] },
    calc: (d) => { const t = z(d.target_fmol_per_sample, 100); const out = rows(d, "samples").map((s) => { const nM = n(s.conc_ng_ul) && n(s.length_bp) ? (z(s.conc_ng_ul) * 1e6) / (z(s.length_bp) * 660) : null; return { nM, vol: nM ? t / nM : null }; }); return { v: { total: out.reduce((a: number, o) => a + (o.vol ?? 0), 0) }, rows: { samples: out } }; },
  },
  {
    id: "protein_quant", title: "Protein A280", group: "Bio", icon: "scan", desc: "Concentration from absorbance (Beer–Lambert).",
    fields: [{ k: "path_length_cm", l: "Path length", u: "cm" }],
    tables: [{ k: "samples", title: "Samples", cols: [{ k: "name", l: "Protein", t: "text" }, { k: "A280", l: "A280" }, { k: "ext_coeff", l: "ε (M⁻¹cm⁻¹)" }, { k: "mw", l: "MW (Da)" }, { k: "dilution", l: "Dilution" }], outs: [{ k: "uM", l: "µM" }, { k: "mgml", l: "mg/mL" }] }],
    results: [],
    example: { path_length_cm: 1, samples: [{ name: "BSA", A280: 0.66, ext_coeff: 43824, mw: 66430, dilution: 1 }] },
    calc: (d) => { const l = z(d.path_length_cm, 1); return { v: {}, rows: { samples: rows(d, "samples").map((s) => { const M = n(s.A280) !== null && n(s.ext_coeff) ? (z(s.A280) / (z(s.ext_coeff) * l)) * z(s.dilution, 1) : null; return { uM: M !== null ? M * 1e6 : null, mgml: M !== null && n(s.mw) ? M * z(s.mw) : null }; }) } }; },
  },
  {
    id: "oligo_analyzer", title: "Oligo analyzer", group: "Bio", icon: "dna", desc: "Length, GC, Tm, MW, reverse complement, translation.",
    fields: [{ k: "sequence", l: "Sequence 5'→3'", t: "text" }, { k: "na_mM", l: "Na⁺", u: "mM" }],
    results: [{ k: "len", l: "Length", u: "nt", d: 0 }, { k: "gc", l: "GC", u: "%", d: 1 }, { k: "tm", l: "Tm", u: "°C", d: 1, hero: true }, { k: "mw", l: "MW", u: "g/mol", d: 0 }, { k: "rc", l: "Reverse complement", text: true }, { k: "tr", l: "Translation (frame 1)", text: true }],
    example: { sequence: "ATGGCTAGCAAGGAGGAGCTGTTCACC", na_mM: 50 },
    calc: (d) => {
      const s = str(d.sequence).toUpperCase().replace(/[^ACGTU]/g, "");
      if (!s) return { v: {} };
      const c = (x: string) => (s.match(new RegExp(x, "g")) ?? []).length;
      const g = c("G"), cc = c("C"), a = c("A"), t = c("T") + c("U");
      const na = z(d.na_mM, 50) / 1000;
      const tm = s.length < 14 ? 2 * (a + t) + 4 * (g + cc) : 81.5 + 16.6 * Math.log10(na) + 0.41 * ((100 * (g + cc)) / s.length) - 600 / s.length;
      const comp: Record<string, string> = { A: "T", T: "A", U: "A", G: "C", C: "G" };
      let tr = "";
      const dna = s.replace(/U/g, "T");
      for (let i = 0; i + 2 < dna.length; i += 3) tr += CODONS[dna.slice(i, i + 3)] ?? "?";
      return { v: { len: s.length, gc: (100 * (g + cc)) / s.length, tm, mw: a * 313.21 + t * 304.2 + cc * 289.18 + g * 329.21 - 61.96, rc: s.split("").reverse().map((x) => comp[x] ?? x).join(""), tr } };
    },
  },
  {
    id: "ligation", title: "Ligation insert amount", group: "Bio", icon: "link", desc: "Insert mass for a molar insert:vector ratio.",
    fields: [{ k: "vector_kb", l: "Vector", u: "kb" }, { k: "vector_ng", l: "Vector", u: "ng" }, { k: "insert_kb", l: "Insert", u: "kb" }, { k: "ratio", l: "Insert:vector" }],
    results: [{ k: "ng", l: "Insert needed", u: "ng", d: 1, hero: true }],
    example: { vector_kb: 5.4, vector_ng: 50, insert_kb: 1.2, ratio: 3 },
    calc: (d) => ({ v: { ng: n(d.vector_kb) ? (z(d.insert_kb) / z(d.vector_kb)) * z(d.vector_ng) * z(d.ratio, 3) : null } }),
  },
  {
    id: "protocol", title: "Protocol checklist", group: "Bio", icon: "list-checks", desc: "Tick-off checklist with progress.",
    fields: [],
    tables: [{ k: "steps", title: "Steps", cols: [{ k: "done", l: "✓", t: "bool" }, { k: "text", l: "Step", t: "text" }, { k: "time", l: "Time", t: "text" }] }],
    results: [{ k: "progress", l: "Progress", u: "%", d: 0, hero: true, grade: [100, 50] }],
    example: { steps: [{ text: "Dry glassware" }, { text: "Weigh reagents" }, { text: "Start reaction" }] },
    calc: (d) => { const s = rows(d, "steps"); return { v: { progress: s.length ? (100 * s.filter((x) => x.done === true || x.done === "true").length) / s.length : 0 } }; },
  },

  // ------------------------------------------------------------ POLYMER
  {
    id: "polymerization", title: "Polymerisation (DP / Mn)", group: "Polymer", icon: "link-2", desc: "Monomer : initiator : CTA amounts and theoretical Mn.",
    fields: [{ k: "target_dp", l: "Target DP" }, { k: "target_mass_g", l: "Monomer mass", u: "g" }, { k: "conversion", l: "Expected conversion", u: "%" }, { k: "Mn_gpc", l: "GPC Mn", u: "g/mol" }, { k: "dispersity", l: "Đ (GPC)" }],
    tables: [
      { k: "monomers", title: "Monomers", cols: [{ k: "name", l: "Name", t: "text" }, { k: "smiles", l: "SMILES", t: "smiles" }, { k: "eq", l: "Ratio" }, { k: "mw", l: "MW" }, { k: "density", l: "ρ" }], outs: [{ k: "mmol", l: "mmol" }, { k: "g", l: "g" }, { k: "ml", l: "mL" }] },
      { k: "initiators", title: "Initiators / catalysts", cols: [{ k: "name", l: "Name", t: "text" }, { k: "smiles", l: "SMILES", t: "smiles" }, { k: "ratio_to_cta", l: "eq vs chain" }, { k: "mw", l: "MW" }], outs: [{ k: "mmol", l: "mmol" }, { k: "mg", l: "mg" }] },
      { k: "agents", title: "CTA / RAFT agents", cols: [{ k: "name", l: "Name", t: "text" }, { k: "smiles", l: "SMILES", t: "smiles" }, { k: "mw", l: "MW" }], outs: [{ k: "mmol", l: "mmol" }, { k: "mg", l: "mg" }] },
    ],
    results: [{ k: "chains", l: "Chains", u: "mmol", d: 4 }, { k: "mn", l: "Theoretical Mn", u: "g/mol", d: 0, hero: true }, { k: "mnRatio", l: "GPC / theory", d: 2 }],
    example: { target_dp: 100, target_mass_g: 2, conversion: 90, monomers: [{ name: "MMA", smiles: "C=C(C)C(=O)OC", eq: 1, density: 0.94 }], agents: [{ name: "CPDB", mw: 221.34 }], initiators: [{ name: "AIBN", smiles: "CC(C)(C#N)N=NC(C)(C)C#N", ratio_to_cta: 0.2 }] },
    calc: (d, mw) => {
      const fill = (r: Row) => { const m = n(r.mw) ?? (r.smiles ? mw(str(r.smiles)) : null); return m; };
      const mons = rows(d, "monomers"), ini = rows(d, "initiators"), ag = rows(d, "agents");
      const eqT = mons.reduce((a: number, m) => a + z(m.eq, 1), 0) || 1;
      const avgMw = mons.reduce((a: number, m) => a + (z(m.eq, 1) / eqT) * (fill(m) ?? 0), 0);
      const monMmol = avgMw ? (z(d.target_mass_g) * 1000) / avgMw : 0;
      const chains = z(d.target_dp) ? monMmol / z(d.target_dp) : 0;
      const endMw = ag[0] ? fill(ag[0]) ?? 0 : ini[0] ? fill(ini[0]) ?? 0 : 0;
      const mn = z(d.target_dp) * (z(d.conversion, 100) / 100) * avgMw + endMw;
      return {
        v: { chains, mn: avgMw ? mn : null, mnRatio: n(d.Mn_gpc) && avgMw ? z(d.Mn_gpc) / mn : null },
        rows: {
          monomers: mons.map((m) => { const mm = (monMmol * z(m.eq, 1)) / eqT, M = fill(m); return { mmol: mm, g: M ? (mm * M) / 1000 : null, ml: M && n(m.density) ? (mm * M) / 1000 / z(m.density) : null }; }),
          initiators: ini.map((r) => { const mm = chains * z(r.ratio_to_cta, ag.length ? 0.2 : 1), M = fill(r); return { mmol: mm, mg: M ? mm * M : null }; }),
          agents: ag.map((r) => { const M = fill(r); return { mmol: chains, mg: M ? chains * M : null }; }),
        },
      };
    },
  },
  {
    id: "formulation", title: "Formulation (phr)", group: "Polymer", icon: "pie-chart", desc: "Component masses from parts per hundred resin.",
    fields: [{ k: "target_mass_g", l: "Batch", u: "g" }],
    tables: [{ k: "components", title: "Components", cols: [{ k: "name", l: "Component", t: "text" }, { k: "phr", l: "phr" }, { k: "density", l: "ρ (g/mL)" }], outs: [{ k: "wt", l: "wt %" }, { k: "g", l: "g" }, { k: "ml", l: "mL" }] }],
    results: [{ k: "phr", l: "Σ phr", d: 1 }, { k: "mass", l: "Batch", u: "g", d: 1, hero: true }],
    example: { target_mass_g: 100, components: [{ name: "Epoxy resin", phr: 100, density: 1.16 }, { name: "Hardener", phr: 32, density: 0.95 }, { name: "Filler", phr: 15 }] },
    calc: (d) => { const c = rows(d, "components"); const tot = c.reduce((a: number, x) => a + z(x.phr), 0); const M = z(d.target_mass_g, 100); return { v: { phr: tot, mass: M }, rows: { components: c.map((x) => { const w = tot ? z(x.phr) / tot : 0; return { wt: 100 * w, g: M * w, ml: n(x.density) ? (M * w) / z(x.density) : null }; }) } }; },
  },
];

export const CALC_BY_ID = new Map(CALCS.map((c) => [c.id, c]));
