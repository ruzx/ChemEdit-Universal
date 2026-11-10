// ELN stoichiometry (compatible with ChemEdit 1.x ```eln YAML: reactants/products, mass in mg, volume in mL).

import { parseAny } from "./index";
import { analyse } from "./analysis";
import { computeProperties } from "./props";
import { str } from "./util";

export type Role = "reactant" | "reagent" | "catalyst" | "solvent";

export interface ElnCompound {
  name?: string; smiles?: string; role?: Role;
  eq?: number; mmol?: number; mass?: number; volume?: number; molarity?: number; density?: number; purity?: number; mw?: number;
  is_limiting?: boolean; cas?: string; lot?: string;
  // products
  mass_isolated?: number; mmol_isolated?: number; yield?: number | string;
  [k: string]: unknown;
}

export interface ElnData {
  code?: string; title?: string; project?: string; status?: string; date?: string;
  solvent?: string; temperature?: string; duration?: string; atmosphere?: string; conditions?: string;
  scale_mmol?: number;
  reactants?: ElnCompound[]; products?: ElnCompound[];
  [k: string]: unknown;
}

export interface CalcRow {
  src: ElnCompound; index: number; role: Role; mw: number | null; formula: string;
  eq: number | null; mmol: number | null; mass: number | null; volume: number | null; limiting: boolean;
}
export interface CalcProduct {
  src: ElnCompound; index: number; mw: number | null; formula: string; exact: number | null;
  theoryMmol: number | null; theoryMass: number | null; isoMass: number | null; isoMmol: number | null; yieldPct: number | null;
}
export interface ElnCalc {
  rows: CalcRow[]; products: CalcProduct[]; refMmol: number | null;
  concentration: number | null; atomEconomy: number | null; warnings: string[];
}

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(str(v).replace(",", "."));
  return isFinite(n) ? n : null;
};

function props(smiles?: string) {
  if (!smiles || !String(smiles).trim()) return null;
  try { return computeProperties(parseAny(String(smiles)), "all"); } catch { return null; }
}

export function calculateEln(d: ElnData): ElnCalc {
  const reactants = d.reactants ?? [];
  const products = d.products ?? [];
  const warnings: string[] = [];
  const rows: CalcRow[] = reactants.map((r, index) => {
    const p = props(r.smiles);
    const mw = num(r.mw) ?? p?.mw ?? null;
    return { src: r, index, role: r.role ?? "reactant", mw, formula: p?.formula ?? "", eq: null, mmol: null, mass: null, volume: null, limiting: false };
  });
  const stoich = rows.filter((r) => r.role !== "solvent");
  let lim = stoich.find((r) => r.src.is_limiting) ?? stoich.find((r) => num(r.src.eq) === 1) ?? stoich[0];
  if (lim) lim.limiting = true;
  let ref: number | null = null;
  if (lim) {
    const s = lim.src, eq = num(s.eq) ?? 1;
    const purity = (num(s.purity) ?? 100) / 100;
    if (num(s.mmol)) ref = num(s.mmol)! / eq;
    else if (num(s.mass) && lim.mw) ref = (num(s.mass)! * purity) / lim.mw / eq;
    else if (num(s.volume) && num(s.molarity)) ref = (num(s.volume)! * num(s.molarity)!) / eq;
    else if (num(s.volume) && num(s.density) && lim.mw) ref = (num(s.volume)! * num(s.density)! * 1000 * purity) / lim.mw / eq;
    else if (num(d.scale_mmol)) ref = num(d.scale_mmol)! / eq;
    if (ref === null) warnings.push("Enter a mass, volume or mmol for the limiting reagent (or scale_mmol) to calculate amounts.");
    if (!lim.mw && lim.src.smiles === undefined) warnings.push(`No structure / MW for ${lim.src.name ?? "the limiting reagent"}.`);
  }
  for (const r of stoich) {
    const s = r.src;
    r.eq = num(s.eq) ?? 1;
    if (ref === null) continue;
    r.mmol = ref * r.eq;
    const purity = (num(s.purity) ?? 100) / 100;
    if (num(s.molarity)) {
      r.volume = r.mmol / num(s.molarity)!;
      if (r.mw) r.mass = r.mmol * r.mw;
    } else if (r.mw) {
      r.mass = (r.mmol * r.mw) / purity;
      if (num(s.density)) r.volume = r.mass / 1000 / num(s.density)!;
    }
  }
  // solvents: volume as entered
  let solventVol = 0;
  for (const r of rows.filter((x) => x.role === "solvent")) { r.volume = num(r.src.volume); if (r.volume) solventVol += r.volume; }
  const concentration = ref !== null && solventVol > 0 ? ref / solventVol : null;

  const prods: CalcProduct[] = products.map((p, index) => {
    const an = (() => { try { return p.smiles ? analyse(parseAny(String(p.smiles))) : null; } catch { return null; } })();
    const mw = num(p.mw) ?? an?.mw ?? null;
    const eq = num(p.eq) ?? 1;
    const theoryMmol = ref !== null ? ref * eq : null;
    const theoryMass = theoryMmol !== null && mw ? theoryMmol * mw : null;
    const purity = (num(p.purity) ?? 100) / 100;
    let isoMass = num(p.mass_isolated), isoMmol = num(p.mmol_isolated);
    if (isoMass !== null && isoMmol === null && mw) isoMmol = (isoMass * purity) / mw;
    if (isoMmol !== null && isoMass === null && mw) isoMass = isoMmol * mw;
    const yieldPct = isoMmol !== null && theoryMmol ? (isoMmol / theoryMmol) * 100 : num(p.yield);
    return { src: p, index, mw, formula: an?.formula ?? "", exact: an?.exact ?? null, theoryMmol, theoryMass, isoMass, isoMmol, yieldPct };
  });
  // atom economy: main product vs stoichiometric reactants (role reactant)
  let atomEconomy: number | null = null;
  // stoichiometric coefficients assumed 1 (excess equivalents do not count)
  const reactMw = rows.filter((r) => r.role === "reactant" && r.mw).reduce((s, r) => s + r.mw!, 0);
  if (prods[0]?.mw && reactMw > 0) atomEconomy = (100 * prods[0].mw) / reactMw;
  return { rows, products: prods, refMmol: ref, concentration, atomEconomy, warnings };
}

/** Format mass in mg with sensible units. */
export function fmtMass(mg: number | null): string {
  if (mg === null || !isFinite(mg)) return "–";
  if (mg >= 1000) return (mg / 1000).toFixed(mg >= 10000 ? 1 : 2) + " g";
  if (mg >= 10) return mg.toFixed(1) + " mg";
  if (mg >= 0.1) return mg.toFixed(2) + " mg";
  return (mg * 1000).toFixed(1) + " µg";
}
export function fmtVol(ml: number | null): string {
  if (ml === null || !isFinite(ml)) return "–";
  if (ml >= 1000) return (ml / 1000).toFixed(2) + " L";
  if (ml >= 1) return ml.toFixed(2) + " mL";
  return (ml * 1000).toFixed(ml * 1000 >= 10 ? 0 : 1) + " µL";
}
export function fmtMmol(mmol: number | null): string {
  if (mmol === null || !isFinite(mmol)) return "–";
  if (mmol >= 1000) return (mmol / 1000).toFixed(2) + " mol";
  if (mmol >= 1) return mmol.toFixed(2) + " mmol";
  return (mmol * 1000).toFixed(mmol * 1000 >= 10 ? 0 : 1) + " µmol";
}
export function fmtEq(r: CalcRow): string {
  if (r.eq === null) return "–";
  if (r.role === "catalyst" && r.eq < 1) return +(r.eq * 100).toFixed(1) + " mol%";
  return +r.eq.toFixed(3) + "";
}

/** "HRMS (ESI) m/z: [M+H]+ calcd for C9H9O4 181.0495; found ____." */
export function characterizationTemplate(smiles: string): string {
  try {
    const an = analyse(parseAny(smiles));
    if (!an) return "";
    const mh = an.adducts.find((a) => a.ion.startsWith("[M+H]"));
    const plusH = (f: string) => {
      const m = /H(\d*)/.exec(f);
      if (!m) return f.replace(/^(C\d*)/, "$1H");
      const n = (m[1] ? parseInt(m[1]) : 1) + 1;
      return f.replace(/H\d*/, "H" + n);
    };
    const ea = an.ea.filter((x) => ["C", "H", "N", "S"].includes(x.el)).map((x) => `${x.el}, ${x.pct.toFixed(2)}`).join("; ");
    return [
      `**¹H NMR** (400 MHz, CDCl₃) δ `,
      `**¹³C NMR** (101 MHz, CDCl₃) δ `,
      mh ? `**HRMS** (ESI) m/z: [M+H]⁺ calcd for ${plusH(an.formula)} ${mh.mz.toFixed(4)}; found ` : "",
      `**Anal.** calcd for ${an.formula}: ${ea}. Found: `,
      `**IR** (ATR) ν = cm⁻¹`,
      `**m.p.** °C`,
    ].filter(Boolean).map((l) => "- " + l).join("\n");
  } catch { return ""; }
}
