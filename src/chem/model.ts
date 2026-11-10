// Core document model: atoms, bonds, reaction arrows, plus signs and free text.
// Coordinates are in "bond units" (standard bond length = 1), y axis pointing down.

import { implicitHydrogens, maxValence } from "./elements";

export type BondStereo = 0 | 1 | 4 | 6; // 0 none, 1 wedge (a narrow -> b wide), 6 hash, 4 wavy/either
export type DoublePos = 0 | 1 | -1 | 2; // 0 auto, 1 left, -1 right, 2 centred

export interface Atom {
  id: number;
  el: string; // element symbol, or "*" for a free label / R group
  x: number;
  y: number;
  charge: number;
  isotope?: number;
  /** explicit hydrogen count (from bracket atoms); undefined => compute implicitly */
  hCount?: number;
  radical?: number;
  /** abbreviation / label text shown instead of the element, e.g. "OMe" */
  label?: string;
  /** SMILES fragment the label expands to (first atom attaches) */
  expand?: string;
  /** SMILES chirality from input (@ / @@), with neighbour order; used to place wedges */
  chiral?: { tag: "@" | "@@"; order: number[] };
  map?: number;
}

export interface Bond {
  id: number;
  a: number;
  b: number;
  order: number; // 1,2,3 ; 4 = aromatic (transient, only during parsing)
  stereo: BondStereo;
  dbl?: DoublePos;
  /** E/Z request from SMILES: reference neighbours and whether they are cis */
  ez?: { ra: number; rb: number; cis: boolean };
}

export type ArrowKind = "forward" | "equilibrium" | "retro" | "resonance" | "dashed";
export interface Arrow { id: number; x1: number; y1: number; x2: number; y2: number; kind: ArrowKind }
export interface Plus { id: number; x: number; y: number }
export interface TextItem { id: number; x: number; y: number; text: string }

export interface ChemDoc {
  atoms: Atom[];
  bonds: Bond[];
  arrows: Arrow[];
  pluses: Plus[];
  texts: TextItem[];
  nextId: number;
}

export function emptyDoc(): ChemDoc {
  return { atoms: [], bonds: [], arrows: [], pluses: [], texts: [], nextId: 1 };
}

export function cloneDoc(d: ChemDoc): ChemDoc {
  return JSON.parse(JSON.stringify(d));
}

export function newId(d: ChemDoc): number {
  return d.nextId++;
}

export function addAtom(d: ChemDoc, el: string, x: number, y: number, extra: Partial<Atom> = {}): Atom {
  const a: Atom = { id: newId(d), el, x, y, charge: 0, ...extra };
  d.atoms.push(a);
  return a;
}

export function addBond(d: ChemDoc, a: number, b: number, order = 1, stereo: BondStereo = 0): Bond | null {
  if (a === b) return null;
  const ex = findBond(d, a, b);
  if (ex) return ex;
  const bond: Bond = { id: newId(d), a, b, order, stereo };
  d.bonds.push(bond);
  return bond;
}

export function getAtom(d: ChemDoc, id: number): Atom | undefined {
  return d.atoms.find((a) => a.id === id);
}

export function findBond(d: ChemDoc, a: number, b: number): Bond | undefined {
  return d.bonds.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
}

export function removeAtom(d: ChemDoc, id: number) {
  d.atoms = d.atoms.filter((a) => a.id !== id);
  d.bonds = d.bonds.filter((b) => b.a !== id && b.b !== id);
}

export function removeBond(d: ChemDoc, id: number) {
  d.bonds = d.bonds.filter((b) => b.id !== id);
}

/** Fast lookup structures (rebuild after mutations). */
export interface Graph {
  atomById: Map<number, Atom>;
  index: Map<number, number>;
  adj: Map<number, Array<{ nb: number; bond: Bond }>>;
}

export function buildGraph(d: ChemDoc): Graph {
  const atomById = new Map<number, Atom>();
  const index = new Map<number, number>();
  const adj = new Map<number, Array<{ nb: number; bond: Bond }>>();
  d.atoms.forEach((a, i) => {
    atomById.set(a.id, a);
    index.set(a.id, i);
    adj.set(a.id, []);
  });
  for (const b of d.bonds) {
    if (!adj.has(b.a) || !adj.has(b.b)) continue;
    adj.get(b.a)!.push({ nb: b.b, bond: b });
    adj.get(b.b)!.push({ nb: b.a, bond: b });
  }
  return { atomById, index, adj };
}

export function bondOrderSum(g: Graph, id: number): number {
  let s = 0;
  for (const { bond } of g.adj.get(id) ?? []) s += bond.order === 4 ? 1.5 : bond.order;
  return Math.round(s);
}

export function hydrogenCount(g: Graph, a: Atom): number {
  if (a.hCount !== undefined) return a.hCount;
  if (a.label || a.el === "*") return 0;
  return implicitHydrogens(a.el, a.charge, bondOrderSum(g, a.id), a.radical ?? 0);
}

export function isOverValent(g: Graph, a: Atom): boolean {
  if (a.label || a.el === "*") return false;
  const max = maxValence(a.el, a.charge);
  if (max === null) return false;
  return bondOrderSum(g, a.id) + (a.hCount ?? 0) > max;
}

/** Connected components of atom ids. */
export function components(d: ChemDoc, g = buildGraph(d)): number[][] {
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const a of d.atoms) {
    if (seen.has(a.id)) continue;
    const comp: number[] = [];
    const stack = [a.id];
    seen.add(a.id);
    while (stack.length) {
      const u = stack.pop()!;
      comp.push(u);
      for (const { nb } of g.adj.get(u)!) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    out.push(comp);
  }
  return out;
}

export function docBBox(d: ChemDoc, ids?: Set<number>) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const take = (x: number, y: number) => {
    if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  };
  for (const a of d.atoms) if (!ids || ids.has(a.id)) take(a.x, a.y);
  for (const r of d.arrows) if (!ids || ids.has(r.id)) { take(r.x1, r.y1); take(r.x2, r.y2); }
  for (const p of d.pluses) if (!ids || ids.has(p.id)) take(p.x, p.y);
  for (const t of d.texts) if (!ids || ids.has(t.id)) { take(t.x - 0.3 * t.text.length * 0.5, t.y - 0.4); take(t.x + 0.3 * t.text.length * 0.5, t.y + 0.4); }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function translateDoc(d: ChemDoc, dx: number, dy: number, ids?: Set<number>) {
  for (const a of d.atoms) if (!ids || ids.has(a.id)) { a.x += dx; a.y += dy; }
  for (const r of d.arrows) if (!ids || ids.has(r.id)) { r.x1 += dx; r.y1 += dy; r.x2 += dx; r.y2 += dy; }
  for (const p of d.pluses) if (!ids || ids.has(p.id)) { p.x += dx; p.y += dy; }
  for (const t of d.texts) if (!ids || ids.has(t.id)) { t.x += dx; t.y += dy; }
}

/** Append all objects of src into dst (ids remapped). Returns map old->new. */
export function mergeInto(dst: ChemDoc, src: ChemDoc): Map<number, number> {
  const map = new Map<number, number>();
  for (const a of src.atoms) {
    const n = { ...a, id: newId(dst) };
    if (a.chiral) n.chiral = { tag: a.chiral.tag, order: a.chiral.order.slice() };
    map.set(a.id, n.id);
    dst.atoms.push(n);
  }
  for (const b of src.bonds) {
    const n: Bond = { ...b, id: newId(dst), a: map.get(b.a)!, b: map.get(b.b)! };
    if (b.ez) n.ez = { ra: map.get(b.ez.ra) ?? b.ez.ra, rb: map.get(b.ez.rb) ?? b.ez.rb, cis: b.ez.cis };
    map.set(b.id, n.id);
    dst.bonds.push(n);
  }
  for (const r of src.arrows) { const n = { ...r, id: newId(dst) }; map.set(r.id, n.id); dst.arrows.push(n); }
  for (const p of src.pluses) { const n = { ...p, id: newId(dst) }; map.set(p.id, n.id); dst.pluses.push(n); }
  for (const t of src.texts) { const n = { ...t, id: newId(dst) }; map.set(t.id, n.id); dst.texts.push(n); }
  // remap chirality orders
  for (const a of src.atoms) {
    const na = dst.atoms.find((x) => x.id === map.get(a.id));
    if (na?.chiral) na.chiral.order = na.chiral.order.map((o) => (o < 0 ? o : map.get(o) ?? o));
  }
  return map;
}

export function isEmpty(d: ChemDoc) {
  return !d.atoms.length && !d.arrows.length && !d.texts.length && !d.pluses.length;
}

// ---------- native (lossless) serialisation ----------

export function toNative(d: ChemDoc): string {
  const idx = new Map<number, number>();
  d.atoms.forEach((a, i) => idx.set(a.id, i));
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const out: any = {
    v: 1,
    a: d.atoms.map((a) => {
      const o: any = { e: a.el, x: r(a.x), y: r(a.y) };
      if (a.charge) o.c = a.charge;
      if (a.isotope) o.i = a.isotope;
      if (a.hCount !== undefined) o.h = a.hCount;
      if (a.radical) o.r = a.radical;
      if (a.label) o.l = a.label;
      if (a.expand) o.x2 = a.expand;
      if (a.map) o.m = a.map;
      return o;
    }),
    b: d.bonds.map((b) => {
      const o: any[] = [idx.get(b.a), idx.get(b.b), b.order];
      if (b.stereo || b.dbl) o.push(b.stereo);
      if (b.dbl) o.push(b.dbl);
      return o;
    }),
  };
  if (d.arrows.length) out.ar = d.arrows.map((a) => [r(a.x1), r(a.y1), r(a.x2), r(a.y2), a.kind]);
  if (d.pluses.length) out.p = d.pluses.map((p) => [r(p.x), r(p.y)]);
  if (d.texts.length) out.t = d.texts.map((t) => [r(t.x), r(t.y), t.text]);
  return JSON.stringify(out);
}

export function fromNative(s: string): ChemDoc {
  const o = JSON.parse(s);
  const d = emptyDoc();
  const ids: number[] = [];
  for (const a of o.a ?? []) {
    const at = addAtom(d, a.e, a.x, a.y, { charge: a.c ?? 0 });
    if (a.i) at.isotope = a.i;
    if (a.h !== undefined) at.hCount = a.h;
    if (a.r) at.radical = a.r;
    if (a.l) at.label = a.l;
    if (a.x2) at.expand = a.x2;
    if (a.m) at.map = a.m;
    ids.push(at.id);
  }
  for (const b of o.b ?? []) {
    const bd = addBond(d, ids[b[0]], ids[b[1]], b[2], (b[3] ?? 0) as BondStereo);
    if (bd && b[4]) bd.dbl = b[4];
  }
  for (const a of o.ar ?? []) d.arrows.push({ id: newId(d), x1: a[0], y1: a[1], x2: a[2], y2: a[3], kind: a[4] ?? "forward" });
  for (const p of o.p ?? []) d.pluses.push({ id: newId(d), x: p[0], y: p[1] });
  for (const t of o.t ?? []) d.texts.push({ id: newId(d), x: t[0], y: t[1], text: t[2] });
  return d;
}

/** Remove explicit hydrogens on carbon (plain H, single bond, no stereo/isotope) — for clean previews. */
export function stripCarbonHydrogens(d: ChemDoc): ChemDoc {
  const byId = new Map(d.atoms.map((a) => [a.id, a]));
  const drop = new Set<number>();
  for (const h of d.atoms) {
    if (h.el !== "H" || h.isotope || h.charge || h.label) continue;
    const bs = d.bonds.filter((b) => b.a === h.id || b.b === h.id);
    if (bs.length !== 1 || bs[0].order !== 1 || bs[0].stereo) continue;
    const other = byId.get(bs[0].a === h.id ? bs[0].b : bs[0].a);
    if (other && other.el === "C") drop.add(h.id);
  }
  if (!drop.size) return d;
  d.atoms = d.atoms.filter((a) => !drop.has(a.id));
  d.bonds = d.bonds.filter((b) => !drop.has(b.a) && !drop.has(b.b));
  return d;
}
