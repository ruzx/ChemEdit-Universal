// Chemist's "Analysis" panel data: formula, masses, m/z adducts, elemental analysis, DBE, Lipinski-type counts.

import { avgMass, monoMass } from "./elements";
import { ChemDoc, buildGraph, components, hydrogenCount, Graph } from "./model";
import { expandAbbreviations } from "./abbrev";
import { findRings } from "./rings";
import { ecRanks } from "./stereo";

const PROTON = 1.00727646688, ELECTRON = 0.000548579909;

export interface Analysis {
  formula: string; formulaHtml: string; mw: number; exact: number; charge: number;
  mz: number | null; adducts: Array<{ ion: string; mz: number }>;
  ea: Array<{ el: string; pct: number }>;
  dbe: number | null; heavy: number; rings: number; hbd: number; hba: number; rotb: number;
  stereo: number; stereoDefined: number; fragments: number;
}

export function analyse(src: ChemDoc, atomIds?: Set<number>): Analysis | null {
  // restrict to selection (whole fragments touched by it), then expand labels
  let doc = src;
  if (atomIds && atomIds.size) {
    const g0 = buildGraph(src);
    const comps = components(src, g0).filter((c) => c.some((id) => atomIds.has(id)));
    const keep = new Set(comps.flat());
    doc = { ...src, atoms: src.atoms.filter((a) => keep.has(a.id)), bonds: src.bonds.filter((b) => keep.has(b.a) && keep.has(b.b)), arrows: [], pluses: [], texts: [] };
  }
  doc = expandAbbreviations(doc);
  if (!doc.atoms.length) return null;
  const g = buildGraph(doc);
  const counts = new Map<string, number>();
  let mw = 0, exact = 0, charge = 0;
  for (const a of doc.atoms) {
    if (a.el === "*") continue;
    const h = hydrogenCount(g, a);
    counts.set(a.el, (counts.get(a.el) ?? 0) + 1);
    if (h) counts.set("H", (counts.get("H") ?? 0) + h);
    mw += avgMass(a.el, a.isotope) + h * avgMass("H");
    exact += monoMass(a.el, a.isotope) + h * monoMass("H");
    charge += a.charge;
  }
  const keys = [...counts.keys()].sort((x, y) => {
    const r = (e: string) => (counts.has("C") ? (e === "C" ? 0 : e === "H" ? 1 : 2) : 2);
    return r(x) - r(y) || x.localeCompare(y);
  });
  let formula = "", formulaHtml = "";
  for (const k of keys) { const n = counts.get(k)!; formula += k + (n > 1 ? n : ""); formulaHtml += k + (n > 1 ? `<sub>${n}</sub>` : ""); }
  if (charge) { const c = (Math.abs(charge) > 1 ? Math.abs(charge) : "") + (charge > 0 ? "+" : "−"); formula += c.replace("−", "-"); formulaHtml += `<sup>${c}</sup>`; }
  const neutral = exact - charge * 0; // exact of the drawn species (ions: subtract electrons below)
  const mz = charge ? (exact - charge * ELECTRON) / Math.abs(charge) : null;
  const adducts: Array<{ ion: string; mz: number }> = [];
  if (!charge) {
    adducts.push({ ion: "[M+H]⁺", mz: neutral + PROTON });
    adducts.push({ ion: "[M+Na]⁺", mz: neutral + 22.98976928 - ELECTRON });
    adducts.push({ ion: "[M+K]⁺", mz: neutral + 38.96370649 - ELECTRON });
    adducts.push({ ion: "[M+NH₄]⁺", mz: neutral + 18.03382555 });
    adducts.push({ ion: "[M−H]⁻", mz: neutral - PROTON });
    adducts.push({ ion: "[M+HCOO]⁻", mz: neutral + 44.99820285 + ELECTRON });
    adducts.push({ ion: "[2M+H]⁺", mz: 2 * neutral + PROTON });
  }
  const ea = keys.map((el) => ({ el, pct: (100 * counts.get(el)! * avgMass(el)) / mw }));
  // DBE (C, Si count as tetravalent; N, P trivalent; halogens monovalent)
  const C = (counts.get("C") ?? 0) + (counts.get("Si") ?? 0);
  const H = counts.get("H") ?? 0;
  const N = (counts.get("N") ?? 0) + (counts.get("P") ?? 0);
  const X = ["F", "Cl", "Br", "I"].reduce((s, e) => s + (counts.get(e) ?? 0), 0);
  const known = new Set(["C", "H", "N", "O", "S", "P", "Si", "F", "Cl", "Br", "I", "Se"]);
  const dbe = [...counts.keys()].every((e) => known.has(e)) ? C - (H + X) / 2 + N / 2 + 1 : null;
  const ri = findRings(doc, g);
  let hbd = 0, hba = 0, rotb = 0;
  for (const a of doc.atoms) {
    if (a.el === "N" || a.el === "O") { hba++; if (hydrogenCount(g, a) > 0) hbd++; }
  }
  for (const b of doc.bonds) {
    if (b.order !== 1 || ri.ringBonds.has(b.id)) continue;
    const da = heavyDeg(g, b.a), db = heavyDeg(g, b.b);
    if (da < 2 || db < 2) continue;
    if (g.adj.get(b.a)!.some((x) => x.bond.order === 3) || g.adj.get(b.b)!.some((x) => x.bond.order === 3)) continue;
    rotb++;
  }
  const { stereo, defined } = countStereo(doc, g);
  return {
    formula, formulaHtml, mw, exact, charge, mz, adducts, ea, dbe, heavy: doc.atoms.filter((a) => a.el !== "H").length,
    rings: ri.rings.length, hbd, hba, rotb, stereo, stereoDefined: defined, fragments: components(doc, g).length,
  };
}

function heavyDeg(g: Graph, id: number) { return g.adj.get(id)!.filter(({ nb }) => g.atomById.get(nb)!.el !== "H").length; }

function countStereo(doc: ChemDoc, g: Graph) {
  const ranks = ecRanks(doc, g, 6);
  let stereo = 0, defined = 0;
  for (const a of doc.atoms) {
    if (!["C", "Si", "N", "P", "S"].includes(a.el)) continue;
    const nbs = g.adj.get(a.id)!;
    if (nbs.some((x) => x.bond.order !== 1)) continue;
    const h = hydrogenCount(g, a);
    if (nbs.length + h !== 4 || h > 1) continue;
    if (a.el === "N" && a.charge <= 0) continue;
    const r = nbs.map((x) => ranks.get(x.nb));
    if (new Set(r).size !== r.length) continue;
    stereo++;
    if (nbs.some((x) => x.bond.a === a.id && (x.bond.stereo === 1 || x.bond.stereo === 6))) defined++;
  }
  return { stereo, defined };
}
