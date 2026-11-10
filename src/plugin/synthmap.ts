// Interactive synthesis map (Phoenix-ELN style): sequence overview + full structure graph,
// pan / zoom / pinch, run lists per step, compound panel with "next step" action.

import { MarkdownRenderChild, Menu, Notice, TFile, parseYaml, setIcon } from "obsidian";
import type ChemEditPlugin from "./main";
import { parseElnYaml } from "./eln";
import { calculateEln } from "../chem/eln";
import { parseAny, docToSmiles } from "../chem/index";
import { computeProperties } from "../chem/props";
import { buildSynthesis, bestYieldLabel, bestRoute, layoutMap, ExpInput, SynthGraph, SStep, SNode, MapLayout, RouteComp } from "../chem/synthesis";

const SVGNS = "http://www.w3.org/2000/svg";
const canonCache = new Map<string, string | null>();
export const canonSmiles = (s: string) => {
  if (!canonCache.has(s)) { try { canonCache.set(s, docToSmiles(parseAny(s, "smiles"))); } catch { canonCache.set(s, null); } }
  return canonCache.get(s)!;
};

export async function loadExperiments(plugin: ChemEditPlugin): Promise<ExpInput[]> {
  const folder = plugin.settings.elnFolder;
  const out: ExpInput[] = [];
  for (const f of plugin.app.vault.getMarkdownFiles()) {
    const fm: any = plugin.app.metadataCache.getFileCache(f)?.frontmatter;
    const tags = fm?.tags; const tagged = (Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(/[\s,]+/) : []).some((t: string) => String(t).replace(/^#/, "") === "experiment");
    if (!(folder && f.path.startsWith(folder + "/")) && !tagged) continue;
    const txt = await plugin.app.vault.cachedRead(f);
    const m = /```eln\s*\n([\s\S]*?)\n```/.exec(txt);
    if (!m) continue;
    try { const d = parseElnYaml(m[1]); out.push({ path: f.path, basename: f.basename, data: d, calc: calculateEln(d) }); } catch { /* skip */ }
  }
  return out;
}

export interface MapOptions { project?: string; focus?: string; height?: number; embedded?: boolean; view?: string }

const CW = 170, CH = 128, SWD = 132, SHT = 66, ROW = 158; // card / step geometry
const colX = (c: number) => 24 + (c >> 1) * (CW + SWD + 56) + (c & 1 ? CW + 28 : 0);
const rowY = (y: number) => 40 + y * ROW;
const segLabel = (id: number) => (id <= 26 ? String.fromCharCode(64 + id) : "S" + id);
const PALETTE = ["--color-blue", "--color-green", "--color-purple", "--color-orange", "--color-cyan", "--color-pink", "--color-yellow", "--color-red"];

export class PanZoom {
  x = 0; y = 0; k = 1; moved = false;
  onZoom: () => void = () => {};
  private pts = new Map<number, { x: number; y: number }>();
  private pinch0: { d: number; k: number; cx: number; cy: number; x: number; y: number } | null = null;
  constructor(public vp: HTMLElement, public stage: HTMLElement) {
    vp.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button,select,input")) return;
      this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.moved = false;
      if (this.pts.size === 2) { const [a, b] = [...this.pts.values()]; this.pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), k: this.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, x: this.x, y: this.y }; }
    });
    vp.addEventListener("pointermove", (e) => {
      const p = this.pts.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (!this.moved && Math.abs(dx) + Math.abs(dy) > 4) { this.moved = true; try { vp.setPointerCapture(e.pointerId); } catch { /* */ } }
      p.x = e.clientX; p.y = e.clientY;
      if (this.pts.size === 2 && this.pinch0) {
        const [a, b] = [...this.pts.values()];
        const r = vp.getBoundingClientRect();
        const k = Math.min(3, Math.max(0.1, (this.pinch0.k * Math.hypot(a.x - b.x, a.y - b.y)) / this.pinch0.d));
        const cx = this.pinch0.cx - r.left, cy = this.pinch0.cy - r.top;
        this.x = cx - ((cx - this.pinch0.x) * k) / this.pinch0.k; this.y = cy - ((cy - this.pinch0.y) * k) / this.pinch0.k; this.k = k;
        this.apply(); this.onZoom();
      } else if (this.pts.size === 1 && this.moved) { this.x += dx; this.y += dy; this.apply(); }
    });
    const up = (e: PointerEvent) => { this.pts.delete(e.pointerId); if (this.pts.size < 2) this.pinch0 = null; };
    vp.addEventListener("pointerup", up); vp.addEventListener("pointercancel", up);
    vp.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) / 2) { this.x -= e.deltaX; this.y -= e.deltaY; this.apply(); return; }
      this.zoomAt(this.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }
  zoomAt(k: number, cx: number, cy: number) {
    k = Math.min(3, Math.max(0.1, k));
    this.x = cx - ((cx - this.x) * k) / this.k; this.y = cy - ((cy - this.y) * k) / this.k; this.k = k;
    this.apply(); this.onZoom();
  }
  apply() { this.stage.setCssStyles({ transform: `translate(${this.x}px, ${this.y}px) scale(${this.k})` }); }
  fitRect(x0: number, y0: number, w: number, h: number, pad = 30, maxK = 1.1) {
    const vw = this.vp.clientWidth || 800, vh = this.vp.clientHeight || 500;
    this.k = Math.min(maxK, Math.max(0.1, Math.min((vw - 2 * pad) / Math.max(w, 1), (vh - 2 * pad) / Math.max(h, 1))));
    this.x = (vw - w * this.k) / 2 - x0 * this.k; this.y = Math.max(pad, (vh - h * this.k) / 2) - y0 * this.k;
    if (h * this.k > vh) this.y = pad - y0 * this.k;
    this.apply(); this.onZoom();
  }
}

export class SynthesisMap {
  private g!: SynthGraph;
  private lay!: MapLayout;
  private exps: ExpInput[] = [];
  private project: string;
  private selStep: string | null = null;
  private selNode: string | null = null;
  private hl = new Set<string>(); // highlighted step ids
  private hlInfo = "";
  private q = "";
  private stock = new Set<string>();
  private side!: HTMLElement;
  private outline!: HTMLElement;
  private stage!: HTMLElement;
  private pz!: PanZoom;
  private zoomSel!: HTMLSelectElement;
  private svgCache = new Map<string, string>();
  private showOutline = true;

  constructor(private plugin: ChemEditPlugin, private root: HTMLElement, private opts: MapOptions = {}) { this.project = opts.project ?? ""; }

  async load() {
    this.exps = await loadExperiments(this.plugin);
    this.stock = this.inventorySmiles();
    this.render();
  }

  private inventorySmiles() {
    const set = new Set<string>();
    const folder = (this.plugin.settings.labFolders?.inventory ?? "Inventory").replace(/\/$/, "");
    for (const f of this.plugin.app.vault.getMarkdownFiles()) {
      const fm: any = this.plugin.app.metadataCache.getFileCache(f)?.frontmatter;
      if (!fm?.smiles) continue;
      const tags = Array.isArray(fm.tags) ? fm.tags : String(fm.tags ?? "").split(/[\s,]+/);
      if (!f.path.startsWith(folder + "/") && !tags.includes("inventory")) continue;
      if (/empty/i.test(fm.status ?? "")) continue;
      const c = canonSmiles(String(fm.smiles)); if (c) set.add(c);
    }
    return set;
  }

  private struct(smiles: string, h: number): string {
    const k = smiles + "|" + h;
    if (!this.svgCache.has(k)) { try { this.svgCache.set(k, this.plugin.svgFor(parseAny(smiles), { maxHeight: h, padding: 2 })); } catch { this.svgCache.set(k, ""); } }
    return this.svgCache.get(k)!;
  }

  /** readable compound label: its name, or the molecular formula when the name is generic */
  private label(n: SNode) {
    if (n.name && !/^(p|sm|product|starting material|compound|\?)$/i.test(n.name.trim())) return n.name;
    if (n.smiles) { try { const p = computeProperties(parseAny(n.smiles), "all"); if (p) return p.formula.replace(/\d/g, (c) => "₀₁₂₃₄₅₆₇₈₉"[+c]); } catch { /* */ } }
    return "…";
  }

  private stepStatus(s: SStep) {
    if (s.runs.some((r) => /complete/i.test(r.status))) return "done";
    if (s.runs.some((r) => /running|work|purif/i.test(r.status))) return "active";
    if (s.runs.length && s.runs.every((r) => /fail/i.test(r.status))) return "failed";
    return "planned";
  }
  private best(s: SStep) { const ys = s.runs.map((r) => r.yieldPct).filter((y): y is number => y !== null && isFinite(y)); return ys.length ? Math.max(...ys) : null; }

  render() {
    const r = this.root;
    r.empty();
    r.addClass("ce-rm");
    if (this.opts.embedded) r.addClass("is-embedded");
    if (this.opts.height) r.setCssStyles({ height: this.opts.height + "px" });
    const exps = this.project ? this.exps.filter((e) => String(e.data.project ?? "") === this.project) : this.exps;
    this.g = buildSynthesis(exps, canonSmiles);
    this.lay = layoutMap(this.g);
    if (this.opts.focus && !this.selStep) { const s = this.g.steps.find((x) => x.runs.some((ru) => ru.path === this.opts.focus)); if (s) this.selStep = s.id; }

    // toolbar
    const h = r.createDiv({ cls: "ce-rm-bar" });
    const ob = h.createEl("button", { cls: "clickable-icon" + (this.showOutline ? " is-active" : ""), attr: { "aria-label": "Routes outline" } });
    setIcon(ob, "list-tree");
    ob.onclick = () => { this.showOutline = !this.showOutline; this.outline.toggleClass("is-hidden", !this.showOutline); ob.toggleClass("is-active", this.showOutline); };
    const t = h.createDiv({ cls: "ce-rm-title" });
    setIcon(t.createSpan({ cls: "ce-rm-logo" }), "route");
    const tt = t.createDiv();
    tt.createDiv({ cls: "ce-rm-titlemain", text: "Route map" });
    tt.createDiv({ cls: "ce-rm-titlesub", text: `${this.lay.comps.filter((c) => c.steps.length).length} routes · ${this.g.steps.length} steps · ${this.g.steps.reduce((a, s) => a + s.runs.length, 0)} runs · ${this.g.nodes.size} compounds` });
    const right = h.createDiv({ cls: "ce-rm-barright" });
    const search = right.createEl("input", { type: "search", cls: "ce-rm-search", value: this.q, attr: { placeholder: "Find compound / code…" } });
    search.oninput = () => { this.q = search.value.toLowerCase().trim(); this.applySearch(); };
    const projects = [...new Set(this.exps.map((e) => e.data.project).filter(Boolean))] as string[];
    if (projects.length) {
      const ps = right.createEl("select", { cls: "dropdown" });
      ps.createEl("option", { value: "", text: "All projects" });
      for (const p of projects) ps.createEl("option", { value: p, text: p });
      ps.value = this.project;
      ps.onchange = () => { this.project = ps.value; this.selStep = null; this.selNode = null; this.hl.clear(); this.render(); };
    }
    this.zoomSel = right.createEl("select", { cls: "dropdown" });
    for (const z of ["fit", "50", "75", "100", "150"]) this.zoomSel.createEl("option", { value: z, text: z === "fit" ? "Fit" : z + "%" });
    const rb = right.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Reload" } });
    setIcon(rb, "refresh-cw");
    rb.onclick = () => { this.svgCache.clear(); this.load(); };

    const body = r.createDiv({ cls: "ce-rm-body" });
    this.outline = body.createDiv({ cls: "ce-rm-outline" + (this.showOutline ? "" : " is-hidden") });
    const vp = body.createDiv({ cls: "ce-rm-vp" });
    this.side = body.createDiv({ cls: "ce-rm-side" });
    if (!this.g.steps.length) {
      this.outline.remove();
      const e = vp.createDiv({ cls: "ce-lab-emptybig" });
      setIcon(e.createDiv({ cls: "ce-lab-emptyicon" }), "route");
      e.createDiv({ text: "No connected steps yet." });
      e.createDiv({ cls: "ce-lab-muted", text: "Steps connect automatically when the product of one experiment (by structure) is the limiting reactant of another — or add  previous: [[EXP-001]]  to the eln block. “Next step” on an experiment continues a route." });
      this.drawSide();
      return;
    }
    this.drawOutline();
    this.drawGraph(vp);
    this.drawSide();
    this.zoomSel.onchange = () => { if (this.zoomSel.value === "fit") this.fitAll(); else this.pz.zoomAt(+this.zoomSel.value / 100, vp.clientWidth / 2, vp.clientHeight / 2); };
    this.pz.onZoom = () => { const v = String(Math.round(this.pz.k * 100)); this.zoomSel.value = ["50", "75", "100", "150"].includes(v) ? v : "fit"; };
    window.requestAnimationFrame(() => {
      const focusStep = this.selStep ? this.lay.stepXY.get(this.selStep) : null;
      if (focusStep) { this.pz.k = 0.9; this.pz.x = vp.clientWidth / 2 - (colX(focusStep.x) + SWD / 2) * 0.9; this.pz.y = vp.clientHeight / 2 - (rowY(focusStep.y) + CH / 2) * 0.9; this.pz.apply(); this.pz.onZoom(); }
      else this.fitAll();
    });
  }

  private fitAll() {
    const c0 = this.lay.comps[0];
    // big maps: fit the largest route by width, scroll for the rest
    const W = colX(this.lay.cols) + 40, H = rowY(this.lay.rows) + 20;
    this.pz.fitRect(0, 0, W, H, 30, 1);
    if (this.pz.k < 0.5) { this.pz.k = 0.5; this.pz.x = 20; this.pz.y = 20 - (c0 ? rowY(c0.y0) - 40 : 0) * 0.5; this.pz.apply(); this.pz.onZoom(); } // keep structures readable; pan for the rest
  }

  private drawOutline() {
    const o = this.outline;
    o.empty();
    o.createDiv({ cls: "ce-rm-oh", text: "Routes" });
    const byId = new Map(this.g.steps.map((s) => [s.id, s]));
    this.lay.comps.forEach((c, i) => {
      if (!c.steps.length) return;
      const color = `var(${PALETTE[i % PALETTE.length]})`;
      const box = o.createDiv({ cls: "ce-rm-route" });
      box.setCssStyles({ borderLeftColor: color });
      const tn = this.g.nodes.get(c.target)!;
      const head = box.createDiv({ cls: "ce-rm-routeh" });
      const th = head.createDiv({ cls: "ce-rm-routethumb" });
      if (tn.smiles) th.innerHTML = this.struct(tn.smiles, 44);
      const tx = head.createDiv({ cls: "ce-rm-routetx" });
      tx.createDiv({ cls: "ce-lab-strong ce-lab-ellipsis", text: `Route ${c.id} · ${this.label(tn)}` });
      tx.createDiv({ cls: "ce-lab-muted", text: `${c.steps.length} steps · LLS ${c.lls}${c.overall !== null ? ` · overall ${(c.overall * 100).toFixed(c.overall < 0.1 ? 1 : 0)}%` : ""}` });
      head.onclick = () => { this.highlight(c.bestPath, `Route ${c.id}: best path to target — ${c.lls} steps${c.overall !== null ? `, overall ${(c.overall * 100).toFixed(1)}%` : ""}`); this.focusComp(c); };
      const segs = this.g.seqs.filter((sq) => sq.steps.some((st) => c.steps.includes(st.id)));
      for (const sq of segs) {
        const row = box.createDiv({ cls: "ce-rm-seg" + (sq.steps.every((st) => this.hl.has(st.id)) ? " is-on" : "") });
        row.createSpan({ cls: "ce-rm-segid", text: segLabel(sq.id) });
        const a = this.g.nodes.get(sq.start)!, b = this.g.nodes.get(sq.end)!;
        row.createSpan({ cls: "ce-rm-segtx ce-lab-ellipsis", text: `${this.label(a)} → ${this.label(b)}` });
        const ys = sq.steps.map((st) => this.best(byId.get(st.id)!));
        const cum = ys.every((y) => y !== null) ? ys.reduce((p, y) => p * (y! / 100), 1) : null;
        row.createSpan({ cls: "ce-rm-segy", text: `${sq.steps.length}×${cum !== null ? " · " + Math.round(cum * 100) + "%" : ""}` });
        row.onclick = () => this.highlight(sq.steps.map((st) => st.id), `Segment ${segLabel(sq.id)}: ${sq.steps.length} steps${cum !== null ? `, cumulative ${(cum * 100).toFixed(1)}%` : ""}`);
      }
    });
  }

  private focusComp(c: RouteComp) {
    const xs = [...c.nodes.map((k) => colX(this.lay.nodeXY.get(k)!.x))];
    const x1 = Math.max(...xs) + CW;
    this.pz.fitRect(0, rowY(c.y0) - 30, x1 + 20, c.h * ROW + 40, 30, 1);
  }

  private highlight(steps: string[], info: string) {
    this.hl = new Set(steps);
    this.hlInfo = info;
    this.stage.querySelectorAll(".ce-rm-edge").forEach((e) => e.classList.toggle("is-hl", this.hl.has((e as SVGElement).dataset.step ?? "")));
    this.stage.querySelectorAll(".ce-rm-step").forEach((e) => (e as HTMLElement).toggleClass("is-hl", this.hl.has((e as HTMLElement).dataset.step ?? "")));
    this.stage.toggleClass("has-hl", this.hl.size > 0);
    this.drawOutline();
    this.drawSide();
  }

  private applySearch() {
    let first: { x: number; y: number } | null = null;
    this.stage.querySelectorAll(".ce-rm-card").forEach((el) => {
      const e = el as HTMLElement;
      const hit = !!this.q && (e.dataset.search ?? "").includes(this.q);
      e.toggleClass("is-match", hit);
      if (hit && !first) first = { x: +e.style.left.replace("px", ""), y: +e.style.top.replace("px", "") };
    });
    this.stage.toggleClass("is-searching", !!this.q);
    if (first) { const f = first as { x: number; y: number }; const vp = this.pz.vp; this.pz.x = vp.clientWidth / 2 - (f.x + CW / 2) * this.pz.k; this.pz.y = vp.clientHeight / 2 - (f.y + CH / 2) * this.pz.k; this.pz.apply(); }
  }

  private drawGraph(vp: HTMLElement) {
    const stage = (this.stage = vp.createDiv({ cls: "ce-rm-stage" }));
    const W = colX(this.lay.cols) + 60, H = rowY(this.lay.rows) + 40;
    stage.setCssStyles({ width: W + "px", height: H + "px" });
    this.pz = new PanZoom(vp, stage);
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("width", String(W)); svg.setAttribute("height", String(H)); svg.classList.add("ce-rm-edges");
    stage.appendChild(svg);
    const compOf = new Map<string, number>();
    this.lay.comps.forEach((c, i) => { for (const k of c.nodes) compOf.set(k, i); });
    // route bands
    this.lay.comps.forEach((c, i) => {
      if (!c.steps.length) return;
      const band = stage.createDiv({ cls: "ce-rm-band" });
      band.setCssStyles({ top: rowY(c.y0) - 30 + "px", height: c.h * ROW + 10 + "px", width: W - 20 + "px", borderLeftColor: `var(${PALETTE[i % PALETTE.length]})` });
      band.createSpan({ cls: "ce-rm-bandlabel", text: `Route ${c.id}` });
    });
    const byId = new Map(this.g.steps.map((s) => [s.id, s]));
    const curve = (x1: number, y1: number, x2: number, y2: number) => {
      const dx = Math.max(30, (x2 - x1) / 2);
      return Math.abs(y1 - y2) < 1 ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    };
    for (const st of this.g.steps) {
      const sp = this.lay.stepXY.get(st.id)!, a = this.lay.nodeXY.get(st.from)!, b = this.lay.nodeXY.get(st.to)!;
      const sx = colX(sp.x), sy = rowY(sp.y) + CH / 2;
      const y = this.best(st), stt = this.stepStatus(st);
      const w = (1.4 + 3.2 * ((y ?? 30) / 100)).toFixed(1);
      for (const [d, arrow] of [[curve(colX(a.x) + CW, rowY(a.y) + CH / 2, sx, sy), false], [curve(sx + SWD, sy, colX(b.x) - 6, rowY(b.y) + CH / 2), true]] as const) {
        const p = document.createElementNS(SVGNS, "path");
        p.setAttribute("d", d);
        p.classList.add("ce-rm-edge", "is-" + stt);
        if (this.hl.has(st.id)) p.classList.add("is-hl");
        p.dataset.step = st.id;
        p.setAttribute("stroke-width", w);
        if (arrow) p.setAttribute("marker-end", "url(#ce-rm-arr)");
        svg.appendChild(p);
      }
    }
    svg.insertAdjacentHTML("afterbegin", `<defs><marker id="ce-rm-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="ce-rm-arrhead"/></marker></defs>`);
    // compounds
    for (const [k, p] of this.lay.nodeXY) {
      const n = this.g.nodes.get(k)!;
      const ci = compOf.get(k) ?? 0;
      const c = stage.createDiv({ cls: "ce-rm-card" + (k === this.selNode ? " is-sel" : "") });
      c.setCssStyles({ left: colX(p.x) + "px", top: rowY(p.y) + "px", width: CW + "px", height: CH + "px", borderTopColor: `var(${PALETTE[ci % PALETTE.length]})` });
      c.dataset.search = (n.name + " " + n.smiles + " " + [...n.in, ...n.out].map((sid) => byId.get(sid)!.runs.map((r) => r.code).join(" ")).join(" ")).toLowerCase();
      const badges = c.createDiv({ cls: "ce-rm-badges" });
      if (!n.in.length) badges.createSpan({ cls: "ce-rm-badge is-sm", text: "SM" });
      if (!n.out.length) badges.createSpan({ cls: "ce-rm-badge is-target", text: "★ target" });
      if (this.stock.has(k)) badges.createSpan({ cls: "ce-rm-badge is-stock", text: "in stock" });
      const sv = c.createDiv({ cls: "ce-rm-cardstruct" });
      if (n.smiles) sv.innerHTML = this.struct(n.smiles, 84);
      if (!sv.innerHTML) sv.createDiv({ cls: "ce-rm-cardname is-big", text: n.name || "?" });
      c.createDiv({ cls: "ce-rm-cardname ce-lab-ellipsis", text: this.label(n) });
      c.onclick = (e) => { if (this.pz.moved) return; e.stopPropagation(); this.selNode = k; this.selStep = null; this.stage.querySelectorAll(".is-sel").forEach((x) => (x as HTMLElement).removeClass("is-sel")); c.addClass("is-sel"); this.drawSide(); };
    }
    // steps
    for (const st of this.g.steps) {
      const p = this.lay.stepXY.get(st.id)!;
      const y = this.best(st), stt = this.stepStatus(st);
      const focus = !!this.opts.focus && st.runs.some((r) => r.path === this.opts.focus);
      const el = stage.createDiv({ cls: `ce-rm-step is-${stt}` + (st.id === this.selStep ? " is-sel" : "") + (focus ? " is-focus" : "") + (this.hl.has(st.id) ? " is-hl" : "") });
      el.dataset.step = st.id;
      el.setCssStyles({ left: colX(p.x) + "px", top: rowY(p.y) + (CH - SHT) / 2 + "px", width: SWD + "px", height: SHT + "px" });
      const frac = y !== null ? Math.max(0, Math.min(1, y / 100)) : 0, R = 17, C = 2 * Math.PI * R;
      el.insertAdjacentHTML("beforeend", `<svg class="ce-rm-ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="${R}" class="bg"/><circle cx="22" cy="22" r="${R}" class="fg" stroke-dasharray="${(frac * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 22 22)"/><text x="22" y="26" text-anchor="middle">${y !== null ? Math.round(y) : stt === "failed" ? "✕" : "–"}</text></svg>`);
      const tx = el.createDiv({ cls: "ce-rm-steptx" });
      tx.createDiv({ cls: "ce-rm-stepid", text: `${segLabel(st.seq)}${st.idx}` });
      tx.createDiv({ cls: "ce-rm-stepsub", text: st.runs.length > 1 ? `${st.runs.length} runs` : st.runs[0]?.code ?? "" });
      if (focus) tx.createDiv({ cls: "ce-rm-stepsub is-here", text: "you are here" });
      el.onclick = (e) => { if (this.pz.moved) return; e.stopPropagation(); this.selStep = st.id; this.selNode = null; this.stage.querySelectorAll(".is-sel").forEach((x) => (x as HTMLElement).removeClass("is-sel")); el.addClass("is-sel"); this.drawSide(); };
    }
    if (this.hl.size) stage.addClass("has-hl");
    if (this.q) this.applySearch();
  }

  // ------------------------------------------------------------ side panel
  private drawSide() {
    const s = this.side;
    if (!s) return;
    s.empty();
    const app = this.plugin.app;
    const openPath = (p: string) => { const f = app.vault.getAbstractFileByPath(p); if (f instanceof TFile) app.workspace.getLeaf(false).openFile(f); };
    if (this.hlInfo && this.hl.size) {
      const b = s.createDiv({ cls: "ce-rm-hlinfo" });
      b.createSpan({ text: this.hlInfo });
      const x = b.createEl("button", { cls: "clickable-icon" }); setIcon(x, "x");
      x.onclick = () => { this.hlInfo = ""; this.highlight([], ""); };
    }
    const step = this.selStep ? this.g.steps.find((x) => x.id === this.selStep) : null;
    if (step) {
      const a = this.g.nodes.get(step.from)!, b = this.g.nodes.get(step.to)!;
      s.createDiv({ cls: "ce-rm-sideh", text: `Step ${segLabel(step.seq)}${step.idx}` });
      const mini = s.createDiv({ cls: "ce-rm-mini" });
      mini.createDiv({ cls: "ce-rm-ministruct" }).innerHTML = a.smiles ? this.struct(a.smiles, 56) : a.name;
      setIcon(mini.createSpan({ cls: "ce-rm-miniarrow" }), "arrow-right");
      mini.createDiv({ cls: "ce-rm-ministruct" }).innerHTML = b.smiles ? this.struct(b.smiles, 56) : b.name;
      const ys = step.runs.map((r) => r.yieldPct).filter((y): y is number => y !== null);
      const stats = s.createDiv({ cls: "ce-rm-stats" });
      const st = (v: string, l: string) => { const d = stats.createDiv(); d.createDiv({ cls: "ce-rm-statv", text: v }); d.createDiv({ cls: "ce-lab-muted", text: l }); };
      st(String(step.runs.length), "runs");
      st(ys.length ? Math.round(Math.max(...ys)) + "%" : "–", "best");
      st(ys.length > 1 ? Math.round(ys.reduce((p, y) => p + y, 0) / ys.length) + "%" : "–", "mean");
      const list = s.createDiv({ cls: "ce-rm-runlist" });
      for (const r of step.runs) {
        const row = list.createDiv({ cls: "ce-rm-run" + (r.path === this.opts.focus ? " is-focus" : "") });
        row.createSpan({ cls: `ce-rm-dot ce-st-${r.status.toLowerCase().replace(/[^a-z]/g, "")}` });
        const t = row.createDiv({ cls: "ce-rm-runt" });
        const l1 = t.createDiv({ cls: "ce-rm-runl1" });
        l1.createSpan({ cls: "ce-lab-strong", text: r.code });
        l1.createSpan({ cls: "ce-rm-runy", text: r.yieldPct !== null ? r.yieldPct.toFixed(1) + "%" : "—" });
        t.createDiv({ cls: "ce-lab-muted", text: [r.massMg !== null ? (r.massMg >= 1000 ? (r.massMg / 1000).toFixed(2) + " g" : r.massMg.toFixed(1) + " mg") : "", r.date, r.status].filter(Boolean).join(" · ") });
        if (r.conditions) t.createDiv({ cls: "ce-lab-muted", text: r.conditions });
        const bar = t.createDiv({ cls: "ce-rm-runbar" }); bar.createDiv().setCssStyles({ width: Math.min(100, r.yieldPct ?? 0) + "%" });
        row.onclick = () => openPath(r.path);
      }
      const nb = s.createEl("button", { cls: "mod-cta ce-rm-sidebtn", text: "+ New run of this step" });
      nb.onclick = () => this.newStepExperiment(a, b);
      return;
    }
    const node = this.selNode ? this.g.nodes.get(this.selNode) : null;
    if (node) {
      s.createDiv({ cls: "ce-rm-sideh", text: this.label(node) });
      if (node.smiles) s.createDiv({ cls: "ce-rm-sidestruct" }).innerHTML = this.struct(node.smiles, 120);
      const chips = s.createDiv({ cls: "ce-rm-badges is-static" });
      if (!node.in.length) chips.createSpan({ cls: "ce-rm-badge is-sm", text: "starting material" });
      if (!node.out.length) chips.createSpan({ cls: "ce-rm-badge is-target", text: "★ target" });
      if (this.stock.has(node.key)) chips.createSpan({ cls: "ce-rm-badge is-stock", text: "in stock" });
      if (node.in.length) {
        const br = bestRoute(this.g, node.key);
        const box = s.createDiv({ cls: "ce-rm-bestbox" });
        box.createDiv({ cls: "ce-lab-strong", text: "Best route to this compound" });
        box.createDiv({ cls: "ce-lab-muted", text: `${br.lls} steps (longest linear sequence)${br.overall !== null ? ` · overall ${(br.overall * 100).toFixed(1)}%` : " · some yields missing"}` });
        const hb = box.createEl("button", { text: "Highlight on map" });
        hb.onclick = () => this.highlight(br.steps, `Best route to ${node.name || "compound"}: ${br.lls} steps${br.overall !== null ? `, overall ${(br.overall * 100).toFixed(1)}%` : ""}`);
      }
      const byId = new Map(this.g.steps.map((x) => [x.id, x]));
      const sec = (title: string, ids: string[]) => {
        if (!ids.length) return;
        s.createDiv({ cls: "ce-rm-sidesec", text: title });
        for (const sid of ids) { const stp = byId.get(sid)!; const r = s.createDiv({ cls: "ce-rm-run" }); r.createSpan({ cls: "ce-lab-strong", text: `Step ${segLabel(stp.seq)}${stp.idx}` }); r.createSpan({ cls: "ce-lab-muted", text: " " + bestYieldLabel(stp) + ` · ${stp.runs.length} run(s)` }); r.onclick = () => { this.selStep = sid; this.selNode = null; this.drawSide(); }; }
      };
      sec("Made by", node.in); sec("Used in", node.out);
      const acts = s.createDiv({ cls: "ce-rm-sideacts" });
      acts.createEl("button", { cls: "mod-cta", text: "Next step from this compound" }).onclick = () => this.newStepExperiment(node, null);
      if (node.smiles) acts.createEl("button", { text: "Copy SMILES" }).onclick = async () => { await navigator.clipboard.writeText(node.smiles); new Notice("SMILES copied"); };
      return;
    }
    s.createDiv({ cls: "ce-rm-sideh", text: "Route map" });
    const tips = s.createDiv({ cls: "ce-rm-tips" });
    for (const [ic, tx] of [["mouse-pointer-click", "Tap a step to see every run with yield, mass and status."], ["hexagon", "Tap a compound for its best route, overall yield and where it is used."], ["list-tree", "Routes outline: tap a route for its best path, or a segment to highlight it."], ["move", "Drag to pan · scroll / pinch to zoom."]] as const) { const r = tips.createDiv({ cls: "ce-rm-tip" }); setIcon(r.createSpan(), ic); r.createSpan({ text: tx }); }
    const lg = s.createDiv({ cls: "ce-rm-legend" });
    for (const [c, l] of [["done", "completed"], ["active", "in progress"], ["planned", "planned / no yield"], ["failed", "failed"]] as const) { const r = lg.createDiv(); r.createSpan({ cls: `ce-rm-legline is-${c}` }); r.appendText(" " + l); }
    lg.createDiv({ cls: "ce-lab-muted", text: "Line width ∝ best yield. Ring = best isolated yield." });
  }

  private newStepExperiment(from: SNode, to: SNode | null) {
    const prevRun = this.g.steps.filter((x) => x.to === from.key).flatMap((x) => x.runs).sort((a, b) => (b.yieldPct ?? -1) - (a.yieldPct ?? -1))[0];
    const prevExp = prevRun ? this.exps.find((e) => e.path === prevRun.path) : null;
    const iso = prevExp?.calc.products[0];
    const data: any = {
      reactants: [{ name: from.name || "starting material", ...(from.smiles ? { smiles: from.smiles } : {}), eq: 1, is_limiting: true, ...(iso?.isoMmol ? { mmol: +iso.isoMmol.toFixed(3) } : {}) }],
      products: to ? [{ name: to.name || "product", ...(to.smiles ? { smiles: to.smiles } : {}) }] : [],
    };
    if (prevExp) data.previous = `[[${prevExp.basename}]]`;
    if (prevExp?.data.project) data.project = prevExp.data.project;
    this.plugin.newExperiment(undefined, data);
  }
}

/** ```synthesis-map block: project:, focus: [[EXP]], view: structures|sequences, height: */
export class SynthesisMapBlock extends MarkdownRenderChild {
  constructor(private plugin: ChemEditPlugin, el: HTMLElement, private source: string, private sourcePath: string) { super(el); }
  async onload() {
    let o: any = {};
    try { o = parseYaml(this.source) ?? {}; } catch { /* */ }
    const focus = o.focus ? this.plugin.app.metadataCache.getFirstLinkpathDest(String(o.focus).replace(/^\[\[|\]\]$/g, ""), this.sourcePath)?.path : undefined;
    const map = new SynthesisMap(this.plugin, this.containerEl.createDiv(), { project: o.project, focus, height: o.height ?? 560, embedded: true });
    await map.load();
  }
}

