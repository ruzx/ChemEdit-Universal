// Stereo geometry helpers: tetrahedral parity from 2D + wedges, cis/trans from 2D.

import { Atom, ChemDoc, Graph } from "./model";
import { RingInfo } from "./rings";

/** z-offset of neighbour nb as seen from centre c (+1 wedge towards viewer, -1 hash). */
export function wedgeZ(g: Graph, c: number, nb: number): number {
  for (const { nb: n, bond } of g.adj.get(c)!) {
    if (n !== nb) continue;
    if (bond.a !== c) return 0;
    if (bond.stereo === 1) return 1;
    if (bond.stereo === 6) return -1;
  }
  return 0;
}

/**
 * Tetrahedral tag for `centre` with SMILES neighbour order `order` (-1 = implicit H).
 * Returns "@" / "@@" or null when not determinable from the drawing.
 */
export function parityFromDrawing(g: Graph, centre: Atom, order: number[]): "@" | "@@" | null {
  if (order.length < 3 || order.length > 4) return null;
  const vecs: Array<[number, number, number] | null> = [];
  let anyZ = false;
  for (const id of order) {
    if (id < 0) { vecs.push(null); continue; }
    const a = g.atomById.get(id)!;
    let dx = a.x - centre.x, dy = -(a.y - centre.y);
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    const z = wedgeZ(g, centre.id, id);
    if (z) anyZ = true;
    vecs.push([dx, dy, z * 0.9]);
  }
  if (!anyZ) return null;
  // implicit H or lone pair: opposite of the sum of the others
  const fill = () => {
    let sx = 0, sy = 0, sz = 0;
    for (const v of vecs) if (v) { sx += v[0]; sy += v[1]; sz += v[2]; }
    const L = Math.hypot(sx, sy, sz) || 1;
    return [-sx / L, -sy / L, -sz / L] as [number, number, number];
  };
  const full = vecs.map((v) => v ?? fill());
  if (full.length === 3) full.push(fill()); // 3 neighbours, no H listed: treat 4th as lone pair
  const [n0, n1, n2, n3] = full;
  const a = [n1[0] - n0[0], n1[1] - n0[1], n1[2] - n0[2]];
  const b = [n2[0] - n0[0], n2[1] - n0[1], n2[2] - n0[2]];
  const c = [n3[0] - n0[0], n3[1] - n0[1], n3[2] - n0[2]];
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (Math.abs(det) < 1e-6) return null;
  return det < 0 ? "@" : "@@";
}

/** true if atoms p and q lie on the same side of line u-v. */
export function sameSide(g: Graph, u: number, v: number, p: number, q: number): boolean {
  const U = g.atomById.get(u)!, V = g.atomById.get(v)!, P = g.atomById.get(p)!, Q = g.atomById.get(q)!;
  const dx = V.x - U.x, dy = V.y - U.y;
  const s1 = dx * (P.y - U.y) - dy * (P.x - U.x);
  const s2 = dx * (Q.y - U.y) - dy * (Q.x - U.x);
  return s1 * s2 > 0;
}

/** Simple extended-connectivity ranks for symmetry checks. */
export function ecRanks(d: ChemDoc, g: Graph, iterations = 4): Map<number, number> {
  let rank = new Map<number, number>();
  for (const a of d.atoms) {
    const deg = g.adj.get(a.id)!.length;
    rank.set(a.id, (a.el.charCodeAt(0) * 31 + (a.el.charCodeAt(1) || 0)) * 100 + deg * 10 + (a.charge + 5));
  }
  for (let it = 0; it < iterations; it++) {
    const next = new Map<number, number>();
    for (const a of d.atoms) {
      const nbs = g.adj.get(a.id)!.map(({ nb, bond }) => rank.get(nb)! * 7 + bond.order).sort((x, y) => x - y);
      let h = rank.get(a.id)!;
      for (const v of nbs) h = (h * 1000003 + v) % 2147483647;
      next.set(a.id, h);
    }
    rank = next;
  }
  return rank;
}

/** Double bonds that can carry E/Z (geometric) stereo. */
export function isStereoDoubleBond(d: ChemDoc, g: Graph, ri: RingInfo, bondId: number, ranks: Map<number, number>): boolean {
  const b = d.bonds.find((x) => x.id === bondId)!;
  if (b.order !== 2 || b.stereo === 4) return false;
  const rs = ri.bondRings.get(b.id);
  if (rs && rs.some((r) => ri.rings[r].length < 8)) return false;
  for (const end of [b.a, b.b]) {
    const other = end === b.a ? b.b : b.a;
    const a = g.atomById.get(end)!;
    if (!["C", "N", "Si", "P"].includes(a.el)) return false;
    const nbs = g.adj.get(end)!.filter((x) => x.nb !== other);
    if (nbs.length < 1 || nbs.length > 2) return false;
    if (nbs.some((x) => x.bond.stereo === 4 && (x.bond.a === end || x.bond.b === end))) return false;
    if (nbs.length === 2 && ranks.get(nbs[0].nb) === ranks.get(nbs[1].nb)) return false;
    if (nbs.some((x) => x.bond.order === 2)) return false; // allene / cumulene
  }
  return true;
}

/**
 * Canonical atom ranks (Morgan-style refinement with tie breaking).
 * Initial invariant favours low degree and low atomic number so SMILES start at a terminal carbon.
 */
export function canonRanks(doc: ChemDoc, g: Graph, aromAtoms: Set<number>, Z: (el: string) => number, hOf: (a: Atom) => number): Map<number, number> {
  const ids = doc.atoms.map((a) => a.id);
  const dense = (key: Map<number, number[]>) => {
    const sorted = ids.slice().sort((x, y) => cmp(key.get(x)!, key.get(y)!));
    const r = new Map<number, number>();
    let rank = 0;
    sorted.forEach((id, i) => { if (i > 0 && cmp(key.get(sorted[i - 1])!, key.get(id)!) !== 0) rank++; r.set(id, rank); });
    return { r, n: rank + 1 };
  };
  const cmp = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? -1) - (b[i] ?? -1); if (d) return d; } return 0; };
  const key0 = new Map<number, number[]>();
  for (const a of doc.atoms) {
    key0.set(a.id, [g.adj.get(a.id)!.length, a.el === "*" ? 200 : Z(a.el), hOf(a), a.charge + 10, a.isotope ?? 0, aromAtoms.has(a.id) ? 1 : 0, a.label ? a.label.charCodeAt(0) : 0]);
  }
  let { r: rank, n } = dense(key0);
  const refine = () => {
    for (let it = 0; it < ids.length + 1; it++) {
      const key = new Map<number, number[]>();
      for (const id of ids) {
        const nb = g.adj.get(id)!.map(({ nb, bond }) => rank.get(nb)! * 8 + bond.order).sort((x, y) => x - y);
        key.set(id, [rank.get(id)!, ...nb]);
      }
      const d = dense(key);
      if (d.n === n) { rank = d.r; return; }
      rank = d.r; n = d.n;
    }
  };
  refine();
  while (n < ids.length) {
    // break the lowest tie
    const counts = new Map<number, number>();
    for (const id of ids) counts.set(rank.get(id)!, (counts.get(rank.get(id)!) ?? 0) + 1);
    let tied = Infinity;
    for (const [r, c] of counts) if (c > 1 && r < tied) tied = r;
    const chosen = ids.find((id) => rank.get(id) === tied)!;
    const key = new Map<number, number[]>();
    for (const id of ids) key.set(id, [rank.get(id)! * 2 + (rank.get(id) === tied && id !== chosen ? 1 : 0)]);
    const d = dense(key);
    rank = d.r; n = d.n;
    refine();
  }
  return rank;
}
