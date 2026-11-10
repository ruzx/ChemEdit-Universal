// ```synthesis-plan``` — a free-form route mind map written as arrows:
//   path: ELN
//   [[EXP-001]] -> [[EXP-002]] -> [[EXP-003]]
//   C1=CC=CC=C1 -[HNO3, H2SO4]-> Intermediate -> [[EXP-005]]
// Experiment links become cards (product, status, yield), SMILES become structures,
// anything else is a label. Cycles are allowed. Drag to pan, scroll / pinch to zoom.

import { App, FuzzySuggestModal, MarkdownPostProcessorContext, MarkdownRenderChild, Menu, Notice, TFile, debounce, setIcon } from "obsidian";
import type ChemEditPlugin from "./main";
import { parseElnYaml } from "./eln";
import { calculateEln } from "../chem/eln";
import { parseAny } from "../chem/index";
import { stripCarbonHydrogens } from "../chem/model";
import { parsePlan, layoutPlan, smilesLike, serializePlan, nodeToken, PlanNode, PlanGraph } from "../chem/plan";
import { PanZoom } from "./synthmap";
import { blockOptions, cleanFolder, writeBlockBody } from "./blockopts";
import { PromptModal } from "./eln";
import { nmrBlock } from "./nmrview";
import { setSvg, setSvgChildren } from "../render/dom";
import { str } from "../chem/util";

const KEYS = ["path", "folder", "title", "height", "direction"];
const NW = 172, GAPX = 92, ROWH = 156, GAPC = 36;
const SVGNS = "http://www.w3.org/2000/svg";

interface NodeInfo { file: TFile | null; code?: string; title?: string; status?: string; smiles?: string; yieldPct?: number | null; missing?: boolean }

const okSmiles = (t: string) => { try { return parseAny(t, "smiles").atoms.length > 0; } catch { return false; } };

export class SynthesisPlanBlock extends MarkdownRenderChild {
  private folder = "";
  private files = new Set<string>();
  constructor(private plugin: ChemEditPlugin, el: HTMLElement, private src: string, private ctx: MarkdownPostProcessorContext) { super(el); }

  onload() {
    const rerender = debounce(() => { void this.render(); }, 800, true);
    this.registerEvent(this.plugin.app.metadataCache.on("changed", (f) => { if (this.files.has(f.path)) rerender(); }));
    void this.render();
  }

  private resolve(name: string): TFile | null {
    const app = this.plugin.app;
    const base = name.split("/").pop()!.replace(/\.md$/, "").toLowerCase();
    if (this.folder) {
      const hit = app.vault.getMarkdownFiles().find((f) => f.path.startsWith(this.folder + "/") && f.basename.toLowerCase() === base);
      if (hit) return hit;
    }
    return app.metadataCache.getFirstLinkpathDest(name, this.ctx.sourcePath);
  }

  private async info(f: TFile | null): Promise<NodeInfo> {
    if (!f) return { file: null, missing: true };
    const app = this.plugin.app;
    const fm = (app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as Record<string, unknown>;
    const txt = await app.vault.cachedRead(f);
    const m = /```eln\s*\n([\s\S]*?)\n```/.exec(txt);
    if (m) {
      try {
        const d = parseElnYaml(m[1]); const c = calculateEln(d);
        const p = c.products.find((x) => x.src.smiles) ?? c.products[0];
        return { file: f, code: d.code ?? f.basename, title: d.title ?? p?.src.name, status: d.status ?? "Planned", smiles: p?.src.smiles ? String(p.src.smiles) : undefined, yieldPct: c.products[0]?.yieldPct ?? null };
      } catch { /* fall through */ }
    }
    const sm = fm.smiles ? str(fm.smiles) : /```smiles\s*\n([^\n]+)/.exec(txt)?.[1]?.trim();
    return { file: f, code: f.basename, title: str(fm.title) || str(fm.name) || undefined, status: str(fm.status) || undefined, smiles: sm };
  }

  // ------------------------------------------------------------------ rendering

  private async render() {
    const el = this.containerEl;
    const { opts, rest } = blockOptions(this.src, el, this.ctx, KEYS);
    this.opts = opts;
    this.folder = cleanFolder(opts.path ?? opts.folder);
    const g = parsePlan(rest, okSmiles);
    this.g = g;
    // bare labels that match a note in `path:` are shown as links (the text stays a label)
    const asLink = new Set<string>();
    if (this.folder) for (const n of g.nodes.values()) if (n.kind === "text" && this.resolve(n.text)?.path.startsWith(this.folder + "/")) asLink.add(n.id);
    const isLink = (n: PlanNode) => n.kind === "link" || asLink.has(n.id);
    const st = this.state();
    // node data (async) before touching the DOM, so re-renders don't flicker
    const info = new Map<string, NodeInfo>();
    this.files.clear();
    await Promise.all([...g.nodes.values()].filter(isLink).map(async (n) => { const f = this.resolve(n.text); if (f) this.files.add(f.path); info.set(n.id, await this.info(f)); }));

    el.empty();
    const root = el.createDiv({ cls: "ce-sp" + (st.edit ? " is-editing" : "") });
    const head = root.createDiv({ cls: "ce-sp-head" });
    const t = head.createDiv({ cls: "ce-sp-title" });
    setIcon(t.createSpan({ cls: "ce-sp-ico" }), "git-fork");
    t.createSpan({ text: opts.title || "Synthesis plan" });
    if (this.folder) head.createSpan({ cls: "ce-sp-sub", text: "📁 " + this.folder });
    const tools = head.createDiv({ cls: "ce-sp-tools" });
    const editBtn = tools.createEl("button", { cls: "ce-sp-editbtn" + (st.edit ? " mod-cta" : ""), attr: { "aria-label": st.edit ? "Finish editing" : "Edit the map visually" } });
    setIcon(editBtn.createSpan(), st.edit ? "check" : "pencil");
    editBtn.createSpan({ text: st.edit ? "Done" : "Edit" });
    editBtn.onclick = () => { st.edit = !st.edit; st.sel = null; void this.render(); };

    // edit toolbar
    let actions: HTMLElement | null = null;
    if (st.edit) {
      const bar = root.createDiv({ cls: "ce-sp-editbar" });
      const add = (icon: string, label: string, run: () => void) => { const b = bar.createEl("button", { cls: "ce-sp-tool" }); setIcon(b.createSpan(), icon); b.createSpan({ text: label }); b.onclick = run; return b; };
      add("type", "Label", () => this.prompt("New node", "Text, [[note]] or SMILES", "", (v) => this.addNode(v)));
      add("hexagon", "Structure", () => this.plugin.openEditor(null, (r) => this.addNode(r.smiles), { title: "New structure node", saveLabel: "Add" }));
      add("flask-conical", "Experiment", () => new NotePicker(this.plugin.app, this.folder || this.plugin.settings.elnFolder, (f) => this.addNode(`[[${f.basename}]]`)).open());
      add("layout-dashboard", "Auto-layout", () => { g.pos.clear(); void this.save(); });
      actions = bar.createDiv({ cls: "ce-sp-actions" });
      root.createDiv({ cls: "ce-sp-hint", text: "Drag a node to move it · drag its ● handle onto another node to connect (or onto empty space to create one) · tap a node or arrow to select · double-click to rename · Delete removes." });
    }

    if (!g.nodes.size) {
      root.createDiv({ cls: "ce-sp-empty", text: st.edit ? "Empty map — add a node with the buttons above." : "Write steps as arrows, one route per line:  [[EXP-001]] -> [[EXP-002]]  ·  CCO -[PCC]-> CC=O  ·  Idea -> [[EXP-007]] — or press Edit to draw the map." });
      return;
    }
    const lay = layoutPlan(g);
    // geometry
    const hOf = (n: PlanNode) => n.kind === "smiles" ? 118 : isLink(n) ? (info.get(n.id)?.smiles ? 150 : 74) : 46;
    const xy = new Map<string, { x: number; y: number; w: number; h: number }>();
    const gap = new Array(lay.layers + 1).fill(GAPX);
    for (const e of g.edges) if (e.label && !e.back) { const la = lay.pos.get(e.from)!.layer; gap[la] = Math.max(gap[la], Math.min(260, e.label.length * 6.4 + 34)); }
    const colX: number[] = [20];
    for (let l = 1; l <= lay.layers; l++) colX[l] = colX[l - 1] + NW + gap[l - 1];
    let y0 = 20;
    for (const c of lay.comps) {
      for (const id of c.ids) {
        const p = lay.pos.get(id)!; const h = hOf(g.nodes.get(id)!);
        const man = g.pos.get(id);
        xy.set(id, man ? { x: man.x, y: man.y, w: NW, h } : { x: colX[p.layer], y: y0 + p.row * ROWH + (ROWH - 16 - h) / 2, w: NW, h });
      }
      y0 += c.rows * ROWH + GAPC;
    }
    const extent = () => { let mx = 0, my = 0; for (const b of xy.values()) { mx = Math.max(mx, b.x + b.w); my = Math.max(my, b.y + b.h); } return { W: mx + 40, H: my + 60 }; };
    let { W, H } = extent();
    const height = parseInt(opts.height ?? "") || Math.min(640, Math.max(st.edit ? 380 : 240, H * Math.min(1, 900 / W) + 30));
    const vp = root.createDiv({ cls: "ce-rm-vp ce-sp-vp" });
    vp.setCssStyles({ height: height + "px" });
    vp.tabIndex = 0;
    const stage = vp.createDiv({ cls: "ce-rm-stage" });
    stage.setCssStyles({ width: W + "px", height: H + "px" });
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "ce-sp-edges");
    stage.appendChild(svg);
    const cards = new Map<string, HTMLElement>();
    const edgeEls: Array<{ el: SVGElement; a: string; b: string }> = [];

    const drawEdges = () => {
      ({ W, H } = extent());
      svg.setAttribute("width", String(W)); svg.setAttribute("height", String(H + 60));
      setSvgChildren(svg, `<defs><marker id="ce-sp-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ce-sp-ahp" d="M0,0L10,5L0,10z"/></marker><marker id="ce-sp-ahb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ce-sp-ahp is-back" d="M0,0L10,5L0,10z"/></marker></defs>`);
      edgeEls.length = 0;
      g.edges.forEach((e, k) => {
        const A = xy.get(e.from)!, B = xy.get(e.to)!;
        let d: string, lx: number, ly: number;
        const loop = !!e.back;
        if (loop) {
          const yb = Math.max(A.y + A.h, B.y + B.h) + 26;
          const ax = A.x + A.w / 2, bx = B.x + B.w / 2;
          d = `M${ax},${A.y + A.h} C${ax},${yb + 20} ${bx},${yb + 20} ${bx},${B.y + B.h + 2}`;
          lx = (ax + bx) / 2; ly = yb + 12;
        } else {
          // pick ports by direction: side → side, or bottom → top
          const ca = { x: A.x + A.w / 2, y: A.y + A.h / 2 }, cb = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
          const dx = cb.x - ca.x, dy = cb.y - ca.y;
          let p1, p2, c1, c2;
          if (Math.abs(dx) >= Math.abs(dy) * 0.8 || Math.abs(dx) > A.w) {
            const sg = Math.sign(dx) || 1;
            p1 = { x: sg > 0 ? A.x + A.w : A.x, y: ca.y }; p2 = { x: sg > 0 ? B.x - 3 : B.x + B.w + 3, y: cb.y };
            const kk = Math.max(30, Math.abs(p2.x - p1.x) * 0.5);
            c1 = { x: p1.x + sg * kk, y: p1.y }; c2 = { x: p2.x - sg * kk, y: p2.y };
          } else {
            const sg = Math.sign(dy) || 1;
            p1 = { x: ca.x, y: sg > 0 ? A.y + A.h : A.y }; p2 = { x: cb.x, y: sg > 0 ? B.y - 3 : B.y + B.h + 3 };
            const kk = Math.max(24, Math.abs(p2.y - p1.y) * 0.45);
            c1 = { x: p1.x, y: p1.y + sg * kk }; c2 = { x: p2.x, y: p2.y - sg * kk };
          }
          d = `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
          lx = (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8; ly = (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8 - 6;
        }
        const sel = st.sel === "e" + k;
        if (st.edit) {
          const hit = document.createElementNS(SVGNS, "path");
          hit.setAttribute("d", d); hit.setAttribute("class", "ce-sp-ehit"); hit.dataset.edge = String(k);
          svg.appendChild(hit);
        }
        const p = document.createElementNS(SVGNS, "path");
        p.setAttribute("d", d);
        p.setAttribute("class", "ce-sp-edge" + (loop ? " is-back" : "") + (e.dashed ? " is-dashed" : "") + (sel ? " is-sel" : ""));
        p.setAttribute("marker-end", `url(#${loop ? "ce-sp-ahb" : "ce-sp-ah"})`);
        svg.appendChild(p);
        edgeEls.push({ el: p, a: e.from, b: e.to });
        if (e.label) {
          const tx = document.createElementNS(SVGNS, "text");
          tx.setAttribute("x", String(lx)); tx.setAttribute("y", String(ly)); tx.setAttribute("text-anchor", "middle"); tx.setAttribute("class", "ce-sp-elabel");
          tx.textContent = e.label; svg.appendChild(tx);
          edgeEls.push({ el: tx, a: e.from, b: e.to });
        }
      });
      stage.setCssStyles({ width: W + "px", height: H + "px" });
    };

    const svgCache = new Map<string, string>();
    const structure = (host: HTMLElement, smi: string, h: number) => {
      const s = host.createDiv({ cls: "ce-sp-struct" });
      try {
        const key = smi + "|" + h;
        if (!svgCache.has(key)) svgCache.set(key, this.plugin.svgFor(stripCarbonHydrogens(parseAny(smi)), { maxHeight: h, padding: 2 }));
        setSvg(s, svgCache.get(key)!);
      } catch { s.addClass("is-error"); s.setText(smi); }
    };
    const pz = new PanZoom(vp, stage);
    for (const n of g.nodes.values()) {
      const b = xy.get(n.id)!;
      const c = stage.createDiv({ cls: `ce-sp-node is-${isLink(n) ? "link" : n.kind}` + (st.sel === "n" + n.id ? " is-sel" : "") });
      c.dataset.id = n.id;
      c.setCssStyles({ left: b.x + "px", top: b.y + "px", width: b.w + "px", height: b.h + "px" });
      cards.set(n.id, c);
      const inf = info.get(n.id);
      if (!isLink(n)) {
        if (n.kind === "smiles") structure(c, n.text, 92); else c.createDiv({ cls: "ce-sp-label", text: n.text });
      } else if (inf) {
        const stt = (inf.status ?? "").toLowerCase().replace(/[^a-z]/g, "");
        if (stt) c.addClass("ce-sp-st-" + stt);
        if (inf.missing) c.addClass("is-missing");
        const hd = c.createDiv({ cls: "ce-sp-cardh" });
        hd.createSpan({ cls: "ce-sp-code", text: n.alias ?? inf.code ?? n.text });
        if (inf.status) hd.createSpan({ cls: `ce-lab-badge ce-st-${stt}`, text: inf.status });
        if (inf.smiles) structure(c, inf.smiles, 74);
        const ft = c.createDiv({ cls: "ce-sp-cardf" });
        ft.createSpan({ cls: "ce-sp-ttl", text: inf.missing ? "note not found — click to create" : inf.title ?? "" });
        if (typeof inf.yieldPct === "number" && isFinite(inf.yieldPct)) ft.createSpan({ cls: "ce-sp-yield", text: Math.round(inf.yieldPct) + "%" });
      }
      if (!st.edit) {
        c.onclick = (e) => {
          if (pz.moved) return;
          if (isLink(n)) void this.plugin.app.workspace.openLinkText(n.text, this.folder && inf?.file ? inf.file.path : this.ctx.sourcePath, e.ctrlKey || e.metaKey);
          else this.nodeMenu(e, n, null);
        };
        c.oncontextmenu = (e) => { e.preventDefault(); this.nodeMenu(e, n, inf ?? null); };
      } else {
        c.createDiv({ cls: "ce-sp-handle", attr: { "aria-label": "Drag to connect" } });
        c.ondblclick = (e) => { e.stopPropagation(); this.rename(n); };
        c.oncontextmenu = (e) => { e.preventDefault(); this.nodeMenu(e, n, inf ?? null); };
      }
    }
    drawEdges();

    // hover highlight (view mode)
    if (!st.edit) {
      const nb = new Map<string, Set<string>>();
      for (const e of g.edges) { (nb.get(e.from) ?? nb.set(e.from, new Set()).get(e.from)!).add(e.to); (nb.get(e.to) ?? nb.set(e.to, new Set()).get(e.to)!).add(e.from); }
      for (const [id, c] of cards) {
        c.addEventListener("mouseenter", () => { stage.addClass("has-hl"); c.addClass("is-hl"); for (const o of nb.get(id) ?? []) cards.get(o)?.addClass("is-hl"); for (const e of edgeEls) if (e.a === id || e.b === id) e.el.classList.add("is-hl"); });
        c.addEventListener("mouseleave", () => { stage.removeClass("has-hl"); stage.querySelectorAll(".is-hl").forEach((x) => x.classList.remove("is-hl")); });
      }
    }

    // ----- edit interactions
    if (st.edit) {
      const toStage = (cx: number, cy: number) => { const r = vp.getBoundingClientRect(); return { x: (cx - r.left - pz.x) / pz.k, y: (cy - r.top - pz.y) / pz.k }; };
      const select = (s: string | null) => { st.sel = s; stage.querySelectorAll(".is-sel").forEach((x) => x.classList.remove("is-sel")); if (s?.startsWith("n")) cards.get(s.slice(1))?.addClass("is-sel"); drawEdges(); this.drawActions(actions!); };
      stage.addEventListener("pointerdown", (ev) => {
        const target = ev.target as HTMLElement;
        const handle = target.closest(".ce-sp-handle");
        const card = target.closest<HTMLElement>(".ce-sp-node");
        const ehit = target.closest<SVGElement>(".ce-sp-ehit");
        if (ehit) { ev.stopPropagation(); select("e" + ehit.dataset.edge); return; }
        if (!card) { if (st.sel) select(null); return; }
        ev.stopPropagation(); ev.preventDefault();
        const id = card.dataset.id!;
        const b = xy.get(id)!;
        const p0 = toStage(ev.clientX, ev.clientY);
        try { stage.setPointerCapture(ev.pointerId); } catch { /* */ }
        if (handle) {
          // connect: rubber band from the handle
          const line = document.createElementNS(SVGNS, "path");
          line.setAttribute("class", "ce-sp-rubber");
          svg.appendChild(line);
          const sx = b.x + b.w, sy = b.y + b.h / 2;
          const move = (e: PointerEvent) => { const q = toStage(e.clientX, e.clientY); line.setAttribute("d", `M${sx},${sy} L${q.x},${q.y}`); };
          const up = (e: PointerEvent) => {
            stage.removeEventListener("pointermove", move); stage.removeEventListener("pointerup", up); line.remove();
            const q = toStage(e.clientX, e.clientY);
            const hitId = [...xy.entries()].find(([k, r]) => k !== id && q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h)?.[0];
            if (hitId) this.connect(id, hitId);
            else if (Math.hypot(q.x - sx, q.y - sy) > 30) this.prompt("New connected node", "Text, [[note]] or SMILES", "", (v) => this.addNode(v, { x: q.x, y: q.y - 23 }, id));
          };
          stage.addEventListener("pointermove", move); stage.addEventListener("pointerup", up);
          return;
        }
        // drag to move (click = select)
        let moved = false;
        const move = (e: PointerEvent) => {
          const q = toStage(e.clientX, e.clientY);
          const dx = q.x - p0.x, dy = q.y - p0.y;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true;
          b.x = Math.max(0, Math.round((b.x + dx) / 4) * 4); b.y = Math.max(0, Math.round((b.y + dy) / 4) * 4);
          p0.x = q.x; p0.y = q.y;
          card.setCssStyles({ left: b.x + "px", top: b.y + "px" });
          drawEdges();
        };
        const up = () => {
          stage.removeEventListener("pointermove", move); stage.removeEventListener("pointerup", up);
          if (moved) { for (const [k, r] of xy) if (k === id || g.pos.has(k)) g.pos.set(k, { x: r.x, y: r.y }); if (!g.pos.size || g.pos.size < xy.size) for (const [k, r] of xy) g.pos.set(k, { x: r.x, y: r.y }); st.sel = "n" + id; void this.save(); }
          else select("n" + id);
        };
        stage.addEventListener("pointermove", move); stage.addEventListener("pointerup", up);
      });
      vp.addEventListener("pointerdown", (e) => { if (e.target === vp && st.sel) select(null); });
      vp.addEventListener("keydown", (e) => { if ((e.key === "Delete" || e.key === "Backspace") && st.sel) { e.preventDefault(); this.deleteSel(); } if (e.key === "Escape") select(null); });
      this.drawActions(actions!);
    }

    // pan / zoom (+ keep the view across edits)
    pz.onZoom = () => { st.view = { x: pz.x, y: pz.y, k: pz.k }; };
    vp.addEventListener("pointerup", () => { st.view = { x: pz.x, y: pz.y, k: pz.k }; });
    const fit = () => pz.fitRect(0, 0, W, H, 16, 1);
    const zb = (icon: string, l: string, run: () => void) => { const b = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": l } }); setIcon(b, icon); b.onclick = run; };
    zb("zoom-out", "Zoom out", () => pz.zoomAt(pz.k / 1.25, vp.clientWidth / 2, vp.clientHeight / 2));
    zb("zoom-in", "Zoom in", () => pz.zoomAt(pz.k * 1.25, vp.clientWidth / 2, vp.clientHeight / 2));
    zb("maximize", "Fit", fit);
    zb("refresh-cw", "Reload", () => { void this.render(); });
    window.requestAnimationFrame(() => { st.vw = vp.clientWidth || st.vw; st.vh = vp.clientHeight || st.vh; if (st.view) { pz.x = st.view.x; pz.y = st.view.y; pz.k = st.view.k; pz.apply(); } else fit(); });
    if (g.errors.length) root.createDiv({ cls: "ce-sp-warn", text: g.errors.slice(0, 3).join(" · ") });
  }

  // ------------------------------------------------------------------ editing model

  private g!: PlanGraph;
  private opts: Record<string, string> = {};

  /** UI state survives the re-render that follows every save (keyed by note + block position). */
  private state(): EditState {
    const line = this.ctx.getSectionInfo(this.containerEl)?.lineStart ?? 0;
    const key = this.ctx.sourcePath + "#" + line;
    let s = EDIT_STATE.get(key);
    if (!s) { s = { edit: false, sel: null, view: null, vw: 600, vh: 400 }; EDIT_STATE.set(key, s); }
    return s;
  }

  private async save() {
    const text = serializePlan(this.g, this.opts);
    const ok = await writeBlockBody(this.plugin.app, this.containerEl, this.ctx, text);
    if (!ok) { new Notice("Couldn't locate this block in the note — switch to reading view or source mode and try again."); return; }
    this.src = text;
    void this.render();
  }

  private tokenNode(raw: string): PlanNode | null {
    const g = parsePlan([raw], okSmiles);
    return [...g.nodes.values()][0] ?? null;
  }

  private addNode(raw: string, at?: { x: number; y: number }, from?: string) {
    const n = this.tokenNode(raw.trim());
    if (!n) return;
    const g = this.g;
    if (!g.nodes.has(n.id)) { n.order = g.nodes.size; g.nodes.set(n.id, n); }
    if (at) g.pos.set(n.id, at);
    else if (g.pos.size) { const st = this.state(); const v = st.view ?? { x: 0, y: 0, k: 1 }; g.pos.set(n.id, { x: Math.max(0, Math.round((st.vw / 2 - 86 - v.x) / v.k)), y: Math.max(0, Math.round((st.vh / 2 - 30 - v.y) / v.k)) }); }
    if (from && from !== n.id && !g.edges.some((e) => e.from === from && e.to === n.id)) g.edges.push({ from, to: n.id });
    this.state().sel = "n" + n.id;
    void this.save();
  }

  private connect(a: string, b: string) {
    if (this.g.edges.some((e) => e.from === a && e.to === b)) { new Notice("Already connected"); return; }
    this.g.edges.push({ from: a, to: b });
    this.state().sel = "e" + (this.g.edges.length - 1);
    void this.save();
  }

  private rename(n: PlanNode) {
    this.prompt("Rename node", "Text, [[note]] or SMILES", nodeToken(n).replace(/^"|"$/g, ""), (v) => {
      const m = this.tokenNode(v.trim());
      if (!m || m.id === n.id) { if (m && m.alias !== n.alias) { n.alias = m.alias; void this.save(); } return; }
      const g = this.g;
      const merged = g.nodes.has(m.id);
      if (!merged) { m.order = n.order; g.nodes.set(m.id, m); }
      for (const e of g.edges) { if (e.from === n.id) e.from = m.id; if (e.to === n.id) e.to = m.id; }
      g.edges = g.edges.filter((e, i, arr) => e.from !== e.to && arr.findIndex((x) => x.from === e.from && x.to === e.to) === i);
      const p = g.pos.get(n.id); g.pos.delete(n.id); if (p && !g.pos.has(m.id)) g.pos.set(m.id, p);
      g.nodes.delete(n.id);
      this.state().sel = "n" + m.id;
      void this.save();
    });
  }

  private deleteSel() {
    const st = this.state(), g = this.g;
    if (!st.sel) return;
    if (st.sel.startsWith("e")) g.edges.splice(+st.sel.slice(1), 1);
    else { const id = st.sel.slice(1); g.nodes.delete(id); g.pos.delete(id); g.edges = g.edges.filter((e) => e.from !== id && e.to !== id); }
    st.sel = null;
    void this.save();
  }

  /** Context actions for the current selection (also usable on touch screens). */
  private drawActions(el: HTMLElement) {
    el.empty();
    const st = this.state(), g = this.g;
    const b = (icon: string, label: string, run: () => void, cls = "") => { const x = el.createEl("button", { cls: "ce-sp-tool " + cls, attr: { "aria-label": label } }); setIcon(x.createSpan(), icon); x.createSpan({ text: label }); x.onclick = run; };
    if (!st.sel) { el.createSpan({ cls: "ce-sp-muted", text: "Nothing selected" }); return; }
    if (st.sel.startsWith("e")) {
      const e = g.edges[+st.sel.slice(1)]; if (!e) return;
      b("tag", e.label ? "Edit label" : "Add conditions", () => this.prompt("Arrow label (conditions, reagents, yield…)", "e.g. NiBr2·glyme, dtbbpy, Mn, 60 °C", e.label ?? "", (v) => { e.label = v; void this.save(); }));
      if (e.label) b("eraser", "Remove label", () => { delete e.label; void this.save(); });
      b("git-commit-horizontal", e.dashed ? "Solid (done)" : "Dashed (planned)", () => { e.dashed = !e.dashed; void this.save(); });
      b("arrow-left-right", "Reverse", () => { [e.from, e.to] = [e.to, e.from]; void this.save(); });
      b("trash-2", "Delete arrow", () => this.deleteSel(), "mod-warning");
      return;
    }
    const n = g.nodes.get(st.sel.slice(1)); if (!n) return;
    b("pencil", "Rename", () => this.rename(n));
    if (n.kind === "smiles") b("hexagon", "Edit structure", () => this.plugin.openEditor(n.text, (r) => this.renameTo(n, r.smiles), { title: "Edit structure", saveLabel: "Update" }));
    if (n.kind === "text") b("hexagon", "Draw as structure", () => this.plugin.openEditor(null, (r) => this.renameTo(n, r.smiles), { title: n.text, saveLabel: "Use structure" }));
    if (n.kind !== "link") b("link", "Link to note", () => new NotePicker(this.plugin.app, this.folder || this.plugin.settings.elnFolder, (f) => this.renameTo(n, `[[${f.basename}]]`)).open());
    b("pin-off", "Unpin position", () => { g.pos.delete(n.id); void this.save(); });
    b("trash-2", "Delete", () => this.deleteSel(), "mod-warning");
  }

  private renameTo(n: PlanNode, token: string) {
    const m = this.tokenNode(token); if (!m) return;
    const g = this.g;
    if (!g.nodes.has(m.id)) { m.order = n.order; g.nodes.set(m.id, m); }
    for (const e of g.edges) { if (e.from === n.id) e.from = m.id; if (e.to === n.id) e.to = m.id; }
    const p = g.pos.get(n.id); g.pos.delete(n.id); if (p) g.pos.set(m.id, p);
    if (m.id !== n.id) g.nodes.delete(n.id);
    this.state().sel = "n" + m.id;
    void this.save();
  }

  private prompt(title: string, ph: string, initial: string, ok: (v: string) => void) { new PromptModal(this.plugin.app, title, ph, initial, ok).open(); }

  private nodeMenu(e: MouseEvent, n: PlanNode, inf: NodeInfo | null) {
    const m = new Menu();
    const smi = n.kind === "smiles" ? n.text : inf?.smiles;
    if (inf?.file) m.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => { void this.plugin.app.workspace.getLeaf("tab").openFile(inf.file!); }));
    if (smi) {
      m.addItem((i) => i.setTitle("Copy SMILES").setIcon("copy").onClick(async () => { await navigator.clipboard.writeText(smi); new Notice("SMILES copied"); }));
      m.addItem((i) => i.setTitle("View in editor").setIcon("hexagon").onClick(() => this.plugin.openEditor(smi, async (r) => { await navigator.clipboard.writeText(r.smiles); new Notice("SMILES copied"); }, { title: n.alias ?? inf?.code ?? "Structure", saveLabel: "Copy SMILES" })));
      m.addItem((i) => i.setTitle("Copy NMR prediction block").setIcon("activity").onClick(async () => { await navigator.clipboard.writeText(nmrBlock(smi)); new Notice("```chem-nmr block copied — paste it into a note"); }));
      m.addItem((i) => i.setTitle("New experiment from this").setIcon("flask-conical").onClick(() => { void this.plugin.newExperiment(undefined, { reactants: [{ name: n.kind === "smiles" ? "" : inf?.title ?? "", smiles: smi }], products: [] }); }));
    }
    if (n.kind === "text") m.addItem((i) => i.setTitle(`Create note “${n.text}”`).setIcon("file-plus").onClick(() => { void this.plugin.app.workspace.openLinkText((this.folder ? this.folder + "/" : "") + n.text, this.ctx.sourcePath, true); }));
    if (!this.state().edit) m.addItem((i) => i.setTitle("Edit map…").setIcon("pencil").onClick(() => { const st = this.state(); st.edit = true; st.sel = "n" + n.id; void this.render(); }));
    if (!smilesLike(n.text) && !inf) m.addItem((i) => i.setTitle("Copy label").setIcon("copy").onClick(() => { void navigator.clipboard.writeText(n.text); }));
    m.showAtMouseEvent(e);
  }
}

interface EditState { edit: boolean; sel: string | null; view: { x: number; y: number; k: number } | null; vw: number; vh: number }
const EDIT_STATE = new Map<string, EditState>();

/** Pick a note (experiments folder first). */
class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private folder: string, private onPick: (f: TFile) => void) { super(app); this.setPlaceholder("Link an experiment / note…"); }
  getItems() {
    const all = this.app.vault.getMarkdownFiles();
    const f = this.folder ? all.filter((x) => x.path.startsWith(this.folder + "/")) : [];
    return [...f, ...all.filter((x) => !f.includes(x))];
  }
  getItemText(f: TFile) { return f.path; }
  onChooseItem(f: TFile) { this.onPick(f); }
}

export const SYNTH_PLAN_EXAMPLE = "```synthesis-plan\npath: ELN\n[[EXP-001]] -> [[EXP-002]] -> [[EXP-003]]\nCOc1ccc(I)cc1 -[XEC, Ni/dtbbpy, Mn]-> [[EXP-002]]\n\"Idea: late-stage C–H arylation\" ..> [[EXP-003]]\n```\n";
