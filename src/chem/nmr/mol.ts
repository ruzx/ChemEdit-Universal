// Minimal molecular graph for NMR prediction (rings, aromaticity, topological symmetry).
// Built from a ChemDoc; explicit H atoms are folded into their heavy atom.
// Perception code ported from ChemSpec (same author, MIT).

import type { ChemDoc } from "../model";
import { buildGraph, hydrogenCount } from "../model";
import { expandAbbreviations } from "../abbrev";

export interface MAtom { el: string; charge: number; h: number; arom: boolean; x: number; y: number; ring: boolean; id: number }
export interface MBond { a: number; b: number; order: number; arom: boolean; ring: boolean }
export interface Mol {
  atoms: MAtom[]; bonds: MBond[];
  adj: { n: number; b: number }[][];
  rings: number[][];
  sym: number[];
}

export function bondBetween(m: Mol, a: number, b: number) { const e = m.adj[a].find((q) => q.n === b); return e ? e.b : -1; }

/** ChemDoc → Mol (largest molecule only if `largest`; reaction arrows are ignored). */
export function molFromDoc(src: ChemDoc): Mol {
  const d = src.atoms.some((a) => a.label || a.expand) ? expandAbbreviations(src) : src;
  const g = buildGraph(d);
  const heavy = d.atoms.filter((a) => a.el !== "H" || !(g.adj.get(a.id) ?? []).length);
  const idx = new Map<number, number>();
  const atoms: MAtom[] = heavy.map((a, i) => { idx.set(a.id, i); return { el: a.el === "*" ? "C" : a.el, charge: a.charge ?? 0, h: hydrogenCount(g, a), arom: false, x: a.x, y: a.y, ring: false, id: a.id }; });
  const bonds: MBond[] = [];
  for (const b of d.bonds) {
    const ia = idx.get(b.a), ib = idx.get(b.b);
    if (ia === undefined && ib !== undefined) { atoms[ib].h++; continue; }
    if (ib === undefined && ia !== undefined) { atoms[ia].h++; continue; }
    if (ia === undefined || ib === undefined) continue;
    bonds.push({ a: ia, b: ib, order: b.order === 4 ? 1 : b.order, arom: b.order === 4, ring: false });
  }
  const adj = atoms.map(() => [] as { n: number; b: number }[]);
  bonds.forEach((b, k) => { adj[b.a].push({ n: b.b, b: k }); adj[b.b].push({ n: b.a, b: k }); });
  const mol: Mol = { atoms, bonds, adj, rings: [], sym: [] };
  mol.rings = findRings(mol);
  for (const r of mol.rings) for (let k = 0; k < r.length; k++) {
    atoms[r[k]].ring = true;
    const bi = bondBetween(mol, r[k], r[(k + 1) % r.length]); if (bi >= 0) bonds[bi].ring = true;
  }
  perceiveAromaticity(mol);
  mol.sym = symmetryClasses(mol);
  return mol;
}

function findRings(m: Mol): number[][] {
  const rings: number[][] = []; const seen = new Set<string>();
  m.bonds.forEach((bd, bi) => {
    const prev = new Map<number, number>([[bd.a, -1]]); const q = [bd.a];
    while (q.length) {
      const u = q.shift() as number; if (u === bd.b) break;
      for (const e of m.adj[u]) { if (e.b === bi || prev.has(e.n)) continue; prev.set(e.n, u); q.push(e.n); }
    }
    if (!prev.has(bd.b)) return;
    const path: number[] = []; let c = bd.b; while (c !== -1) { path.push(c); c = prev.get(c) as number; }
    if (path.length > 8) return;
    const key = [...path].sort((x, y) => x - y).join(",");
    if (!seen.has(key)) { seen.add(key); rings.push(path); }
  });
  return rings.sort((a, b) => a.length - b.length);
}

function perceiveAromaticity(m: Mol) {
  const A = m.atoms, B = m.bonds;
  const ringBonds = (r: number[]) => r.map((x, k) => bondBetween(m, x, r[(k + 1) % r.length]));
  const isAr = new Set<number>();
  for (let pass = 0; pass < 3; pass++) for (const r of m.rings) {
    const rb = ringBonds(r); if (rb.some((b) => b < 0)) continue;
    if (rb.every((b) => B[b].arom)) { r.forEach((x) => isAr.add(x)); continue; }
    if (r.length === 6) {
      const ok = r.every((x) => (A[x].el === "C" || A[x].el === "N") && (isAr.has(x) || m.adj[x].some((e) => B[e.b].order === 2 && r.includes(e.n))));
      if (ok) { r.forEach((x) => isAr.add(x)); rb.forEach((b) => { B[b].arom = true; }); }
    } else if (r.length === 5) {
      const dbl = rb.filter((b) => B[b].order === 2 || B[b].arom).length;
      const het = r.filter((x) => ["N", "O", "S"].includes(A[x].el) && !m.adj[x].some((e) => B[e.b].order === 2));
      if (dbl >= 2 && het.length >= 1) { r.forEach((x) => isAr.add(x)); rb.forEach((b) => { B[b].arom = true; }); }
    }
  }
  isAr.forEach((x) => { A[x].arom = true; });
}

function symmetryClasses(m: Mol): number[] {
  let cls = m.atoms.map((a, k) => `${a.el}|${a.charge}|${a.h}|${a.arom ? 1 : 0}|${m.adj[k].length}|${a.ring ? 1 : 0}`);
  let nCls = new Set(cls).size;
  for (let it = 0; it < m.atoms.length; it++) {
    const next = cls.map((c, k) => c + "[" + m.adj[k].map((e) => `${m.bonds[e.b].arom ? 4 : m.bonds[e.b].order}${cls[e.n]}`).sort().join(",") + "]");
    const uniq = [...new Set(next)].sort(); const relabel = new Map(uniq.map((u, i) => [u, String(i)]));
    const nc = next.map((x) => relabel.get(x) as string);
    const n2 = new Set(nc).size; cls = nc;
    if (n2 === nCls) break; nCls = n2;
  }
  const ids = [...new Set(cls)];
  return cls.map((c) => ids.indexOf(c));
}
