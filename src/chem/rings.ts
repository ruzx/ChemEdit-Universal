// Ring perception (SSSR), ring systems and a simple aromaticity model.

import { ChemDoc, Graph, buildGraph } from "./model";

export interface RingInfo {
  rings: number[][]; // atom ids in cyclic order
  ringBondIds: number[][]; // bond ids per ring (same order as rings)
  ringBonds: Set<number>;
  atomRings: Map<number, number[]>;
  bondRings: Map<number, number[]>;
  systems: number[][]; // ring indices grouped into fused/spiro systems
}

function findBridges(d: ChemDoc, g: Graph): Set<number> {
  const disc = new Map<number, number>();
  const low = new Map<number, number>();
  const bridges = new Set<number>();
  let t = 0;
  for (const start of d.atoms) {
    if (disc.has(start.id)) continue;
    // iterative DFS
    const stack: Array<{ u: number; pb: number; i: number }> = [{ u: start.id, pb: -1, i: 0 }];
    disc.set(start.id, t); low.set(start.id, t); t++;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const nbs = g.adj.get(top.u)!;
      if (top.i < nbs.length) {
        const { nb, bond } = nbs[top.i++];
        if (bond.id === top.pb) continue;
        if (!disc.has(nb)) {
          disc.set(nb, t); low.set(nb, t); t++;
          stack.push({ u: nb, pb: bond.id, i: 0 });
        } else low.set(top.u, Math.min(low.get(top.u)!, disc.get(nb)!));
      } else {
        stack.pop();
        if (stack.length) {
          const p = stack[stack.length - 1];
          low.set(p.u, Math.min(low.get(p.u)!, low.get(top.u)!));
          if (low.get(top.u)! > disc.get(p.u)!) bridges.add(top.pb);
        }
      }
    }
  }
  return bridges;
}

export function findRings(d: ChemDoc, g: Graph = buildGraph(d)): RingInfo {
  const bridges = findBridges(d, g);
  const ringBondList = d.bonds.filter((b) => !bridges.has(b.id) && g.atomById.has(b.a) && g.atomById.has(b.b));
  const ringBonds = new Set(ringBondList.map((b) => b.id));
  const bitIndex = new Map<number, number>();
  ringBondList.forEach((b, i) => bitIndex.set(b.id, i));
  const words = Math.ceil(ringBondList.length / 32) || 1;

  // ring adjacency
  const radj = new Map<number, Array<{ nb: number; bid: number }>>();
  for (const b of ringBondList) {
    if (!radj.has(b.a)) radj.set(b.a, []);
    if (!radj.has(b.b)) radj.set(b.b, []);
    radj.get(b.a)!.push({ nb: b.b, bid: b.id });
    radj.get(b.b)!.push({ nb: b.a, bid: b.id });
  }

  // components of ring subgraph -> needed ring count
  const compOf = new Map<number, number>();
  const compNeeded: number[] = [];
  let ci = 0;
  for (const start of radj.keys()) {
    if (compOf.has(start)) continue;
    let V = 0, E2 = 0;
    const st = [start]; compOf.set(start, ci);
    while (st.length) {
      const u = st.pop()!; V++;
      for (const { nb } of radj.get(u)!) { E2++; if (!compOf.has(nb)) { compOf.set(nb, ci); st.push(nb); } }
    }
    compNeeded.push(E2 / 2 - V + 1);
    ci++;
  }

  type Cand = { atoms: number[]; bonds: number[]; bits: Uint32Array };
  const cands: Cand[] = [];
  const seenKey = new Set<string>();
  const addCycle = (atoms: number[], bonds: number[]) => {
    const key = bonds.slice().sort((a, b) => a - b).join(",");
    if (seenKey.has(key)) return;
    seenKey.add(key);
    const bits = new Uint32Array(words);
    for (const bid of bonds) { const k = bitIndex.get(bid)!; bits[k >> 5] |= 1 << (k & 31); }
    cands.push({ atoms, bonds, bits });
  };

  const bfsPath = (src: number, dst: number, banned: number): { atoms: number[]; bonds: number[] } | null => {
    const prev = new Map<number, { p: number; bid: number }>();
    prev.set(src, { p: -1, bid: -1 });
    const q = [src];
    for (let qi = 0; qi < q.length; qi++) {
      const u = q[qi];
      if (u === dst) break;
      for (const { nb, bid } of radj.get(u)!) {
        if (bid === banned || prev.has(nb)) continue;
        prev.set(nb, { p: u, bid });
        q.push(nb);
      }
    }
    if (!prev.has(dst)) return null;
    const atoms: number[] = []; const bonds: number[] = [];
    let c = dst;
    while (c !== src) { const pr = prev.get(c)!; atoms.push(c); bonds.push(pr.bid); c = pr.p; }
    atoms.push(src);
    return { atoms: atoms.reverse(), bonds: bonds.reverse() };
  };

  for (const b of ringBondList) {
    const p = bfsPath(b.a, b.b, b.id);
    if (p) addCycle(p.atoms, [...p.bonds, b.id]);
  }

  const select = () => {
    cands.sort((x, y) => x.atoms.length - y.atoms.length);
    const basis: Uint32Array[] = [];
    const pivots: number[] = [];
    const chosen: Cand[] = [];
    for (const c of cands) {
      const v = c.bits.slice();
      for (let i = 0; i < basis.length; i++) {
        const p = pivots[i];
        if (v[p >> 5] & (1 << (p & 31))) for (let w = 0; w < words; w++) v[w] ^= basis[i][w];
      }
      let piv = -1;
      for (let w = 0; w < words && piv < 0; w++) if (v[w]) for (let k = 0; k < 32; k++) if (v[w] & (1 << k)) { piv = w * 32 + k; break; }
      if (piv >= 0) { basis.push(v); pivots.push(piv); chosen.push(c); }
    }
    return chosen;
  };

  let chosen = select();
  const needed = compNeeded.reduce((s, x) => s + x, 0);
  if (chosen.length < needed) {
    // Horton-style extra candidates
    for (const r of radj.keys()) {
      const prev = new Map<number, { p: number; bid: number }>();
      prev.set(r, { p: -1, bid: -1 });
      const q = [r];
      for (let qi = 0; qi < q.length; qi++) for (const { nb, bid } of radj.get(q[qi])!) if (!prev.has(nb)) { prev.set(nb, { p: q[qi], bid }); q.push(nb); }
      const pathTo = (x: number) => { const at: number[] = []; const bd: number[] = []; let c = x; while (c !== r) { const pr = prev.get(c)!; at.push(c); bd.push(pr.bid); c = pr.p; } at.push(r); return { at, bd }; };
      for (const b of ringBondList) {
        if (!prev.has(b.a) || !prev.has(b.b)) continue;
        const pa = pathTo(b.a), pb = pathTo(b.b);
        const sa = new Set(pa.at);
        if (pb.at.filter((x) => sa.has(x)).length !== 1) continue;
        if (pa.bd.includes(b.id) || pb.bd.includes(b.id)) continue;
        // cyclic order: r ... a, then b ... (towards r, excluding r)
        const atoms = [...pa.at.slice().reverse(), ...pb.at.slice(0, -1)];
        const bonds = [...pa.bd.slice().reverse(), b.id, ...pb.bd.slice()];
        addCycle(atoms, bonds);
      }
    }
    chosen = select();
  }

  const rings = chosen.map((c) => c.atoms);
  const ringBondIds = chosen.map((c) => c.bonds);
  const atomRings = new Map<number, number[]>();
  const bondRings = new Map<number, number[]>();
  rings.forEach((r, i) => {
    for (const a of r) { if (!atomRings.has(a)) atomRings.set(a, []); atomRings.get(a)!.push(i); }
    for (const b of ringBondIds[i]) { if (!bondRings.has(b)) bondRings.set(b, []); bondRings.get(b)!.push(i); }
  });

  // ring systems: rings sharing at least one atom
  const parent = rings.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const list of atomRings.values()) for (let i = 1; i < list.length; i++) parent[find(list[i])] = find(list[0]);
  const sysMap = new Map<number, number[]>();
  rings.forEach((_, i) => { const r = find(i); if (!sysMap.has(r)) sysMap.set(r, []); sysMap.get(r)!.push(i); });

  return { rings, ringBondIds, ringBonds, atomRings, bondRings, systems: [...sysMap.values()] };
}

/** Simple Hückel-style aromaticity: returns aromatic bond ids and atom ids. */
export function perceiveAromaticity(d: ChemDoc, g: Graph, ri: RingInfo) {
  const aromBonds = new Set<number>();
  const aromAtoms = new Set<number>();
  const ringAtomSet = new Set<number>(ri.atomRings.keys());
  const electrons = (aid: number, ringSet: Set<number>): number => {
    const a = g.atomById.get(aid)!;
    let dblIn = false, dblOut = false, sum = 0;
    for (const { nb, bond } of g.adj.get(aid)!) {
      sum += bond.order;
      if (bond.order === 2) {
        if (ringSet.has(nb) || ringAtomSet.has(nb) && ri.ringBonds.has(bond.id)) dblIn = true;
        else dblOut = true;
      }
      if (bond.order === 3) return -1;
    }
    if (dblIn) return 1;
    if (dblOut) return a.el === "C" || a.el === "S" ? 0 : -1;
    if (a.el === "C") return a.charge === -1 ? 2 : a.charge === 1 ? 0 : -1;
    if (a.el === "B") return 0;
    if (["N", "P", "As"].includes(a.el)) return sum <= 3 && a.charge === 0 ? 2 : -1;
    if (["O", "S", "Se", "Te"].includes(a.el)) return a.charge === 0 ? 2 : a.charge === 1 ? 1 : -1;
    return -1;
  };
  const test = (atoms: number[]) => {
    const set = new Set(atoms);
    let total = 0;
    for (const a of atoms) { const e = electrons(a, set); if (e < 0) return false; total += e; }
    return total % 4 === 2;
  };
  const mark = (ringIdxs: number[]) => {
    for (const i of ringIdxs) {
      for (const a of ri.rings[i]) aromAtoms.add(a);
      for (const b of ri.ringBondIds[i]) aromBonds.add(b);
    }
  };
  const done = new Set<number>();
  ri.rings.forEach((r, i) => { if (r.length >= 5 && r.length <= 7 && test(r)) { mark([i]); done.add(i); } });
  // fused pairs (e.g. azulene) not aromatic individually
  for (const sys of ri.systems) {
    for (let x = 0; x < sys.length; x++) for (let y = x + 1; y < sys.length; y++) {
      const i = sys[x], j = sys[y];
      if (done.has(i) && done.has(j)) continue;
      const shared = ri.ringBondIds[i].filter((b) => ri.ringBondIds[j].includes(b));
      if (shared.length !== 1) continue;
      const atoms = [...new Set([...ri.rings[i], ...ri.rings[j]])];
      if (test(atoms)) { mark([i, j]); done.add(i); done.add(j); }
    }
  }
  return { aromBonds, aromAtoms };
}
