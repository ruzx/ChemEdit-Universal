// Molecular formula, weights, substructure search.

import { avgMass, monoMass } from "./elements";
import { ChemDoc, Graph, buildGraph, components, hydrogenCount } from "./model";
import { expandAbbreviations } from "./abbrev";
import { findRings, perceiveAromaticity } from "./rings";
import { reactionRoles } from "./smiles";

export interface MolProps {
  formula: string;
  formulaHtml: string;
  mw: number;
  exactMass: number;
  atomCount: number;
  charge: number;
}

function hill(counts: Map<string, number>, charge: number) {
  const keys = [...counts.keys()];
  const hasC = counts.has("C");
  keys.sort((a, b) => {
    if (hasC) {
      const pa = a === "C" ? 0 : a === "H" ? 1 : 2, pb = b === "C" ? 0 : b === "H" ? 1 : 2;
      if (pa !== pb) return pa - pb;
    }
    return a.localeCompare(b);
  });
  let txt = "", html = "";
  for (const k of keys) {
    const n = counts.get(k)!;
    if (!n) continue;
    txt += k + (n > 1 ? n : "");
    html += k + (n > 1 ? `<sub>${n}</sub>` : "");
  }
  if (charge) {
    const c = (Math.abs(charge) > 1 ? Math.abs(charge) : "") + (charge > 0 ? "+" : "−");
    txt += (Math.abs(charge) > 1 ? Math.abs(charge) : "") + (charge > 0 ? "+" : "-");
    html += `<sup>${c}</sup>`;
  }
  return { txt, html };
}

function propsFor(doc: ChemDoc, g: Graph, ids: number[]): MolProps {
  const counts = new Map<string, number>();
  let mw = 0, ex = 0, charge = 0;
  for (const id of ids) {
    const a = g.atomById.get(id)!;
    if (a.el === "*") continue;
    const h = hydrogenCount(g, a);
    counts.set(a.el, (counts.get(a.el) ?? 0) + 1);
    if (h) counts.set("H", (counts.get("H") ?? 0) + h);
    mw += avgMass(a.el, a.isotope) + h * avgMass("H");
    ex += monoMass(a.el, a.isotope) + h * monoMass("H");
    charge += a.charge;
  }
  const electron = 0.000548579909;
  ex -= charge * electron;
  const f = hill(counts, charge);
  return { formula: f.txt, formulaHtml: f.html, mw, exactMass: ex, atomCount: ids.length, charge };
}

/** Properties of the whole document (all fragments), or of the products for a reaction. */
export function computeProperties(src: ChemDoc, which: "all" | "products" | "reactants" = "all"): MolProps | null {
  const doc = expandAbbreviations(src);
  if (!doc.atoms.length) return null;
  const g = buildGraph(doc);
  let ids = doc.atoms.map((a) => a.id);
  if (which !== "all" && doc.arrows.length) {
    const comps = components(doc, g);
    const roles = reactionRoles(doc, comps);
    if (roles) {
      const want = which === "products" ? "p" : "r";
      const sel = comps.filter((_, i) => roles[i] === want).flat();
      if (sel.length) ids = sel;
    }
  }
  return propsFor(doc, g, ids);
}

export function fragmentProperties(src: ChemDoc): MolProps[] {
  const doc = expandAbbreviations(src);
  const g = buildGraph(doc);
  return components(doc, g).map((c) => propsFor(doc, g, c));
}

// ------------------------------------------------------------ substructure

/** True if `query` is a substructure of `target` (elements, bond orders, aromaticity). */
export function substructureMatch(target: ChemDoc, query: ChemDoc): boolean {
  const T = expandAbbreviations(target), Q = expandAbbreviations(query);
  if (!Q.atoms.length) return false;
  if (Q.atoms.length > T.atoms.length) return false;
  const tg = buildGraph(T), qg = buildGraph(Q);
  const ta = perceiveAromaticity(T, tg, findRings(T, tg));
  const qa = perceiveAromaticity(Q, qg, findRings(Q, qg));
  const bondKind = (arom: Set<number>, id: number, order: number) => (arom.has(id) ? 4 : order);
  const qAtoms = Q.atoms.map((a) => a.id);
  // order query atoms by BFS for connectivity-driven search
  const orderQ: number[] = [];
  const seen = new Set<number>();
  for (const s of qAtoms) {
    if (seen.has(s)) continue;
    const qq = [s]; seen.add(s);
    for (let i = 0; i < qq.length; i++) { orderQ.push(qq[i]); for (const { nb } of qg.adj.get(qq[i])!) if (!seen.has(nb)) { seen.add(nb); qq.push(nb); } }
  }
  const map = new Map<number, number>();
  const used = new Set<number>();
  const atomOk = (q: number, t: number) => {
    const A = qg.atomById.get(q)!, B = tg.atomById.get(t)!;
    if (A.el !== "*" && A.el !== B.el) return false;
    if (A.charge && A.charge !== B.charge) return false;
    if (qg.adj.get(q)!.length > tg.adj.get(t)!.length) return false;
    return true;
  };
  let steps = 0;
  const rec = (k: number): boolean => {
    if (k === orderQ.length) return true;
    if (++steps > 500000) return false;
    const q = orderQ[k];
    // candidate targets: neighbours of an already-mapped query neighbour
    const mappedNb = qg.adj.get(q)!.find(({ nb }) => map.has(nb));
    const cands = mappedNb ? tg.adj.get(map.get(mappedNb.nb)!)!.map((x) => x.nb) : T.atoms.map((a) => a.id);
    for (const t of cands) {
      if (used.has(t) || !atomOk(q, t)) continue;
      let ok = true;
      for (const { nb, bond } of qg.adj.get(q)!) {
        if (!map.has(nb)) continue;
        const tb = tg.adj.get(t)!.find((x) => x.nb === map.get(nb));
        if (!tb) { ok = false; break; }
        const qk = bondKind(qa.aromBonds, bond.id, bond.order), tk = bondKind(ta.aromBonds, tb.bond.id, tb.bond.order);
        if (qk !== tk) { ok = false; break; }
      }
      if (!ok) continue;
      map.set(q, t); used.add(t);
      if (rec(k + 1)) return true;
      map.delete(q); used.delete(t);
    }
    return false;
  };
  return rec(0);
}
