// Synthesis-plan mind map: parse "A -> B -> C" lines into a graph and lay it out in layers.
// Cycles are allowed (back edges are drawn as loops); disconnected groups are stacked.

export type PlanKind = "link" | "smiles" | "text";
export interface PlanNode { id: string; kind: PlanKind; text: string; alias?: string; order: number }
export interface PlanEdge { from: string; to: string; label?: string; back?: boolean; dashed?: boolean }
export interface PlanGraph { nodes: Map<string, PlanNode>; edges: PlanEdge[]; errors: string[]; pos: Map<string, { x: number; y: number }>; comments: string[] }

const ARROW = /\s*(?:-\[([^\]]*)\](?:->|\.\.>)|-->|->|→|=>|\.\.>)\s*/g;
const SMILES_CHARS = /^[A-Za-z0-9@+\-[\]()=#$%./\\:*]+$/;

/** Heuristic SMILES test (a real parse is done by the caller via `isSmiles`). */
export function smilesLike(t: string): boolean {
  if (!t || /\s/.test(t) || !SMILES_CHARS.test(t) || /^\d+$/.test(t)) return false;
  return /[\d()=#[\]@]/.test(t) || /^(?:Cl|Br|[BCNOSPFI])+$/.test(t);
}

export function parsePlan(lines: string[], isSmiles: (t: string) => boolean = smilesLike): PlanGraph {
  const nodes = new Map<string, PlanNode>();
  const edges: PlanEdge[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const pos = new Map<string, { x: number; y: number }>();
  const comments: string[] = [];
  const node = (raw: string, add = true): string | null => {
    let t = raw.trim();
    if (!t) return null;
    let kind: PlanKind = "text", text = t, alias: string | undefined;
    const link = /^!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]$/.exec(t);
    if (link) { kind = "link"; text = link[1].trim(); alias = link[2]?.trim(); }
    else if (/^".*"$/.test(t)) text = t.slice(1, -1);
    else if (/^smiles:/i.test(t)) { kind = "smiles"; text = t.replace(/^smiles:\s*/i, ""); }
    else if (smilesLike(t) && isSmiles(t)) kind = "smiles";
    const id = kind + ":" + (kind === "link" ? text.toLowerCase() : text);
    if (!add) return id;
    if (!nodes.has(id)) nodes.set(id, { id, kind, text, alias, order: nodes.size });
    else if (alias && !nodes.get(id)!.alias) nodes.get(id)!.alias = alias;
    return id;
  };
  for (const raw of lines) {
    const pm = /^%%\s*@(.+?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/.exec(raw.trim());
    if (pm) { const id = node(pm[1], false); if (id) pos.set(id, { x: +pm[2], y: +pm[3] }); continue; }
    if (/^\s*(#|\/\/)/.test(raw)) { comments.push(raw.trim()); continue; }
    const line = raw.replace(/\s+%%.*$/, "").trim();
    if (!line || /^%%/.test(line)) continue;
    const parts: string[] = []; const labels: Array<{ label?: string; dashed: boolean }> = [];
    let last = 0; let m: RegExpExecArray | null;
    ARROW.lastIndex = 0;
    while ((m = ARROW.exec(line))) { parts.push(line.slice(last, m.index)); labels.push({ label: m[1]?.trim() || undefined, dashed: m[0].includes("..>") || m[0].includes("-->") }); last = m.index + m[0].length; }
    parts.push(line.slice(last));
    const ids = parts.map((p) => node(p));
    if (ids.length === 1) { if (!ids[0]) errors.push(`Cannot read “${line}”`); continue; }
    for (let i = 0; i + 1 < ids.length; i++) {
      const a = ids[i], b = ids[i + 1];
      if (!a || !b) { errors.push(`Missing node in “${line}”`); continue; }
      const key = a + "→" + b;
      if (a === b || seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: a, to: b, label: labels[i].label, dashed: labels[i].dashed });
    }
  }
  for (const k of [...pos.keys()]) if (!nodes.has(k)) pos.delete(k);
  return { nodes, edges, errors, pos, comments };
}

const OPT_KEYS = /^(path|folder|title|height|direction)\s*:/i;
/** The text token that parses back to this node. */
export function nodeToken(n: { kind: PlanKind; text: string; alias?: string }): string {
  if (n.kind === "link") return `[[${n.text}${n.alias ? "|" + n.alias : ""}]]`;
  if (n.kind === "smiles") return smilesLike(n.text) ? n.text : "smiles:" + n.text;
  const t = n.text.replace(/"/g, "'");
  return /->|→|=>|\.\.>|-\[|^\[\[|^%%|^#|^\/\//.test(t) || OPT_KEYS.test(t) || smilesLike(t) || /^smiles:/i.test(t) ? `"${t}"` : t;
}

/** Serialise a plan back to block text: options, comments, route chains, lone nodes, then manual positions. */
export function serializePlan(g: PlanGraph, opts: Record<string, string>): string {
  const out: string[] = [];
  for (const k of ["path", "title", "height"]) if (opts[k]) out.push(`${k}: ${opts[k]}`);
  out.push(...g.comments);
  const tok = (id: string) => nodeToken(g.nodes.get(id)!);
  const arrow = (e: PlanEdge) => (e.label ? ` -[${e.label.replace(/[\]\n]/g, " ")}]${e.dashed ? "..>" : "->"} ` : e.dashed ? " ..> " : " -> ");
  const outs = new Map<string, PlanEdge[]>(), ins = new Map<string, number>();
  for (const e of g.edges) { (outs.get(e.from) ?? outs.set(e.from, []).get(e.from)!).push(e); ins.set(e.to, (ins.get(e.to) ?? 0) + 1); }
  const used = new Set<PlanEdge>();
  // start chains at nodes that are not a simple pass-through
  const order = [...g.nodes.keys()].sort((a, b) => (ins.get(a) ? 1 : 0) - (ins.get(b) ? 1 : 0) || g.nodes.get(a)!.order - g.nodes.get(b)!.order);
  for (const start of order) for (const e0 of outs.get(start) ?? []) {
    if (used.has(e0)) continue;
    let line = tok(start), e: PlanEdge | undefined = e0;
    while (e && !used.has(e)) {
      used.add(e);
      line += arrow(e) + tok(e.to);
      const nx: PlanEdge[] = (outs.get(e.to) ?? []).filter((x) => !used.has(x));
      e = ins.get(e.to) === 1 && nx.length === 1 ? nx[0] : undefined;
    }
    out.push(line);
  }
  for (const e of g.edges) if (!used.has(e)) out.push(tok(e.from) + arrow(e) + tok(e.to));
  const linked = new Set(g.edges.flatMap((e) => [e.from, e.to]));
  for (const id of g.nodes.keys()) if (!linked.has(id)) out.push(tok(id));
  for (const [id, p] of g.pos) if (g.nodes.has(id)) out.push(`%% @${tok(id)} ${Math.round(p.x)} ${Math.round(p.y)}`);
  return out.join("\n");
}

export interface PlanLayout { pos: Map<string, { layer: number; row: number; comp: number }>; layers: number; comps: Array<{ ids: string[]; rows: number; layers: number }> }

/** Layered layout: DFS back-edge removal → longest-path layers → barycentre ordering; components stacked. */
export function layoutPlan(g: PlanGraph): PlanLayout {
  const ids = [...g.nodes.keys()];
  const out = new Map<string, string[]>(), inn = new Map<string, string[]>();
  ids.forEach((i) => { out.set(i, []); inn.set(i, []); });
  // back edges by DFS in declaration order
  const state = new Map<string, number>();
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const e of g.edges) if (e.from === u) {
      const s = state.get(e.to) ?? 0;
      if (s === 1) e.back = true;
      else if (s === 0) dfs(e.to);
    }
    state.set(u, 2);
  };
  // start from sources first, then anything left
  const indeg = new Map(ids.map((i) => [i, 0]));
  for (const e of g.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  for (const i of ids) if (!indeg.get(i) && !state.get(i)) dfs(i);
  for (const i of ids) if (!state.get(i)) dfs(i);
  const fwd = g.edges.filter((e) => !e.back);
  for (const e of fwd) { out.get(e.from)!.push(e.to); inn.get(e.to)!.push(e.from); }
  // longest path layering (DAG now)
  const layer = new Map<string, number>();
  const visit = (u: string): number => {
    if (layer.has(u)) return layer.get(u)!;
    layer.set(u, 0);
    const l = Math.max(0, ...inn.get(u)!.map((p) => visit(p) + 1));
    layer.set(u, l);
    return l;
  };
  ids.forEach(visit);
  // pull sources right next to their first child (avoids long dangling edges)
  for (const u of ids) if (!inn.get(u)!.length && out.get(u)!.length) layer.set(u, Math.max(0, Math.min(...out.get(u)!.map((v) => layer.get(v)!)) - 1));
  // components (undirected)
  const comp = new Map<string, number>();
  let nc = 0;
  for (const s of ids) {
    if (comp.has(s)) continue;
    const st = [s]; comp.set(s, nc);
    while (st.length) { const u = st.pop()!; for (const v of [...out.get(u)!, ...inn.get(u)!, ...g.edges.filter((e) => e.back && (e.from === u || e.to === u)).map((e) => (e.from === u ? e.to : e.from))]) if (!comp.has(v)) { comp.set(v, nc); st.push(v); } }
    nc++;
  }
  const pos = new Map<string, { layer: number; row: number; comp: number }>();
  const comps: PlanLayout["comps"] = [];
  let maxL = 0;
  for (let c = 0; c < nc; c++) {
    const cid = ids.filter((i) => comp.get(i) === c);
    const L = Math.max(...cid.map((i) => layer.get(i)!)) + 1;
    maxL = Math.max(maxL, L);
    const rows: string[][] = Array.from({ length: L }, () => []);
    for (const i of cid) rows[layer.get(i)!].push(i);
    const ord = new Map<string, number>();
    rows.forEach((r) => r.sort((a, b) => g.nodes.get(a)!.order - g.nodes.get(b)!.order).forEach((i, k) => ord.set(i, k)));
    const bary = (i: string, nb: string[]) => (nb.length ? nb.reduce((s, x) => s + ord.get(x)!, 0) / nb.length : ord.get(i)!);
    for (let sweep = 0; sweep < 6; sweep++) {
      const down = sweep % 2 === 0;
      const seq = down ? rows.keys() : [...rows.keys()].reverse();
      for (const l of seq) {
        rows[l].sort((a, b) => bary(a, down ? inn.get(a)! : out.get(a)!) - bary(b, down ? inn.get(b)! : out.get(b)!) || ord.get(a)! - ord.get(b)!);
        rows[l].forEach((i, k) => ord.set(i, k));
      }
    }
    // centre short layers against the widest
    const W = Math.max(...rows.map((r) => r.length));
    rows.forEach((r, l) => {
      // place each node near the mean row of its predecessors when possible
      const want = r.map((i) => { const p = inn.get(i)!.filter((x) => pos.has(x)); return p.length ? p.reduce((s, x) => s + pos.get(x)!.row, 0) / p.length : (W - r.length) / 2 + ord.get(i)!; });
      let prev = -1;
      r.forEach((i, k) => { const row = Math.max(prev + 1, Math.round(want[k] * 2) / 2); prev = row; pos.set(i, { layer: l, row, comp: c }); });
    });
    const r0 = Math.min(...cid.map((i) => pos.get(i)!.row));
    for (const i of cid) pos.get(i)!.row -= r0;
    const rowsN = Math.max(...cid.map((i) => pos.get(i)!.row)) + 1;
    comps.push({ ids: cid, rows: rowsN, layers: L });
  }
  return { pos, layers: maxL, comps };
}
