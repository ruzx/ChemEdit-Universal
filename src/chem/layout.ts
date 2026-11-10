// 2D coordinate generation (bond length = 1, y down).

import { Atom, ChemDoc, Graph, buildGraph, components, newId, docBBox, translateDoc } from "./model";
import { findRings, RingInfo } from "./rings";
import { parityFromDrawing, sameSide, ecRanks, isStereoDoubleBond } from "./stereo";
import type { Role } from "./smiles";

type P = { x: number; y: number };
const DEG = Math.PI / 180;

const norm = (x: number, y: number): P => { const L = Math.hypot(x, y) || 1; return { x: x / L, y: y / L }; };
const rot = (p: P, a: number): P => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
const angOf = (p: P) => Math.atan2(p.y, p.x);

/** Regular polygon radius for n-gon with unit edge. */
export const polyRadius = (n: number) => 1 / (2 * Math.sin(Math.PI / n));

function arcPoints(B: P, A: P, m: number, away: P): P[] {
  const k = m + 1;
  const d = Math.hypot(A.x - B.x, A.y - B.y);
  const M = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  let n = norm(-(A.y - B.y), A.x - B.x);
  if ((M.x - away.x) * n.x + (M.y - away.y) * n.y < 0) n = { x: -n.x, y: -n.y };
  if (d < 1e-6) {
    // closed loop starting/ending at the same atom
    const R = polyRadius(k);
    const C = { x: B.x + n.x * R, y: B.y + n.y * R };
    const a0 = angOf({ x: B.x - C.x, y: B.y - C.y });
    return Array.from({ length: m }, (_, j) => ({ x: C.x + R * Math.cos(a0 + (2 * Math.PI * (j + 1)) / k), y: C.y + R * Math.sin(a0 + (2 * Math.PI * (j + 1)) / k) }));
  }
  if (d >= k * 0.999) {
    return Array.from({ length: m }, (_, j) => ({ x: B.x + ((A.x - B.x) * (j + 1)) / k + n.x * 0.3, y: B.y + ((A.y - B.y) * (j + 1)) / k + n.y * 0.3 }));
  }
  let lo = 1e-6, hi = Math.PI / k - 1e-6;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    const f = Math.sin(k * mid) / Math.sin(mid);
    if (f > d) lo = mid; else hi = mid;
  }
  const phi = (lo + hi) / 2;
  const r = 1 / (2 * Math.sin(phi));
  const theta = 2 * k * phi;
  const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
  const s = theta <= Math.PI ? -1 : 1;
  const C = { x: M.x + n.x * h * s, y: M.y + n.y * h * s };
  const aB = angOf({ x: B.x - C.x, y: B.y - C.y });
  const aA = angOf({ x: A.x - C.x, y: A.y - C.y });
  let bestDir = 1, bestErr = Infinity;
  for (const dir of [1, -1]) {
    const end = aB + dir * theta;
    let err = Math.abs(Math.atan2(Math.sin(end - aA), Math.cos(end - aA)));
    const midA = aB + dir * theta / 2;
    const mp = { x: C.x + r * Math.cos(midA), y: C.y + r * Math.sin(midA) };
    if ((mp.x - M.x) * n.x + (mp.y - M.y) * n.y < 0) err += 0.5;
    if (err < bestErr) { bestErr = err; bestDir = dir; }
  }
  return Array.from({ length: m }, (_, j) => {
    const a = aB + bestDir * 2 * phi * (j + 1);
    return { x: C.x + r * Math.cos(a), y: C.y + r * Math.sin(a) };
  });
}

/** Local coordinates for one ring system. */
function layoutRingSystem(ri: RingInfo, sys: number[]): Map<number, P> {
  const pos = new Map<number, P>();
  const ringsAtoms = sys.map((i) => ri.rings[i]);
  // start with the ring sharing atoms with most other rings, then largest
  const shareCount = ringsAtoms.map((r) => ringsAtoms.filter((o) => o !== r && o.some((a) => r.includes(a))).length);
  let start = 0;
  for (let i = 1; i < ringsAtoms.length; i++) {
    if (shareCount[i] > shareCount[start] || (shareCount[i] === shareCount[start] && ringsAtoms[i].length > ringsAtoms[start].length)) start = i;
  }
  const placedRings = new Set<number>();
  const placeFirst = (r: number[]) => {
    const n = r.length;
    const R = polyRadius(n);
    r.forEach((a, k) => {
      const ang = -Math.PI / 2 + (2 * Math.PI * k) / n + (n % 2 === 0 ? 0 : 0);
      pos.set(a, { x: R * Math.cos(ang), y: R * Math.sin(ang) });
    });
  };
  placeFirst(ringsAtoms[start]);
  placedRings.add(start);
  const centroidPlaced = () => {
    let sx = 0, sy = 0, c = 0;
    for (const p of pos.values()) { sx += p.x; sy += p.y; c++; }
    return { x: sx / c, y: sy / c };
  };
  while (placedRings.size < ringsAtoms.length) {
    let next = -1, bestShared = 0;
    ringsAtoms.forEach((r, i) => {
      if (placedRings.has(i)) return;
      const sh = r.filter((a) => pos.has(a)).length;
      if (sh > bestShared || (sh === bestShared && sh > 0 && next >= 0 && r.length < ringsAtoms[next].length)) { bestShared = sh; next = i; }
    });
    if (next < 0) break;
    placedRings.add(next);
    const r = ringsAtoms[next];
    const n = r.length;
    const placedIdx = r.map((a, k) => (pos.has(a) ? k : -1)).filter((k) => k >= 0);
    if (placedIdx.length === n) continue;
    if (placedIdx.length === 1) {
      const p = pos.get(r[placedIdx[0]])!;
      const c = centroidPlaced();
      const dir = norm(p.x - c.x || 1, p.y - c.y);
      const R = polyRadius(n);
      const C = { x: p.x + dir.x * R, y: p.y + dir.y * R };
      const a0 = angOf({ x: p.x - C.x, y: p.y - C.y });
      for (let k = 1; k < n; k++) {
        const a = r[(placedIdx[0] + k) % n];
        const ang = a0 + (2 * Math.PI * k) / n;
        pos.set(a, { x: C.x + R * Math.cos(ang), y: C.y + R * Math.sin(ang) });
      }
      continue;
    }
    // adjacent pair -> regular polygon fused on the edge
    if (placedIdx.length === 2) {
      const [i0, i1] = placedIdx;
      const adjacent = (i1 - i0 === 1) || (i0 === 0 && i1 === n - 1);
      if (adjacent) {
        // order so that P -> Q follows ring order
        let pi = i0, qi = i1;
        if (i0 === 0 && i1 === n - 1) { pi = n - 1; qi = 0; }
        const P0 = pos.get(r[pi])!, Q0 = pos.get(r[qi])!;
        // side: away from placed rings containing both atoms
        let cx = 0, cy = 0, cnt = 0;
        ringsAtoms.forEach((o, j) => {
          if (j === next || !placedRings.has(j)) return;
          if (o.includes(r[pi]) && o.includes(r[qi])) for (const a of o) { const pp = pos.get(a); if (pp) { cx += pp.x; cy += pp.y; cnt++; } }
        });
        const away = cnt ? { x: cx / cnt, y: cy / cnt } : centroidPlaced();
        const M = { x: (P0.x + Q0.x) / 2, y: (P0.y + Q0.y) / 2 };
        let nrm = norm(-(Q0.y - P0.y), Q0.x - P0.x);
        if ((M.x - away.x) * nrm.x + (M.y - away.y) * nrm.y < 0) nrm = { x: -nrm.x, y: -nrm.y };
        const ap = 1 / (2 * Math.tan(Math.PI / n));
        const C = { x: M.x + nrm.x * ap, y: M.y + nrm.y * ap };
        const R = polyRadius(n);
        const aP = angOf({ x: P0.x - C.x, y: P0.y - C.y });
        const aQ = angOf({ x: Q0.x - C.x, y: Q0.y - C.y });
        let step = Math.atan2(Math.sin(aQ - aP), Math.cos(aQ - aP));
        for (let k = 1; k < n - 1; k++) {
          const a = r[(qi + k) % n];
          const ang = aQ + step * k;
          pos.set(a, { x: C.x + R * Math.cos(ang), y: C.y + R * Math.sin(ang) });
        }
        continue;
      }
    }
    // general: bridge each unplaced segment with an arc
    const away = centroidPlaced();
    const isPlaced = (k: number) => pos.has(r[((k % n) + n) % n]);
    let k0 = placedIdx[0];
    for (let step = 0; step < n; step++) {
      const k = k0 + step;
      if (isPlaced(k) && !isPlaced(k + 1)) {
        let e = k + 1;
        const seg: number[] = [];
        while (!isPlaced(e)) { seg.push(r[e % n]); e++; }
        const B = pos.get(r[k % n])!, A = pos.get(r[e % n])!;
        const pts = arcPoints(B, A, seg.length, away);
        seg.forEach((a, j) => pos.set(a, pts[j]));
      }
    }
  }
  return pos;
}

function isLinearAt(g: Graph, id: number) {
  let dbl = 0;
  for (const { bond } of g.adj.get(id)!) {
    if (bond.order === 3) return true;
    if (bond.order === 2) dbl++;
  }
  return dbl >= 2;
}

function layoutComponent(doc: ChemDoc, g: Graph, ri: RingInfo, comp: number[]) {
  const inComp = new Set(comp);
  const pos = new Map<number, P>();
  const turn = new Map<number, number>();
  const sysOfAtom = new Map<number, number>();
  const systems = ri.systems.filter((s) => ri.rings[s[0]].every((a) => inComp.has(a)));
  systems.forEach((s, si) => { for (const ridx of s) for (const a of ri.rings[ridx]) sysOfAtom.set(a, si); });
  const sysLocal = new Map<number, Map<number, P>>();
  const sysPlaced = new Set<number>();
  const getLocal = (si: number) => {
    if (!sysLocal.has(si)) sysLocal.set(si, layoutRingSystem(ri, systems[si]));
    return sysLocal.get(si)!;
  };
  const queue: number[] = [];

  if (comp.length === 1) { pos.set(comp[0], { x: 0, y: 0 }); }
  else if (systems.length) {
    let best = 0;
    systems.forEach((s, i) => { if (getLocal(i).size > getLocal(best).size) best = i; });
    for (const [a, p] of getLocal(best)) { pos.set(a, { ...p }); queue.push(a); }
    sysPlaced.add(best);
  } else {
    // longest path endpoint
    const far = (src: number) => {
      const dist = new Map<number, number>([[src, 0]]);
      const q = [src];
      let last = src;
      for (let i = 0; i < q.length; i++) for (const { nb } of g.adj.get(q[i])!) if (!dist.has(nb)) { dist.set(nb, dist.get(q[i])! + 1); q.push(nb); last = nb; }
      return last;
    };
    const seed = far(far(comp[0]));
    pos.set(seed, { x: 0, y: 0 });
    turn.set(seed, -1);
    queue.push(seed);
  }

  const subtreeSize = (from: number, start: number) => {
    const seen = new Set<number>([from, start]);
    const st = [start];
    let n = 0;
    while (st.length) {
      const u = st.pop()!;
      n++;
      for (const { nb } of g.adj.get(u)!) if (!seen.has(nb) && !pos.has(nb)) { seen.add(nb); st.push(nb); }
    }
    return n;
  };
  const clearance = (p: P, exclude: number) => {
    let m = Infinity;
    for (const [id, q] of pos) if (id !== exclude) m = Math.min(m, Math.hypot(p.x - q.x, p.y - q.y));
    return m;
  };

  const placeSystemAttached = (si: number, v: number, u: number, theta: number) => {
    const local = getLocal(si);
    const Pv = local.get(v)!;
    let cx = 0, cy = 0, c = 0;
    for (const { nb } of g.adj.get(v)!) { const q = local.get(nb); if (q) { cx += q.x; cy += q.y; c++; } }
    let out = c ? norm(Pv.x - cx / c, Pv.y - cy / c) : norm(Pv.x, Pv.y);
    if (!isFinite(out.x)) out = { x: 1, y: 0 };
    const U = pos.get(u)!;
    const T = { x: U.x + Math.cos(theta), y: U.y + Math.sin(theta) };
    // the ring's outward direction at v must point back at u
    const rho = theta + Math.PI - angOf(out);
    // try both mirror images, keep the one with better clearance
    let bestMap: Map<number, P> | null = null;
    let bestScore = -Infinity;
    for (const mirror of [false, true]) {
      const m = new Map<number, P>();
      for (const [a, p] of local) {
        let rel = { x: p.x - Pv.x, y: p.y - Pv.y };
        if (mirror) {
          // reflect across the outward axis
          const ax = out;
          const dot = rel.x * ax.x + rel.y * ax.y;
          rel = { x: 2 * dot * ax.x - rel.x, y: 2 * dot * ax.y - rel.y };
        }
        const rr = rot(rel, rho);
        m.set(a, { x: T.x + rr.x, y: T.y + rr.y });
      }
      let score = Infinity;
      for (const p of m.values()) for (const [id, q] of pos) if (id !== u) score = Math.min(score, Math.hypot(p.x - q.x, p.y - q.y));
      if (score > bestScore + 1e-3) { bestScore = score; bestMap = m; }
    }
    for (const [id, p] of bestMap!) pos.set(id, p);
    sysPlaced.add(si);
    queue.push(v);
    for (const a of bestMap!.keys()) if (a !== v) queue.push(a);
  };

  while (queue.length) {
    const u = queue.shift()!;
    const U = pos.get(u)!;
    const nbs = g.adj.get(u)!.map((x) => x.nb).filter((x) => inComp.has(x));
    const unplaced = nbs.filter((x) => !pos.has(x));
    if (!unplaced.length) continue;
    const placedNb = nbs.filter((x) => pos.has(x));
    const k = unplaced.length;
    // order: biggest subtree last (main chain)
    const sizes = new Map(unplaced.map((v) => [v, subtreeSize(u, v)]));
    unplaced.sort((a, b) => sizes.get(a)! - sizes.get(b)!);
    const assign: Array<[number, number, number]> = []; // [atom, angle, turn]
    if (placedNb.length === 0) {
      const base = -30 * DEG;
      unplaced.forEach((v, i) => assign.push([v, base + (2 * Math.PI * i) / k, 1]));
    } else if (placedNb.length === 1) {
      const p = pos.get(placedNb[0])!;
      const alpha = angOf({ x: U.x - p.x, y: U.y - p.y });
      const tz = -(turn.get(placedNb[0]) ?? 1);
      if (k === 1) {
        if (isLinearAt(g, u)) assign.push([unplaced[0], alpha, tz]);
        else {
          const c1 = alpha + tz * 60 * DEG, c2 = alpha - tz * 60 * DEG;
          const p1 = { x: U.x + Math.cos(c1), y: U.y + Math.sin(c1) };
          const p2 = { x: U.x + Math.cos(c2), y: U.y + Math.sin(c2) };
          const cl1 = clearance(p1, u), cl2 = clearance(p2, u);
          if (cl1 >= 0.7 || cl1 >= cl2) assign.push([unplaced[0], c1, tz]);
          else assign.push([unplaced[0], c2, -tz]);
        }
      } else if (k === 2) {
        const main = unplaced[1], br = unplaced[0];
        assign.push([main, alpha + tz * 60 * DEG, tz]);
        assign.push([br, alpha - tz * 60 * DEG, -tz]);
      } else if (k === 3) {
        assign.push([unplaced[2], alpha, tz]);
        assign.push([unplaced[0], alpha + 90 * DEG, 1]);
        assign.push([unplaced[1], alpha - 90 * DEG, -1]);
      } else {
        unplaced.forEach((v, i) => assign.push([v, alpha + Math.PI + (2 * Math.PI * (i + 1)) / (k + 1), 1]));
      }
    } else {
      const angs = placedNb.map((x) => { const q = pos.get(x)!; return angOf({ x: q.x - U.x, y: q.y - U.y }); }).sort((a, b) => a - b);
      let gapStart = angs[angs.length - 1], gap = angs[0] + 2 * Math.PI - angs[angs.length - 1];
      for (let i = 1; i < angs.length; i++) if (angs[i] - angs[i - 1] > gap) { gap = angs[i] - angs[i - 1]; gapStart = angs[i - 1]; }
      if (k === 2 && placedNb.length === 2 && gap > 200 * DEG) {
        // gem-disubstituted: spread symmetrically around the bisector
        const mid = gapStart + gap / 2;
        assign.push([unplaced[0], mid - 30 * DEG * 1.2, 1]);
        assign.push([unplaced[1], mid + 30 * DEG * 1.2, -1]);
      } else unplaced.forEach((v, i) => assign.push([v, gapStart + (gap * (i + 1)) / (k + 1), i % 2 ? -1 : 1]));
    }
    for (const [v, theta, t] of assign) {
      const si = sysOfAtom.get(v);
      if (si !== undefined && !sysPlaced.has(si)) { placeSystemAttached(si, v, u, theta); turn.set(v, t); continue; }
      if (pos.has(v)) continue;
      pos.set(v, { x: U.x + Math.cos(theta), y: U.y + Math.sin(theta) });
      turn.set(v, t);
      queue.push(v);
    }
  }
  // anything left (should not happen)
  let off = 0;
  for (const id of comp) if (!pos.has(id)) pos.set(id, { x: (off += 1.2), y: 2 });

  // relieve exact overlaps
  const ids = [...pos.keys()];
  for (let it = 0; it < 3; it++) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = pos.get(ids[i])!, b = pos.get(ids[j])!;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < 0.25) { b.x += 0.35; b.y += 0.2; }
    }
  }
  for (const id of comp) { const a = g.atomById.get(id)!; const p = pos.get(id)!; a.x = p.x; a.y = p.y; }
}

/**
 * Remove atom overlaps by reflecting substituent subtrees across acyclic single bonds
 * (keeps bond lengths/angles; E/Z is preserved because both bond atoms stay fixed).
 */
export function resolveClashes(doc: ChemDoc, g: Graph, ri: RingInfo, comp: number[]) {
  if (comp.length < 4) return;
  const atoms = comp.map((id) => g.atomById.get(id)!);
  const labelled = (a: Atom) => !!a.label || a.el !== "C";
  const bonded = new Set<string>();
  for (const id of comp) for (const { nb } of g.adj.get(id)!) bonded.add(id < nb ? id + "_" + nb : nb + "_" + id);
  const near = (x: number, y: number) => x < y ? x + "_" + y : y + "_" + x;
  const score = () => {
    let s = 0;
    for (let i = 0; i < atoms.length; i++) for (let j = i + 1; j < atoms.length; j++) {
      const a = atoms[i], b = atoms[j];
      if (bonded.has(near(a.id, b.id))) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const thr = labelled(a) && labelled(b) ? 1.05 : labelled(a) || labelled(b) ? 0.9 : 0.75;
      if (d < thr) s += (thr - d) * (thr - d) * 10 + (d < 0.3 ? 5 : 0);
    }
    // bond crossings
    const bl = doc.bonds.filter((b) => comp.includes(b.a));
    for (let i = 0; i < bl.length; i++) for (let j = i + 1; j < bl.length; j++) {
      const p = bl[i], q = bl[j];
      if (p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b) continue;
      const A = g.atomById.get(p.a)!, B = g.atomById.get(p.b)!, C = g.atomById.get(q.a)!, D = g.atomById.get(q.b)!;
      if (segCross(A, B, C, D)) s += 2;
    }
    return s;
  };
  let cur = score();
  if (cur === 0) return;
  const cands = doc.bonds.filter((b) => comp.includes(b.a) && b.order === 1 && !ri.ringBonds.has(b.id) && g.adj.get(b.a)!.length > 1 && g.adj.get(b.b)!.length > 1);
  const sideOf = (b: typeof cands[number], from: number, other: number) => {
    const side = new Set<number>([from]);
    const st = [from];
    while (st.length) { const u = st.pop()!; for (const { nb } of g.adj.get(u)!) if (nb !== other && !side.has(nb)) { side.add(nb); st.push(nb); } }
    return side;
  };
  const reflect = (side: Set<number>, axisA: Atom, axisB: Atom) => {
    const L = Math.hypot(axisB.x - axisA.x, axisB.y - axisA.y) || 1;
    const ux = (axisB.x - axisA.x) / L, uy = (axisB.y - axisA.y) / L;
    for (const id of side) {
      if (id === axisA.id || id === axisB.id) continue;
      const p = g.atomById.get(id)!;
      const rx = p.x - axisA.x, ry = p.y - axisA.y;
      const dot = rx * ux + ry * uy;
      p.x = axisA.x + 2 * dot * ux - rx; p.y = axisA.y + 2 * dot * uy - ry;
    }
  };
  for (let pass = 0; pass < 4 && cur > 0; pass++) {
    let improved = false;
    for (const b of cands) {
      const sa = sideOf(b, b.b, b.a);
      if (sa.has(b.a)) continue;
      const sb = sideOf(b, b.a, b.b);
      const small = sa.size <= sb.size ? sa : sb;
      const A = g.atomById.get(b.a)!, B = g.atomById.get(b.b)!;
      reflect(small, A, B);
      const s2 = score();
      if (s2 < cur - 1e-6) { cur = s2; improved = true; }
      else reflect(small, A, B);
      if (cur === 0) break;
    }
    if (!improved) break;
  }
}

function segCross(A: P, B: P, C: P, D: P) {
  const o = (p: P, q: P, r: P) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(A, B, C), d2 = o(A, B, D), d3 = o(C, D, A), d4 = o(C, D, B);
  return d1 * d2 < -1e-6 && d3 * d4 < -1e-6;
}

/** Rotate component (multiples of 30°) to be as wide/flat as possible; centre at origin. */
function orientComponent(g: Graph, comp: number[]) {
  const atoms = comp.map((id) => g.atomById.get(id)!);
  let cx = 0, cy = 0;
  for (const a of atoms) { cx += a.x; cy += a.y; }
  cx /= atoms.length; cy /= atoms.length;
  let bestA = 0, bestH = Infinity;
  if (atoms.length > 2) {
    for (let k = 0; k < 12; k++) {
      const ang = k * 30 * DEG;
      let minY = Infinity, maxY = -Infinity;
      for (const a of atoms) {
        const y = (a.x - cx) * Math.sin(ang) + (a.y - cy) * Math.cos(ang);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      const h = maxY - minY;
      if (h < bestH - 0.05) { bestH = h; bestA = ang; }
    }
  }
  for (const a of atoms) {
    const r = rot({ x: a.x - cx, y: a.y - cy }, bestA);
    a.x = r.x; a.y = r.y;
  }
}

/** Apply E/Z requests by reflecting substituent subtrees. */
function applyEZ(doc: ChemDoc, g: Graph) {
  for (const b of doc.bonds) {
    if (!b.ez) continue;
    const { ra, rb, cis } = b.ez;
    delete b.ez;
    if (!g.atomById.has(ra) || !g.atomById.has(rb)) continue;
    if (sameSide(g, b.a, b.b, ra, rb) === cis) continue;
    const side = new Set<number>([b.b]);
    const st = [b.b];
    let ring = false;
    while (st.length) {
      const u = st.pop()!;
      for (const { nb, bond } of g.adj.get(u)!) {
        if (bond.id === b.id) continue;
        if (nb === b.a) { ring = true; continue; }
        if (!side.has(nb)) { side.add(nb); st.push(nb); }
      }
    }
    if (ring) continue;
    const A = g.atomById.get(b.a)!, B = g.atomById.get(b.b)!;
    const ax = norm(B.x - A.x, B.y - A.y);
    for (const id of side) {
      if (id === b.b) continue;
      const p = g.atomById.get(id)!;
      const rx = p.x - A.x, ry = p.y - A.y;
      const dot = rx * ax.x + ry * ax.y;
      p.x = A.x + 2 * dot * ax.x - rx;
      p.y = A.y + 2 * dot * ax.y - ry;
    }
  }
}

/** Place wedges/hashes so the drawing reproduces SMILES chirality tags. */
export function assignWedges(doc: ChemDoc, g: Graph, ri: RingInfo) {
  for (const a of doc.atoms) {
    if (!a.chiral) continue;
    const { tag, order } = a.chiral;
    delete a.chiral;
    if (order.some((o) => o === 0)) continue;
    const cands = g.adj.get(a.id)!
      .filter(({ bond }) => bond.order === 1 && bond.stereo === 0)
      .map(({ nb, bond }) => {
        const o = g.atomById.get(nb)!;
        let s = 0;
        if (ri.ringBonds.has(bond.id)) s += 10;
        if (o.chiral) s += 6;
        if (g.adj.get(nb)!.some((x) => x.bond.stereo && x.bond.a === nb)) s += 6;
        s += g.adj.get(nb)!.length;
        if (o.el !== "C") s -= 0.5;
        return { nb, bond, s };
      })
      .sort((x, y) => x.s - y.s);
    for (const c of cands) {
      if (c.bond.a !== a.id) { const t = c.bond.a; c.bond.a = c.bond.b; c.bond.b = t; }
      c.bond.stereo = 1;
      const p = parityFromDrawing(g, a, order);
      if (p === null) { c.bond.stereo = 0; continue; }
      if (p !== tag) c.bond.stereo = 6;
      break;
    }
  }
}

export interface LayoutOptions { roles?: Map<number, Role> | null }

/** Full layout of a freshly parsed document (all atoms). */
export function layoutDoc(doc: ChemDoc, opts: LayoutOptions = {}) {
  const g = buildGraph(doc);
  const ri = findRings(doc, g);
  const comps = components(doc, g);
  for (const c of comps) {
    layoutComponent(doc, g, ri, c);
    applyEZ(doc, g);
    resolveClashes(doc, g, ri, c);
    orientComponent(g, c);
  }
  assignWedges(doc, g, ri);
  arrange(doc, g, comps, opts.roles ?? null);
}

function compBox(g: Graph, comp: number[]) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const id of comp) {
    const a = g.atomById.get(id)!;
    // approximate label extent (font ~0.7 bond, ~0.45 bond per character)
    let half = 0;
    if (a.label) half = 0.25 + 0.42 * a.label.length;
    else if (a.el !== "C" || g.adj.get(id)!.length === 0) half = 0.3 + (a.hCount || a.el !== "C" ? 0.45 : 0);
    minX = Math.min(minX, a.x - half); maxX = Math.max(maxX, a.x + half);
    minY = Math.min(minY, a.y - (half ? 0.35 : 0)); maxY = Math.max(maxY, a.y + (half ? 0.35 : 0));
  }
  return { minX, maxX, minY, maxY };
}
function moveComp(g: Graph, comp: number[], dx: number, dy: number) {
  for (const id of comp) { const a = g.atomById.get(id)!; a.x += dx; a.y += dy; }
}

/** Arrange existing fragments left to right (reaction scheme when roles are given). */
export function arrangeDoc(doc: ChemDoc, roles: Map<number, Role> | null) {
  const g = buildGraph(doc);
  arrange(doc, g, components(doc, g), roles);
}

function arrange(doc: ChemDoc, g: Graph, comps: number[][], roles: Map<number, Role> | null) {
  const GAP = 1.4;
  let x = 0;
  const placeRow = (cs: number[][], withPlus: boolean) => {
    cs.forEach((c, i) => {
      if (i > 0 && withPlus) {
        doc.pluses.push({ id: newId(doc), x: x + 0.3, y: 0 });
        x += 0.8;
      }
      const b = compBox(g, c);
      moveComp(g, c, x - b.minX, -(b.minY + b.maxY) / 2);
      x += b.maxX - b.minX + (withPlus ? 0.5 : GAP);
    });
  };
  if (!roles) { placeRow(comps, false); return; }
  const role = (c: number[]) => roles.get(c[0]) ?? "r";
  const R = comps.filter((c) => role(c) === "r"), A = comps.filter((c) => role(c) === "a"), Pp = comps.filter((c) => role(c) === "p");
  placeRow(R, true);
  // agents above the arrow
  let agentsW = 0;
  const agentBoxes = A.map((c) => { const b = compBox(g, c); agentsW += b.maxX - b.minX + 1; return b; });
  const arrowLen = Math.max(2.5, agentsW + 0.6);
  const ax1 = x + 0.1, ax2 = ax1 + arrowLen;
  doc.arrows.push({ id: newId(doc), x1: ax1, y1: 0, x2: ax2, y2: 0, kind: "forward" });
  let axc = ax1 + (arrowLen - agentsW + 1) / 2;
  A.forEach((c, i) => {
    const b = agentBoxes[i];
    moveComp(g, c, axc - b.minX, -0.6 - b.maxY);
    axc += b.maxX - b.minX + 1;
  });
  x = ax2 + 0.6;
  placeRow(Pp, true);
}


/** Re-layout a subset of atoms (whole components) keeping their centroid; preserves stereo. */
export function cleanComponents(doc: ChemDoc, atomIds: Set<number> | null) {
  const g = buildGraph(doc);
  const ri = findRings(doc, g);
  const comps = components(doc, g).filter((c) => !atomIds || c.some((id) => atomIds.has(id)));
  captureStereo(doc, g, ri, comps);
  for (const c of comps) {
    let cx = 0, cy = 0;
    for (const id of c) { const a = g.atomById.get(id)!; cx += a.x; cy += a.y; }
    cx /= c.length; cy /= c.length;
    for (const id of c) for (const { bond } of g.adj.get(id)!) if (bond.stereo === 1 || bond.stereo === 6) bond.stereo = 0;
    layoutComponent(doc, g, ri, c);
    applyEZ(doc, g);
    resolveClashes(doc, g, ri, c);
    orientComponent(g, c);
    moveComp(g, c, cx, cy);
  }
  assignWedges(doc, g, ri);
}

/** Record chirality/EZ implied by the current drawing as tags (inverse of layout). */
export function captureStereo(doc: ChemDoc, g: Graph, ri: RingInfo, comps: number[][]) {
  const inSet = new Set(comps.flat());
  const ranks = ecRanks(doc, g);
  for (const a of doc.atoms) {
    if (!inSet.has(a.id)) continue;
    const nbs = g.adj.get(a.id)!;
    if (!nbs.some(({ bond }) => bond.a === a.id && (bond.stereo === 1 || bond.stereo === 6))) continue;
    const order = nbs.map((x) => x.nb);
    const tag = parityFromDrawing(g, a, nbs.length === 3 ? [order[0], -1, order[1], order[2]] : order);
    if (tag) a.chiral = { tag, order: nbs.length === 3 ? [order[0], -1, order[1], order[2]] : order };
  }
  for (const b of doc.bonds) {
    if (!inSet.has(b.a) || b.order !== 2) continue;
    if (!isStereoDoubleBond(doc, g, ri, b.id, ranks)) continue;
    const ra = g.adj.get(b.a)!.find((x) => x.nb !== b.b)?.nb;
    const rb = g.adj.get(b.b)!.find((x) => x.nb !== b.a)?.nb;
    if (ra === undefined || rb === undefined) continue;
    b.ez = { ra, rb, cis: sameSide(g, b.a, b.b, ra, rb) };
  }
}

/** Position for a new substituent on atom `id` (unit vector), used by the editor. */
export function freeDirection(doc: ChemDoc, g: Graph, id: number): P {
  const a = g.atomById.get(id)!;
  const nbs = g.adj.get(id)!;
  if (!nbs.length) return { x: Math.cos(-30 * DEG), y: Math.sin(-30 * DEG) };
  const angs = nbs.map(({ nb }) => { const q = g.atomById.get(nb)!; return angOf({ x: q.x - a.x, y: q.y - a.y }); }).sort((x, y) => x - y);
  if (angs.length === 1) {
    const nb = g.atomById.get(nbs[0].nb)!;
    const alpha = angOf({ x: a.x - nb.x, y: a.y - nb.y });
    if (isLinearAt(g, id)) return { x: Math.cos(alpha), y: Math.sin(alpha) };
    // continue zigzag: look at the neighbour's own neighbour to alternate
    const nn = g.adj.get(nb.id)!.find((x) => x.nb !== id);
    let sgn = 1;
    if (nn) {
      const q = g.atomById.get(nn.nb)!;
      const cross = (a.x - nb.x) * (q.y - nb.y) - (a.y - nb.y) * (q.x - nb.x);
      sgn = cross > 0 ? 1 : -1;
    }
    const th = alpha + sgn * 60 * DEG;
    return { x: Math.cos(th), y: Math.sin(th) };
  }
  let gapStart = angs[angs.length - 1], gap = angs[0] + 2 * Math.PI - angs[angs.length - 1];
  for (let i = 1; i < angs.length; i++) if (angs[i] - angs[i - 1] > gap) { gap = angs[i] - angs[i - 1]; gapStart = angs[i - 1]; }
  const th = gapStart + gap / 2;
  return { x: Math.cos(th), y: Math.sin(th) };
}

export { docBBox, translateDoc };
export type { Atom };
