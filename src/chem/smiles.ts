// SMILES parser (incl. aromatic kekulisation, stereo, reactions) and writer.

import { ORGANIC_SUBSET, isElement, implicitHydrogens, VALENCES, atomicNumber } from "./elements";
import {
  Atom, Bond, ChemDoc, Graph, addAtom, addBond, buildGraph, emptyDoc, hydrogenCount, components,
} from "./model";
import { findRings, RingInfo, perceiveAromaticity } from "./rings";
import { ecRanks, isStereoDoubleBond, parityFromDrawing, sameSide, canonRanks } from "./stereo";

export type Role = "r" | "a" | "p";
export interface ParsedSmiles {
  doc: ChemDoc;
  roles: Map<number, Role> | null; // atom id -> reaction role
}

export class SmilesError extends Error {}

const AROMATIC_ORGANIC = new Set(["b", "c", "n", "o", "p", "s"]);

export function parseSmiles(input: string): ParsedSmiles {
  let s = input.trim();
  // CXSMILES extensions / trailing names
  const sp = s.search(/\s/);
  if (sp > 0) s = s.slice(0, sp);
  if (!s) throw new SmilesError("Empty SMILES");
  const doc = emptyDoc();
  let roles: Map<number, Role> | null = null;
  if (s.includes(">")) {
    const parts = s.split(">");
    if (parts.length !== 3) throw new SmilesError("Invalid reaction SMILES");
    roles = new Map();
    const tags: Role[] = ["r", "a", "p"];
    parts.forEach((p, i) => {
      if (!p) return;
      const before = new Set(doc.atoms.map((a) => a.id));
      parseInto(doc, p);
      for (const a of doc.atoms) if (!before.has(a.id)) roles!.set(a.id, tags[i]);
    });
  } else parseInto(doc, s);
  return { doc, roles };
}

interface DirBond { bond: Bond; from: number; to: number; ch: string }

function parseInto(doc: ChemDoc, s: string) {
  let i = 0;
  let prev: number | null = null;
  const stack: Array<number | null> = [];
  let pendingOrder: number | null = null;
  let pendingDir: string | null = null;
  const rings = new Map<number, { atom: number; order: number | null; dir: string | null; slot: number }>();
  const aromatic = new Set<number>();
  const orders = new Map<number, number[]>(); // neighbour order per atom (for chirality)
  const chiralTag = new Map<number, "@" | "@@">();
  const dirBonds: DirBond[] = [];
  const firstAtomOfPart = doc.atoms.length;

  const connect = (a: number, b: number, order: number | null, dir: string | null): Bond => {
    const arom = aromatic.has(a) && aromatic.has(b);
    const o = order ?? (arom ? 4 : 1);
    const bond = addBond(doc, a, b, o)!;
    if (dir) dirBonds.push({ bond, from: a, to: b, ch: dir });
    return bond;
  };

  const newAtom = (atom: Partial<Atom> & { el: string }, arom: boolean, chiral: "@" | "@@" | null, hBracket: number) => {
    const a = addAtom(doc, atom.el, 0, 0, atom);
    if (arom) aromatic.add(a.id);
    const ord: number[] = [];
    orders.set(a.id, ord);
    if (prev !== null) {
      connect(prev, a.id, pendingOrder, pendingDir);
      orders.get(prev)!.push(a.id);
      ord.push(prev);
    }
    if (chiral) { chiralTag.set(a.id, chiral); if (hBracket > 0) ord.push(-1); }
    pendingOrder = null; pendingDir = null;
    prev = a.id;
  };

  while (i < s.length) {
    const ch = s[i];
    if (ch === "(") { stack.push(prev); i++; continue; }
    if (ch === ")") { if (!stack.length) throw new SmilesError("Unbalanced ')'"); prev = stack.pop()!; i++; continue; }
    if (ch === ".") { prev = null; i++; continue; }
    if (ch === "-") { pendingOrder = 1; i++; continue; }
    if (ch === "=") { pendingOrder = 2; i++; continue; }
    if (ch === "#") { pendingOrder = 3; i++; continue; }
    if (ch === "$") { pendingOrder = 3; i++; continue; }
    if (ch === ":") { pendingOrder = 4; i++; continue; }
    if (ch === "/" || ch === "\\") { pendingDir = ch; i++; continue; }
    if (ch === "%" || (ch >= "0" && ch <= "9")) {
      let num: number;
      if (ch === "%") {
        if (s[i + 1] === "(") { const e = s.indexOf(")", i); num = parseInt(s.slice(i + 2, e)); i = e + 1; }
        else { num = parseInt(s.slice(i + 1, i + 3)); i += 3; }
      } else { num = +ch; i++; }
      if (prev === null) throw new SmilesError("Ring closure without atom");
      const open = rings.get(num);
      if (open) {
        rings.delete(num);
        const order = pendingOrder ?? open.order;
        const bond = connect(open.atom, prev, order, null);
        if (open.dir) dirBonds.push({ bond, from: open.atom, to: prev, ch: open.dir });
        else if (pendingDir) dirBonds.push({ bond, from: prev, to: open.atom, ch: pendingDir });
        orders.get(open.atom)![open.slot] = prev;
        orders.get(prev)!.push(open.atom);
      } else {
        const ord = orders.get(prev)!;
        rings.set(num, { atom: prev, order: pendingOrder, dir: pendingDir, slot: ord.length });
        ord.push(0);
      }
      pendingOrder = null; pendingDir = null;
      continue;
    }
    if (ch === "[") {
      const e = s.indexOf("]", i);
      if (e < 0) throw new SmilesError("Unclosed '['");
      const body = s.slice(i + 1, e);
      i = e + 1;
      const m = /^(\d+)?([A-Z][a-z]?|[a-z][a-z]?|\*)(@@|@(?:TH[12]|AL[12]|SP[123]|TB\d{1,2}|OH\d{1,2})?)?(H\d*)?([+-]{1,}\d*)?(?::(\d+))?$/.exec(body);
      if (!m) throw new SmilesError(`Bad bracket atom [${body}]`);
      let sym = m[2];
      let arom = false;
      if (sym !== "*" && sym[0] === sym[0].toLowerCase()) {
        arom = true;
        sym = sym[0].toUpperCase() + sym.slice(1);
      }
      if (sym !== "*" && !isElement(sym)) {
        // e.g. [Cl] parsed as C + l ? try one letter
        throw new SmilesError(`Unknown element ${sym}`);
      }
      const hc = m[4] ? (m[4].length > 1 ? parseInt(m[4].slice(1)) : 1) : 0;
      let charge = 0;
      if (m[5]) {
        const sign = m[5][0] === "+" ? 1 : -1;
        const digits = m[5].replace(/[+-]/g, "");
        charge = digits ? sign * parseInt(digits) : sign * m[5].length;
      }
      const chiral = m[3] === "@" || m[3] === "@@" ? (m[3] as "@" | "@@") : null;
      newAtom({ el: sym, charge, isotope: m[1] ? parseInt(m[1]) : undefined, hCount: hc, map: m[6] ? parseInt(m[6]) : undefined }, arom, chiral, hc);
      continue;
    }
    // organic subset
    let sym = "";
    if (s.startsWith("Cl", i)) sym = "Cl";
    else if (s.startsWith("Br", i)) sym = "Br";
    else if ("BCNOPSFI*".includes(ch)) sym = ch;
    else if (AROMATIC_ORGANIC.has(ch)) sym = ch;
    else throw new SmilesError(`Unexpected '${ch}' at ${i + 1}`);
    i += sym.length;
    const arom = sym === sym.toLowerCase() && sym !== "*";
    newAtom({ el: arom ? sym.toUpperCase() : sym }, arom, null, 0);
  }
  if (rings.size) throw new SmilesError("Unclosed ring");
  if (stack.length) throw new SmilesError("Unbalanced '('");

  const g = buildGraph(doc);
  kekulize(doc, g, aromatic);

  // chirality
  for (const [id, tag] of chiralTag) {
    const a = g.atomById.get(id)!;
    a.chiral = { tag, order: orders.get(id)! };
  }
  // E/Z
  for (const b of doc.bonds) {
    if (b.order !== 2) continue;
    if (doc.atoms.findIndex((a) => a.id === b.a) < firstAtomOfPart) continue;
    const dv = (x: number, end: number): number | null => {
      // dirval(x -> end)
      for (const d of dirBonds) {
        const val = d.ch === "/" ? 1 : -1;
        if (d.from === x && d.to === end) return val;
        if (d.from === end && d.to === x) return -val;
      }
      return null;
    };
    let ra = -1, va: number | null = null;
    for (const { nb } of g.adj.get(b.a)!) if (nb !== b.b) { const v = dv(nb, b.a); if (v !== null) { ra = nb; va = v; break; } }
    let rb = -1, vb: number | null = null;
    for (const { nb } of g.adj.get(b.b)!) if (nb !== b.a) { const v = dv(nb, b.b); if (v !== null) { rb = nb; vb = -v; break; } }
    if (va === null || vb === null) continue;
    // trans iff dirval(ra->a) == dirval(b->rb)
    b.ez = { ra, rb, cis: va !== vb };
  }
}

/** Assign alternating single/double bonds to aromatic (order 4) bonds. */
export function kekulize(doc: ChemDoc, g: Graph, aromaticAtoms: Set<number>) {
  const arom = doc.bonds.filter((b) => b.order === 4);
  if (!arom.length) return;
  const need = new Set<number>();
  const atoms = new Set<number>();
  for (const b of arom) { atoms.add(b.a); atoms.add(b.b); }
  for (const id of aromaticAtoms) atoms.add(id);
  for (const id of atoms) {
    const a = g.atomById.get(id)!;
    let used = 0;
    for (const { bond } of g.adj.get(id)!) used += bond.order === 4 ? 1 : bond.order;
    if (a.hCount !== undefined) used += a.hCount;
    const vals = VALENCES[a.el];
    if (!vals) continue;
    let target = vals[0];
    if (a.el === "C" || a.el === "Si") target = 4 - Math.abs(a.charge);
    else if (a.el === "B") target = 3 - a.charge;
    else target = vals[0] + a.charge;
    if (a.hCount === undefined) {
      if (target - used >= 1) need.add(id);
    } else if (target - used >= 1) need.add(id);
  }
  // adjacency among need atoms via aromatic bonds
  const nadj = new Map<number, Array<{ nb: number; bond: Bond }>>();
  for (const id of need) nadj.set(id, []);
  for (const b of arom) if (need.has(b.a) && need.has(b.b)) { nadj.get(b.a)!.push({ nb: b.b, bond: b }); nadj.get(b.b)!.push({ nb: b.a, bond: b }); }
  const list = [...need].sort((x, y) => nadj.get(x)!.length - nadj.get(y)!.length);
  const mate = new Map<number, Bond>();
  let best: Map<number, Bond> = new Map();
  let steps = 0;
  const total = list.length;
  const rec = (idx: number, unmatchedSoFar: number) => {
    if (++steps > 200000) return;
    if (best.size === total) return;
    while (idx < list.length && mate.has(list[idx])) idx++;
    if (idx >= list.length) {
      if (mate.size > best.size) best = new Map(mate);
      return;
    }
    if (total - unmatchedSoFar <= best.size) return; // bound
    const u = list[idx];
    for (const { nb, bond } of nadj.get(u)!) {
      if (mate.has(nb)) continue;
      mate.set(u, bond); mate.set(nb, bond);
      rec(idx + 1, unmatchedSoFar);
      mate.delete(u); mate.delete(nb);
      if (best.size === total) return;
    }
    rec(idx + 1, unmatchedSoFar + 1);
  };
  rec(0, 0);
  const dbl = new Set<number>();
  for (const b of best.values()) dbl.add(b.id);
  for (const b of arom) b.order = dbl.has(b.id) ? 2 : 1;
  // aromatic atoms that ended up without a double bond and need H (e.g. pyrrole written "n")
  for (const id of need) {
    const a = g.atomById.get(id)!;
    if (!best.has(id) && a.hCount !== undefined && (a.el === "N" || a.el === "P") && a.charge === 0) a.hCount += 1;
  }
}

// ------------------------------------------------------------------ writer

export interface WriteOptions { stereo?: boolean; aromatic?: boolean }

interface WCtx { ri: RingInfo; ranks: Map<number, number>; canon: Map<number, number>; aromAtoms: Set<number>; aromBonds: Set<number>; stereo: boolean }

export function writeSmiles(doc: ChemDoc, opts: WriteOptions = {}): string {
  const aromatic = opts.aromatic !== false;
  const out = writeSmilesRaw(doc, opts.stereo !== false, aromatic);
  if (!aromatic) return out;
  // safety net: aromatic output must read back to the same composition
  try {
    if (formulaKey(parseSmiles(out).doc) === formulaKey(doc)) return out;
  } catch { /* fall through */ }
  return writeSmilesRaw(doc, opts.stereo !== false, false);
}

function formulaKey(d: ChemDoc): string {
  const g = buildGraph(d);
  const c = new Map<string, number>();
  for (const a of d.atoms) { c.set(a.el, (c.get(a.el) ?? 0) + 1); c.set("H", (c.get("H") ?? 0) + hydrogenCount(g, a)); c.set("q", (c.get("q") ?? 0) + a.charge); }
  return [...c.entries()].sort().map(([k, v]) => k + v).join("");
}

function writeSmilesRaw(doc: ChemDoc, stereo: boolean, aromatic: boolean): string {
  const g = buildGraph(doc);
  const comps = components(doc, g);
  if (!comps.length) return "";
  const ri = findRings(doc, g);
  const ranks = ecRanks(doc, g);
  const ar = aromatic ? perceiveAromaticity(doc, g, ri) : { aromAtoms: new Set<number>(), aromBonds: new Set<number>() };
  const canon = canonRanks(doc, g, ar.aromAtoms, atomicNumber, (a) => hydrogenCount(g, a));
  const ctx: WCtx = { ri, ranks, canon, aromAtoms: ar.aromAtoms, aromBonds: ar.aromBonds, stereo };
  const roleOf = reactionRoles(doc, comps);
  const write = (cs: number[][]) => cs.map((c) => componentSmiles(doc, g, ctx, c)).join(".");
  if (roleOf) {
    const r = comps.filter((_, i) => roleOf[i] === "r");
    const a = comps.filter((_, i) => roleOf[i] === "a");
    const p = comps.filter((_, i) => roleOf[i] === "p");
    return `${write(r)}>${write(a)}>${write(p)}`;
  }
  // left-to-right order
  comps.sort((x, y) => cx(g, x) - cx(g, y));
  return write(comps);
}

function cx(g: Graph, comp: number[]) {
  let s = 0;
  for (const id of comp) s += g.atomById.get(id)!.x;
  return s / comp.length;
}

/** Assign reaction roles from the first arrow (null if no arrow). */
export function reactionRoles(doc: ChemDoc, comps: number[][]): Role[] | null {
  if (!doc.arrows.length) return null;
  const ar = [...doc.arrows].sort((p, q) => Math.min(p.x1, p.x2) - Math.min(q.x1, q.x2))[0];
  const g = buildGraph(doc);
  const dx = ar.x2 - ar.x1, dy = ar.y2 - ar.y1;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  return comps.map((c): Role => {
    let sx = 0, sy = 0;
    for (const id of c) { const a = g.atomById.get(id)!; sx += a.x; sy += a.y; }
    sx /= c.length; sy /= c.length;
    const t = (sx - ar.x1) * ux + (sy - ar.y1) * uy;
    let r: Role = t < 0 ? "r" : t > L ? "p" : "a";
    if (ar.kind === "retro" && r !== "a") r = r === "r" ? "p" : "r";
    return r;
  });
}

const AROM_OK = new Set(["B", "C", "N", "O", "P", "S"]);

function atomToken(a: Atom, h: number, chiral: string | null, g: Graph, arom = false): string {
  if (a.el === "*" && !a.charge && !a.isotope && !chiral && !a.map) return "*";
  const plain = !a.charge && !a.isotope && !chiral && !a.map;
  const sym = arom ? a.el.toLowerCase() : a.el;
  if (arom && plain && AROM_OK.has(a.el)) {
    // OpenSMILES aromatic implicit-H rule: valence - bonds(aromatic = 1) - 1
    let used = 0;
    for (const { bond } of g.adj.get(a.id)!) used += bond.order;
    const nArom = g.adj.get(a.id)!.length;
    void nArom;
    const v = (VALENCES[a.el] ?? [0])[0];
    const implied = Math.max(0, v - aromaticBondCount(g, a.id) - 1);
    if (h === implied) return sym;
  } else if (!arom && plain && ORGANIC_SUBSET.has(a.el)) {
    // bare atom only if SMILES' own implicit H rule gives the same count
    if (implicitHydrogens(a.el, 0, bondSumOf(g, a.id)) === h) return a.el;
  }
  let t = "[";
  if (a.isotope) t += a.isotope;
  t += sym;
  if (chiral) t += chiral;
  if (h > 0) t += "H" + (h > 1 ? h : "");
  if (a.charge) t += (a.charge > 0 ? "+" : "-") + (Math.abs(a.charge) > 1 ? Math.abs(a.charge) : "");
  if (a.map) t += ":" + a.map;
  return t + "]";
}

let curAromBonds: Set<number> = new Set();
function aromaticBondCount(g: Graph, id: number) {
  // bond-order sum where aromatic bonds count 1
  let s = 0;
  for (const { bond } of g.adj.get(id)!) s += curAromBonds.has(bond.id) ? 1 : bond.order;
  return s;
}

function bondSumOf(g: Graph, id: number) {
  let s = 0;
  for (const { bond } of g.adj.get(id)!) s += bond.order;
  return s;
}

function componentSmiles(doc: ChemDoc, g: Graph, ctx: WCtx, comp: number[]): string {
  const { ri, ranks, canon, aromAtoms, aromBonds, stereo } = ctx;
  curAromBonds = aromBonds;
  if (comp.length === 1) {
    const a = g.atomById.get(comp[0])!;
    return atomToken(a, hydrogenCount(g, a), null, g, aromAtoms.has(a.id));
  }
  // canonical start: lowest canonical rank (terminal carbon where possible)
  const deg1 = comp.filter((id) => g.adj.get(id)!.length === 1);
  const ringAtoms = comp.filter((id) => ri.atomRings.has(id));
  const pool = deg1.length ? deg1 : ringAtoms.length ? ringAtoms : comp;
  let start = pool[0];
  for (const id of pool) if (canon.get(id)! < canon.get(start)!) start = id;
  const byRank = (x: { nb: number }, y: { nb: number }) => canon.get(x.nb)! - canon.get(y.nb)!;

  // pass 1: DFS tree
  const parent = new Map<number, number>();
  const parentBond = new Map<number, Bond>();
  const children = new Map<number, number[]>();
  const ringEdges: Bond[] = [];
  const visited = new Set<number>();
  const order: number[] = [];
  const sortedAdj = new Map<number, Array<{ nb: number; bond: Bond }>>();
  // prefer traversing double/triple bonds as chain edges so ring closures land on single bonds
  const ord = (b: Bond) => (aromBonds.has(b.id) ? 1 : b.order);
  for (const id of comp) sortedAdj.set(id, g.adj.get(id)!.slice().sort((x, y) => ord(y.bond) - ord(x.bond) || byRank(x, y)));
  const st: Array<{ u: number; i: number }> = [{ u: start, i: 0 }];
  visited.add(start); order.push(start); children.set(start, []);
  const seenBond = new Set<number>();
  while (st.length) {
    const top = st[st.length - 1];
    const nbs = sortedAdj.get(top.u)!;
    if (top.i >= nbs.length) { st.pop(); continue; }
    const { nb, bond } = nbs[top.i++];
    if (seenBond.has(bond.id)) continue;
    seenBond.add(bond.id);
    if (visited.has(nb)) { ringEdges.push(bond); continue; }
    visited.add(nb); order.push(nb);
    parent.set(nb, top.u); parentBond.set(nb, bond);
    children.get(top.u)!.push(nb); children.set(nb, []);
    st.push({ u: nb, i: 0 });
  }
  const size = new Map<number, number>();
  for (let k = order.length - 1; k >= 0; k--) {
    const u = order[k];
    let s = 1;
    for (const c of children.get(u)!) s += size.get(c)!;
    size.set(u, s);
  }
  for (const ch of children.values()) ch.sort((x, y) => size.get(x)! - size.get(y)! || parentBond.get(y)!.order - parentBond.get(x)!.order || canon.get(x)! - canon.get(y)!);
  const ringAt = new Map<number, Bond[]>();
  for (const b of ringEdges) {
    if (!ringAt.has(b.a)) ringAt.set(b.a, []);
    if (!ringAt.has(b.b)) ringAt.set(b.b, []);
    ringAt.get(b.a)!.push(b); ringAt.get(b.b)!.push(b);
  }

  // E/Z direction assignment on tree bonds (value in parent->child direction)
  const dirVal = new Map<number, number>();
  if (stereo) {
    const treeParentOf = (b: Bond) => (parent.get(b.b) === b.a ? b.a : parent.get(b.a) === b.b ? b.b : null);
    for (const b of doc.bonds) {
      if (!comp.includes(b.a) || b.order !== 2) continue;
      if (!isStereoDoubleBond(doc, g, ri, b.id, ranks)) continue;
      const tp = treeParentOf(b);
      if (tp === null) continue; // double bond is a ring closure
      const u = tp, v = tp === b.a ? b.b : b.a;
      const pick = (end: number, other: number) => {
        const cands = g.adj.get(end)!.filter((x) => x.nb !== other && treeParentOf(x.bond) !== null);
        return cands.find((x) => dirVal.has(x.bond.id)) ?? cands[0];
      };
      const X = pick(u, v), Y = pick(v, u);
      if (!X || !Y) continue;
      const tpX = treeParentOf(X.bond)!;
      let dXu: number;
      if (dirVal.has(X.bond.id)) dXu = tpX === X.nb ? dirVal.get(X.bond.id)! : -dirVal.get(X.bond.id)!;
      else { dXu = 1; dirVal.set(X.bond.id, tpX === X.nb ? 1 : -1); }
      const cis = sameSide(g, u, v, X.nb, Y.nb);
      const need = cis ? -dXu : dXu; // dirval(v -> Y)
      const tpY = treeParentOf(Y.bond)!;
      if (!dirVal.has(Y.bond.id)) dirVal.set(Y.bond.id, tpY === v ? need : -need);
    }
  }

  // pass 2: emit
  const digitOf = new Map<number, number>(); // bond id -> digit
  const used = new Set<number>();
  const emitted = new Set<number>();
  const bondSym = (b: Bond, from: number): string => {
    if (aromBonds.has(b.id)) return "";
    if (b.order === 2) return "=";
    if (b.order === 3) return "#";
    const dv = dirVal.get(b.id);
    if (dv !== undefined) {
      const tp = parent.get(b.b) === b.a ? b.a : b.b;
      const v = tp === from ? dv : -dv;
      return v > 0 ? "/" : "\\";
    }
    if (b.order === 1 && aromAtoms.has(b.a) && aromAtoms.has(b.b)) return "-";
    return "";
  };
  const emit = (u: number): string => {
    emitted.add(u);
    const a = g.atomById.get(u)!;
    const h = hydrogenCount(g, a);
    // ring closure tokens and neighbour order
    const nbOrder: number[] = [];
    if (parent.has(u)) nbOrder.push(parent.get(u)!);
    let ringTok = "";
    const rb = (ringAt.get(u) ?? []).slice().sort((x, y) => {
      const ox = x.a === u ? x.b : x.a, oy = y.a === u ? y.b : y.a;
      const ex = emitted.has(ox) ? 0 : 1, ey = emitted.has(oy) ? 0 : 1;
      return ex - ey;
    });
    const ringPartners: number[] = [];
    for (const b of rb) {
      const o = b.a === u ? b.b : b.a;
      if (digitOf.has(b.id)) {
        const dg = digitOf.get(b.id)!;
        ringTok += (dg > 9 ? "%" + dg : String(dg));
        used.delete(dg);
      } else {
        let dg = 1;
        while (used.has(dg)) dg++;
        used.add(dg);
        digitOf.set(b.id, dg);
        const sym = aromBonds.has(b.id) ? "" : b.order === 2 ? "=" : b.order === 3 ? "#" : aromAtoms.has(b.a) && aromAtoms.has(b.b) ? "-" : "";
        ringTok += sym + (dg > 9 ? "%" + dg : String(dg));
      }
      ringPartners.push(o);
    }
    let chiral: string | null = null;
    if (stereo && h <= 1) {
      const hasWedge = g.adj.get(u)!.some(({ bond }) => bond.a === u && (bond.stereo === 1 || bond.stereo === 6));
      const heavy = g.adj.get(u)!.length;
      const nbRanks = g.adj.get(u)!.map((x) => ranks.get(x.nb));
      const distinct = new Set(nbRanks).size === nbRanks.length;
      if (hasWedge && heavy + h === 4 && distinct) {
        const ord = [...nbOrder];
        if (h === 1) ord.push(-1);
        ord.push(...ringPartners, ...children.get(u)!);
        chiral = parityFromDrawing(g, a, ord);
      }
    }
    let out = atomToken(a, h, chiral, g, aromAtoms.has(u)) + ringTok;
    const ch = children.get(u)!;
    ch.forEach((c, k) => {
      const piece = bondSym(parentBond.get(c)!, u) + emit(c);
      out += k < ch.length - 1 ? `(${piece})` : piece;
    });
    return out;
  };
  return emit(start);
}

export function isLikelySmiles(s: string): boolean {
  const t = s.trim();
  if (!t || /\s/.test(t) && !/^\S+\s+\|/.test(t)) return false;
  if (!/^[A-Za-z0-9@+\-\[\]\(\)\\\/=#$%:.>*]+$/.test(t.split(/\s/)[0])) return false;
  try { parseSmiles(t); return true; } catch { return false; }
}
