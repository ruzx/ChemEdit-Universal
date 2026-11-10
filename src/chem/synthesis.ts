// Synthesis map: builds a route graph from ELN experiments.
// Compound nodes are matched by canonical SMILES (or name). Each experiment is a "run" of the step
// precursor → product, where the precursor is the limiting/reference reactant, or the product of the
// experiment named in `previous:`. Steps are grouped into sequences: maximal linear chains between
// branch points (like Phoenix ELN).

import type { ElnData, ElnCalc } from "./eln";
import { str } from "./util";

export interface Run { path: string; code: string; title: string; status: string; date: string; yieldPct: number | null; massMg: number | null; conditions: string }
export interface SNode { key: string; smiles: string; name: string; layer: number; y: number; in: string[]; out: string[] }
export interface SStep { id: string; from: string; to: string; runs: Run[]; seq: number; idx: number }
export interface Seq { id: number; steps: SStep[]; start: string; end: string; kind: "start" | "middle" | "end" | "single"; layer: number; y: number }
export interface SynthGraph { nodes: Map<string, SNode>; steps: SStep[]; seqs: Seq[]; seqEdges: Array<[number, number]> }
export interface ExpInput { path: string; basename: string; data: ElnData; calc: ElnCalc }

const linkName = (v: unknown) => str(v).replace(/^\[\[|\]\]$/g, "").split("|")[0].split("/").pop()!.replace(/\.md$/, "").trim();

export function bestYieldLabel(s: SStep): string {
  const ys = s.runs.map((r) => r.yieldPct).filter((y): y is number => y !== null && isFinite(y));
  if (!ys.length) return s.runs.some((r) => /fail/i.test(r.status)) ? "failed" : "no yield";
  const best = Math.max(...ys);
  return (s.runs.length > 1 ? "≤ " : "") + Math.round(best) + "%";
}

export function buildSynthesis(exps: ExpInput[], canon: (smi: string) => string | null): SynthGraph {
  const nodes = new Map<string, SNode>();
  const keyOf = (smiles?: string, name?: string): string | null => {
    const smi = smiles ? String(smiles).trim() : "";
    if (smi) { const c = canon(smi); if (c) return c; }
    const nm = name ? String(name).trim() : "";
    return nm ? "name:" + nm.toLowerCase() : null;
  };
  const node = (key: string, smiles: string, name: string) => {
    let n = nodes.get(key);
    if (!n) nodes.set(key, (n = { key, smiles: key.startsWith("name:") ? "" : smiles, name, layer: 0, y: 0, in: [], out: [] }));
    if (!n.name && name) n.name = name;
    return n;
  };
  // product of each experiment (for `previous:` links)
  const prodKey = new Map<string, string>();
  const productOf = (e: ExpInput) => {
    const p = e.calc.products.find((x) => x.src.smiles) ?? e.calc.products.find((x) => x.src.name);
    if (!p) return null;
    const k = keyOf(p.src.smiles, p.src.name);
    return k ? { key: k, smiles: String(p.src.smiles ?? ""), name: String(p.src.name ?? ""), p } : null;
  };
  for (const e of exps) { const p = productOf(e); if (p) { prodKey.set(e.basename.toLowerCase(), p.key); if (e.data.code) prodKey.set(String(e.data.code).toLowerCase(), p.key); } }

  const steps = new Map<string, SStep>();
  for (const e of exps) {
    const prod = productOf(e);
    if (!prod) continue;
    let from: string | null = null, fromSmi = "", fromName = "";
    const prev = e.data.previous ?? e.data.from_experiment;
    if (prev) {
      const pk = prodKey.get(linkName(Array.isArray(prev) ? prev[0] : prev).toLowerCase());
      if (pk) { from = pk; const n = nodes.get(pk); fromSmi = n?.smiles ?? ""; fromName = n?.name ?? ""; }
    }
    if (!from) {
      const rows = e.calc.rows.filter((r) => r.role === "reactant");
      const r = rows.find((x) => x.limiting && (x.src.smiles || x.src.name)) ?? rows.find((x) => x.src.smiles) ?? rows.find((x) => x.src.name);
      if (r) { from = keyOf(r.src.smiles, r.src.name); fromSmi = String(r.src.smiles ?? ""); fromName = String(r.src.name ?? ""); }
    }
    if (!from || from === prod.key) continue;
    node(from, fromSmi, fromName);
    node(prod.key, prod.smiles, prod.name);
    const id = from + ">>" + prod.key;
    let s = steps.get(id);
    if (!s) steps.set(id, (s = { id, from, to: prod.key, runs: [], seq: 0, idx: 0 }));
    const ey = typeof prod.p.src.yield === "number" ? prod.p.src.yield : parseFloat(String(prod.p.src.yield ?? ""));
    const y = isFinite(ey) ? ey : prod.p.yieldPct;
    s.runs.push({
      path: e.path, code: String(e.data.code ?? e.basename), title: String(e.data.title ?? ""), status: String(e.data.status ?? "Planned"), date: String(e.data.date ?? ""),
      yieldPct: y !== null && isFinite(y) ? y : null, massMg: prod.p.isoMass,
      conditions: [e.data.solvent, e.data.temperature, e.data.duration].filter(Boolean).join(", "),
    });
  }
  const stepList = [...steps.values()];
  for (const s of stepList) { nodes.get(s.from)!.out.push(s.id); nodes.get(s.to)!.in.push(s.id); }
  for (const s of stepList) s.runs.sort((a, b) => (b.yieldPct ?? -1) - (a.yieldPct ?? -1));

  // ---- layering: longest path from sources (cycle-safe)
  const byId = new Map(stepList.map((s) => [s.id, s]));
  const state = new Map<string, number>(); // 1 visiting, 2 done
  const depth = (k: string): number => {
    const n = nodes.get(k)!;
    if (state.get(k) === 2) return n.layer;
    if (state.get(k) === 1) return 0;
    state.set(k, 1);
    let d = 0;
    for (const sid of n.in) d = Math.max(d, depth(byId.get(sid)!.from) + 1);
    n.layer = d;
    state.set(k, 2);
    return d;
  };
  for (const k of nodes.keys()) depth(k);
  // pull sources right next to their first child (so side-branches don't start far left)
  for (const n of nodes.values()) if (!n.in.length && n.out.length) n.layer = Math.max(n.layer, Math.min(...n.out.map((sid) => nodes.get(byId.get(sid)!.to)!.layer)) - 1);

  // ---- sequences (maximal chains through pass-through nodes)
  const pass = (k: string) => { const n = nodes.get(k)!; return n.in.length === 1 && n.out.length === 1; };
  const seqs: Seq[] = [];
  const used = new Set<string>();
  const chainFrom = (s0: SStep) => {
    const chain: SStep[] = [s0];
    used.add(s0.id);
    let cur = s0;
    while (pass(cur.to)) {
      const nx = byId.get(nodes.get(cur.to)!.out[0])!;
      if (used.has(nx.id)) break;
      chain.push(nx); used.add(nx.id); cur = nx;
    }
    return chain;
  };
  const starts = stepList.filter((s) => !pass(s.from)).sort((a, b) => nodes.get(a.from)!.layer - nodes.get(b.from)!.layer);
  const chains: SStep[][] = [];
  for (const s of starts) if (!used.has(s.id)) chains.push(chainFrom(s));
  for (const s of stepList) if (!used.has(s.id)) chains.push(chainFrom(s)); // pure cycles
  chains.forEach((c, i) => {
    c.forEach((s, j) => { s.seq = i + 1; s.idx = j + 1; });
    seqs.push({ id: i + 1, steps: c, start: c[0].from, end: c[c.length - 1].to, kind: "middle", layer: 0, y: 0 });
  });
  const seqEdges: Array<[number, number]> = [];
  for (const a of seqs) for (const b of seqs) if (a !== b && a.end === b.start) seqEdges.push([a.id, b.id]);
  for (const s of seqs) {
    const hasIn = seqEdges.some((e) => e[1] === s.id), hasOut = seqEdges.some((e) => e[0] === s.id);
    s.kind = !hasIn && !hasOut ? "single" : !hasIn ? "start" : !hasOut ? "end" : "middle";
  }
  // sequence layers (longest path)
  const sl = new Map<number, number>();
  const sdepth = (id: number, seen = new Set<number>()): number => {
    if (sl.has(id)) return sl.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    let d = 0;
    for (const [a, b] of seqEdges) if (b === id) d = Math.max(d, sdepth(a, seen) + 1);
    sl.set(id, d);
    return d;
  };
  for (const s of seqs) s.layer = sdepth(s.id);

  // ---- vertical placement (barycentre + spacing), generic for both graphs
  const place = <T extends { layer: number; y: number }>(items: T[], parents: (t: T) => T[], children: (t: T) => T[]) => {
    const layers = new Map<number, T[]>();
    for (const it of items) { if (!layers.has(it.layer)) layers.set(it.layer, []); layers.get(it.layer)!.push(it); }
    const L = [...layers.keys()].sort((a, b) => a - b);
    const spread = (arr: T[], want: (t: T) => number) => {
      const w = new Map(arr.map((t) => [t, want(t)]));
      arr.sort((a, b) => w.get(a)! - w.get(b)!);
      let last = -Infinity;
      for (const t of arr) { t.y = Math.max(w.get(t)!, last + 1); last = t.y; }
      const shift = arr.reduce((s, t) => s + w.get(t)! - t.y, 0) / arr.length;
      if (shift > 0) for (const t of arr) t.y += shift;
      // keep ≥ 1 apart after the shift
      for (let i = 1; i < arr.length; i++) if (arr[i].y < arr[i - 1].y + 1) arr[i].y = arr[i - 1].y + 1;
    };
    layers.get(L[0])?.forEach((t, i) => (t.y = i));
    for (let pass2 = 0; pass2 < 3; pass2++) {
      for (const l of L.slice(1)) spread(layers.get(l)!, (t) => { const p = parents(t); return p.length ? p.reduce((s, x) => s + x.y, 0) / p.length : t.y; });
      for (const l of [...L].reverse().slice(1)) spread(layers.get(l)!, (t) => { const c = children(t); return c.length ? c.reduce((s, x) => s + x.y, 0) / c.length : t.y; });
    }
    const min = Math.min(...items.map((t) => t.y));
    for (const t of items) t.y -= min;
  };
  const nl = [...nodes.values()];
  place(nl, (n) => n.in.map((sid) => nodes.get(byId.get(sid)!.from)!), (n) => n.out.map((sid) => nodes.get(byId.get(sid)!.to)!));
  const sById = new Map(seqs.map((s) => [s.id, s]));
  place(seqs, (s) => seqEdges.filter((e) => e[1] === s.id).map((e) => sById.get(e[0])!), (s) => seqEdges.filter((e) => e[0] === s.id).map((e) => sById.get(e[1])!));
  return { nodes, steps: stepList, seqs, seqEdges };
}

// ======================================================================= route-map layout & analytics

export interface RouteComp { id: number; nodes: string[]; steps: string[]; y0: number; h: number; lls: number; target: string; overall: number | null; bestPath: string[] }
export interface MapLayout { comps: RouteComp[]; nodeXY: Map<string, { x: number; y: number }>; stepXY: Map<string, { x: number; y: number }>; cols: number; rows: number }

const yieldOf = (s: SStep) => { const ys = s.runs.map((r) => r.yieldPct).filter((y): y is number => y !== null && isFinite(y)); return ys.length ? Math.max(...ys) / 100 : null; };

/** Best (highest cumulative yield) path of steps ending at `target`; unknown yields count as 50 % for ranking. */
export function bestRoute(g: SynthGraph, target: string): { steps: string[]; overall: number | null; lls: number } {
  const byId = new Map(g.steps.map((s) => [s.id, s]));
  const memo = new Map<string, { score: number; known: number | null; steps: string[] }>();
  const go = (k: string, seen: Set<string>): { score: number; known: number | null; steps: string[] } => {
    if (memo.has(k)) return memo.get(k)!;
    const n = g.nodes.get(k)!;
    let best = { score: 1, known: 1 as number | null, steps: [] as string[] };
    let first = true;
    for (const sid of n.in) {
      const s = byId.get(sid)!;
      if (seen.has(s.from)) continue;
      const prev = go(s.from, new Set([...seen, k]));
      const y = yieldOf(s);
      const cand = { score: prev.score * (y ?? 0.5), known: prev.known !== null && y !== null ? prev.known * y : null, steps: [...prev.steps, sid] };
      if (first || cand.steps.length > best.steps.length || (cand.steps.length === best.steps.length && cand.score > best.score)) { best = cand; first = false; }
    }
    memo.set(k, best);
    return best;
  };
  const r = go(target, new Set());
  return { steps: r.steps, overall: r.steps.length ? r.known : null, lls: r.steps.length };
}

export function layoutMap(g: SynthGraph): MapLayout {
  const byId = new Map(g.steps.map((s) => [s.id, s]));
  // connected components (union-find)
  const parent = new Map<string, string>();
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  for (const k of g.nodes.keys()) parent.set(k, k);
  for (const s of g.steps) parent.set(find(s.from), find(s.to));
  const groups = new Map<string, string[]>();
  for (const k of g.nodes.keys()) { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(k); }
  const comps = [...groups.values()].map((nodes) => ({ nodes, steps: g.steps.filter((s) => nodes.includes(s.from)).map((s) => s.id) }))
    .sort((a, b) => b.steps.length - a.steps.length);

  type Item = { id: string; kind: "n" | "s"; col: number; layer: number; y: number };
  const nodeXY = new Map<string, { x: number; y: number }>(), stepXY = new Map<string, { x: number; y: number }>();
  const out: RouteComp[] = [];
  let yOff = 0, maxCol = 0;
  comps.forEach((c, ci) => {
    const minL = Math.min(...c.nodes.map((k) => g.nodes.get(k)!.layer));
    const items = new Map<string, Item>();
    for (const k of c.nodes) items.set("n:" + k, { id: k, kind: "n", col: 2 * (g.nodes.get(k)!.layer - minL), layer: 0, y: 0 });
    for (const sid of c.steps) { const s = byId.get(sid)!; items.set("s:" + sid, { id: sid, kind: "s", col: 2 * (g.nodes.get(s.to)!.layer - minL) - 1, layer: 0, y: 0 }); }
    for (const it of items.values()) it.layer = it.col;
    const parents = (it: Item): Item[] => it.kind === "s" ? [items.get("n:" + byId.get(it.id)!.from)!] : g.nodes.get(it.id)!.in.map((sid) => items.get("s:" + sid)!).filter(Boolean);
    const children = (it: Item): Item[] => it.kind === "s" ? [items.get("n:" + byId.get(it.id)!.to)!] : g.nodes.get(it.id)!.out.map((sid) => items.get("s:" + sid)!).filter(Boolean);
    placeLayers([...items.values()], parents, children);
    let maxY = 0;
    for (const it of items.values()) {
      (it.kind === "n" ? nodeXY : stepXY).set(it.id, { x: it.col, y: it.y + yOff });
      maxY = Math.max(maxY, it.y); maxCol = Math.max(maxCol, it.col);
    }
    // main target: sink with the longest route
    const sinks = c.nodes.filter((k) => !g.nodes.get(k)!.out.length);
    let best = { k: c.nodes[0], r: { steps: [] as string[], overall: null as number | null, lls: 0 } };
    for (const k of sinks) { const r = bestRoute(g, k); if (r.lls > best.r.lls || (r.lls === best.r.lls && (r.overall ?? 0) > (best.r.overall ?? 0))) best = { k, r }; }
    out.push({ id: ci + 1, nodes: c.nodes, steps: c.steps, y0: yOff, h: maxY + 1, lls: best.r.lls, target: best.k, overall: best.r.overall, bestPath: best.r.steps });
    yOff += maxY + 1.7;
  });
  // renumber segments route by route, left → right, top → bottom (A, B, C … read naturally on the map)
  const order = [...g.seqs].sort((a, b) => {
    const ca = out.findIndex((c) => c.nodes.includes(a.start)), cb = out.findIndex((c) => c.nodes.includes(b.start));
    if (ca !== cb) return ca - cb;
    const pa = stepXY.get(a.steps[0].id)!, pb = stepXY.get(b.steps[0].id)!;
    return pa.x - pb.x || pa.y - pb.y;
  });
  const remap = new Map(order.map((sq, i) => [sq.id, i + 1]));
  for (const sq of g.seqs) { sq.id = remap.get(sq.id)!; for (const st of sq.steps) st.seq = sq.id; }
  g.seqEdges = g.seqEdges.map(([a, b]) => [remap.get(a)!, remap.get(b)!] as [number, number]);
  g.seqs.sort((a, b) => a.id - b.id);
  return { comps: out, nodeXY, stepXY, cols: maxCol + 1, rows: yOff };
}

function placeLayers<T extends { layer: number; y: number }>(items: T[], parents: (t: T) => T[], children: (t: T) => T[]) {
  const layers = new Map<number, T[]>();
  for (const it of items) { if (!layers.has(it.layer)) layers.set(it.layer, []); layers.get(it.layer)!.push(it); }
  const L = [...layers.keys()].sort((a, b) => a - b);
  const spread = (arr: T[], want: (t: T) => number) => {
    const w = new Map(arr.map((t) => [t, want(t)]));
    arr.sort((a, b) => w.get(a)! - w.get(b)!);
    let last = -Infinity;
    for (const t of arr) { t.y = Math.max(w.get(t)!, last + 1); last = t.y; }
    const shift = arr.reduce((s, t) => s + w.get(t)! - t.y, 0) / arr.length;
    for (const t of arr) t.y += shift;
    for (let i = 1; i < arr.length; i++) if (arr[i].y < arr[i - 1].y + 1) arr[i].y = arr[i - 1].y + 1;
  };
  layers.get(L[0])?.forEach((t, i) => (t.y = i));
  const avg = (a: T[], d: number) => (a.length ? a.reduce((s, x) => s + x.y, 0) / a.length : d);
  for (let p = 0; p < 4; p++) {
    for (const l of L.slice(1)) spread(layers.get(l)!, (t) => avg(parents(t), t.y));
    for (const l of [...L].reverse().slice(1)) spread(layers.get(l)!, (t) => avg(children(t), t.y));
  }
  for (const l of L.slice(1)) spread(layers.get(l)!, (t) => avg(parents(t), t.y));
  const min = Math.min(...items.map((t) => t.y));
  for (const t of items) t.y = Math.round((t.y - min) * 100) / 100;
}
