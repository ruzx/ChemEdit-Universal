// ```synthesis-plan``` — a free-form route mind map written as arrows:
//   path: ELN
//   [[EXP-001]] -> [[EXP-002]] -> [[EXP-003]]
//   C1=CC=CC=C1 -[HNO3, H2SO4]-> Intermediate -> [[EXP-005]]
// Experiment links become cards (product, status, yield), SMILES become structures,
// anything else is a label. Cycles are allowed. Drag to pan, scroll / pinch to zoom.

import { MarkdownPostProcessorContext, MarkdownRenderChild, Menu, Notice, TFile, debounce, setIcon } from "obsidian";
import type ChemEditPlugin from "./main";
import { parseElnYaml } from "./eln";
import { calculateEln } from "../chem/eln";
import { parseAny } from "../chem/index";
import { stripCarbonHydrogens } from "../chem/model";
import { parsePlan, layoutPlan, smilesLike, PlanGraph, PlanNode } from "../chem/plan";
import { PanZoom } from "./synthmap";
import { blockOptions, cleanFolder } from "./blockopts";
import { nmrBlock } from "./nmrview";

const KEYS = ["path", "folder", "title", "height", "direction"];
const NW = 172, GAPX = 92, ROWH = 156, GAPC = 36;
const SVGNS = "http://www.w3.org/2000/svg";

interface NodeInfo { file: TFile | null; code?: string; title?: string; status?: string; smiles?: string; yieldPct?: number | null; missing?: boolean }

const okSmiles = (t: string) => { try { return parseAny(t, "smiles").atoms.length > 0; } catch { return false; } };

export class SynthesisPlanBlock extends MarkdownRenderChild {
  private folder = "";
  private files = new Set<string>();
  constructor(private plugin: ChemEditPlugin, el: HTMLElement, private src: string, private ctx: MarkdownPostProcessorContext) { super(el); }

  async onload() {
    const rerender = debounce(() => this.render(), 800, true);
    this.registerEvent(this.plugin.app.metadataCache.on("changed", (f) => { if (this.files.has(f.path)) rerender(); }));
    await this.render();
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
    const fm: any = app.metadataCache.getFileCache(f)?.frontmatter ?? {};
    const txt = await app.vault.cachedRead(f);
    const m = /```eln\s*\n([\s\S]*?)\n```/.exec(txt);
    if (m) {
      try {
        const d = parseElnYaml(m[1]); const c = calculateEln(d);
        const p = c.products.find((x) => x.src.smiles) ?? c.products[0];
        return { file: f, code: d.code ?? f.basename, title: d.title ?? p?.src.name, status: d.status ?? "Planned", smiles: p?.src.smiles ? String(p.src.smiles) : undefined, yieldPct: c.products[0]?.yieldPct ?? null };
      } catch { /* fall through */ }
    }
    const sm = fm.smiles ? String(fm.smiles) : /```smiles\s*\n([^\n]+)/.exec(txt)?.[1]?.trim();
    return { file: f, code: f.basename, title: fm.title ?? fm.name, status: fm.status, smiles: sm };
  }

  private async render() {
    const el = this.containerEl;
    el.empty();
    const { opts, rest } = blockOptions(this.src, el, this.ctx, KEYS);
    this.folder = cleanFolder(opts.path ?? opts.folder);
    const g = parsePlan(rest, okSmiles);
    // bare labels that match a note in `path:` become links
    if (this.folder) for (const n of g.nodes.values()) if (n.kind === "text" && this.resolve(n.text)?.path.startsWith(this.folder + "/")) n.kind = "link";
    const root = el.createDiv({ cls: "ce-sp" });
    const head = root.createDiv({ cls: "ce-sp-head" });
    const t = head.createDiv({ cls: "ce-sp-title" });
    setIcon(t.createSpan({ cls: "ce-sp-ico" }), "git-fork");
    t.createSpan({ text: opts.title || "Synthesis plan" });
    if (this.folder) head.createSpan({ cls: "ce-sp-sub", text: "📁 " + this.folder });
    const tools = head.createDiv({ cls: "ce-sp-tools" });
    if (!g.nodes.size) {
      root.createDiv({ cls: "ce-sp-empty", text: "Write steps as arrows, one route per line:  [[EXP-001]] -> [[EXP-002]]  ·  CCO -[PCC]-> CC=O  ·  Idea -> [[EXP-007]]" });
      return;
    }
    // node data
    const info = new Map<string, NodeInfo>();
    this.files.clear();
    await Promise.all([...g.nodes.values()].filter((n) => n.kind === "link").map(async (n) => { const f = this.resolve(n.text); if (f) this.files.add(f.path); info.set(n.id, await this.info(f)); }));
    const lay = layoutPlan(g);
    // geometry
    const hOf = (n: PlanNode) => n.kind === "text" ? 46 : n.kind === "smiles" ? 118 : info.get(n.id)?.smiles ? 150 : 74;
    const xy = new Map<string, { x: number; y: number; w: number; h: number }>();
    // column x: wider gaps where an edge carries a label
    const gap = new Array(lay.layers + 1).fill(GAPX);
    for (const e of g.edges) if (e.label && !e.back) { const la = lay.pos.get(e.from)!.layer; gap[la] = Math.max(gap[la], Math.min(260, e.label.length * 6.4 + 34)); }
    const colX: number[] = [20];
    for (let l = 1; l <= lay.layers; l++) colX[l] = colX[l - 1] + NW + gap[l - 1];
    let y0 = 20, maxX = 0;
    for (const c of lay.comps) {
      for (const id of c.ids) {
        const p = lay.pos.get(id)!; const n = g.nodes.get(id)!; const h = hOf(n);
        const x = colX[p.layer], y = y0 + p.row * ROWH + (ROWH - 16 - h) / 2;
        xy.set(id, { x, y, w: NW, h });
        maxX = Math.max(maxX, x + NW);
      }
      y0 += c.rows * ROWH + GAPC;
    }
    const W = maxX + 20, H = y0 - GAPC + 40;
    const height = parseInt(opts.height ?? "") || Math.min(640, Math.max(240, H * Math.min(1, 900 / W) + 30));
    const vp = root.createDiv({ cls: "ce-rm-vp ce-sp-vp" });
    vp.style.height = height + "px";
    const stage = vp.createDiv({ cls: "ce-rm-stage" });
    stage.style.width = W + "px"; stage.style.height = H + "px";
    // edges
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "ce-sp-edges"); svg.setAttribute("width", String(W)); svg.setAttribute("height", String(H + 60));
    svg.innerHTML = `<defs><marker id="ce-sp-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ce-sp-ahp" d="M0,0L10,5L0,10z"/></marker><marker id="ce-sp-ahb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ce-sp-ahp is-back" d="M0,0L10,5L0,10z"/></marker></defs>`;
    stage.appendChild(svg);
    const edgeEls: Array<{ el: SVGElement; a: string; b: string }> = [];
    for (const e of g.edges) {
      const A = xy.get(e.from)!, B = xy.get(e.to)!;
      const p = document.createElementNS(SVGNS, "path");
      let d: string, lx: number, ly: number;
      if (e.back || B.x <= A.x) {
        const yb = Math.max(A.y + A.h, B.y + B.h) + 26;
        const ax = A.x + A.w / 2, bx = B.x + B.w / 2;
        d = `M${ax},${A.y + A.h} C${ax},${yb + 20} ${bx},${yb + 20} ${bx},${B.y + B.h + 2}`;
        lx = (ax + bx) / 2; ly = yb + 12;
      } else {
        const ax = A.x + A.w, ay = A.y + A.h / 2, bx = B.x - 3, by = B.y + B.h / 2, k = Math.max(30, (bx - ax) * 0.5);
        d = `M${ax},${ay} C${ax + k},${ay} ${bx - k},${by} ${bx},${by}`;
        lx = (ax + bx) / 2; ly = (ay + by) / 2 - 6;
      }
      p.setAttribute("d", d);
      p.setAttribute("class", "ce-sp-edge" + (e.back ? " is-back" : "") + (e.dashed ? " is-dashed" : ""));
      p.setAttribute("marker-end", `url(#${e.back ? "ce-sp-ahb" : "ce-sp-ah"})`);
      svg.appendChild(p);
      edgeEls.push({ el: p, a: e.from, b: e.to });
      if (e.label) {
        const tx = document.createElementNS(SVGNS, "text");
        tx.setAttribute("x", String(lx)); tx.setAttribute("y", String(ly)); tx.setAttribute("text-anchor", "middle"); tx.setAttribute("class", "ce-sp-elabel");
        tx.textContent = e.label; svg.appendChild(tx);
        edgeEls.push({ el: tx, a: e.from, b: e.to });
      }
    }
    // nodes
    const cards = new Map<string, HTMLElement>();
    const svgCache = new Map<string, string>();
    const structure = (host: HTMLElement, smi: string, h: number) => {
      const s = host.createDiv({ cls: "ce-sp-struct" });
      try {
        const key = smi + "|" + h;
        if (!svgCache.has(key)) svgCache.set(key, this.plugin.svgFor(stripCarbonHydrogens(parseAny(smi)), { maxHeight: h, padding: 2 }));
        s.innerHTML = svgCache.get(key)!;
      } catch { s.addClass("is-error"); s.setText(smi); }
    };
    for (const n of g.nodes.values()) {
      const b = xy.get(n.id)!;
      const c = stage.createDiv({ cls: `ce-sp-node is-${n.kind}` });
      c.style.left = b.x + "px"; c.style.top = b.y + "px"; c.style.width = b.w + "px"; c.style.height = b.h + "px";
      cards.set(n.id, c);
      if (n.kind === "text") { c.createDiv({ cls: "ce-sp-label", text: n.text }); c.onclick = (e) => { if (!pz.moved) this.nodeMenu(e, n, null); }; continue; }
      if (n.kind === "smiles") {
        structure(c, n.text, 92);
        c.onclick = (e) => { if (!pz.moved) this.nodeMenu(e, n, null); };
        continue;
      }
      const inf = info.get(n.id)!;
      const st = (inf.status ?? "").toLowerCase().replace(/[^a-z]/g, "");
      if (st) c.addClass("ce-sp-st-" + st);
      if (inf.missing) c.addClass("is-missing");
      const hd = c.createDiv({ cls: "ce-sp-cardh" });
      hd.createSpan({ cls: "ce-sp-code", text: n.alias ?? inf.code ?? n.text });
      if (inf.status) hd.createSpan({ cls: `ce-lab-badge ce-st-${st}`, text: inf.status });
      if (inf.smiles) structure(c, inf.smiles, 74);
      const ft = c.createDiv({ cls: "ce-sp-cardf" });
      ft.createSpan({ cls: "ce-sp-ttl", text: inf.missing ? "note not found — click to create" : inf.title ?? "" });
      if (typeof inf.yieldPct === "number" && isFinite(inf.yieldPct)) ft.createSpan({ cls: "ce-sp-yield", text: Math.round(inf.yieldPct) + "%" });
      c.onclick = (e) => { if (pz.moved) return; this.plugin.app.workspace.openLinkText(n.text, this.folder && inf.file ? inf.file.path : this.ctx.sourcePath, e.ctrlKey || e.metaKey); };
      c.oncontextmenu = (e) => { e.preventDefault(); this.nodeMenu(e, n, inf); };
    }
    // hover highlight
    const nb = new Map<string, Set<string>>();
    for (const e of g.edges) { (nb.get(e.from) ?? nb.set(e.from, new Set()).get(e.from)!).add(e.to); (nb.get(e.to) ?? nb.set(e.to, new Set()).get(e.to)!).add(e.from); }
    for (const [id, c] of cards) {
      c.addEventListener("mouseenter", () => { stage.addClass("has-hl"); c.addClass("is-hl"); for (const o of nb.get(id) ?? []) cards.get(o)?.addClass("is-hl"); for (const e of edgeEls) if (e.a === id || e.b === id) e.el.classList.add("is-hl"); });
      c.addEventListener("mouseleave", () => { stage.removeClass("has-hl"); stage.querySelectorAll(".is-hl").forEach((x) => x.classList.remove("is-hl")); });
    }
    // pan / zoom
    const pz = new PanZoom(vp, stage);
    const fit = () => pz.fitRect(0, 0, W, H, 16, 1);
    const zb = (icon: string, l: string, run: () => void) => { const b = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": l } }); setIcon(b, icon); b.onclick = run; };
    zb("zoom-out", "Zoom out", () => pz.zoomAt(pz.k / 1.25, vp.clientWidth / 2, vp.clientHeight / 2));
    zb("zoom-in", "Zoom in", () => pz.zoomAt(pz.k * 1.25, vp.clientWidth / 2, vp.clientHeight / 2));
    zb("maximize", "Fit", fit);
    zb("refresh-cw", "Reload", () => this.render());
    window.requestAnimationFrame(fit);
    if (g.errors.length) root.createDiv({ cls: "ce-sp-warn", text: g.errors.slice(0, 3).join(" · ") });
  }

  private nodeMenu(e: MouseEvent, n: PlanNode, inf: NodeInfo | null) {
    const m = new Menu();
    const smi = n.kind === "smiles" ? n.text : inf?.smiles;
    if (inf?.file) m.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => this.plugin.app.workspace.getLeaf("tab").openFile(inf.file!)));
    if (smi) {
      m.addItem((i) => i.setTitle("Copy SMILES").setIcon("copy").onClick(async () => { await navigator.clipboard.writeText(smi); new Notice("SMILES copied"); }));
      m.addItem((i) => i.setTitle("View in editor").setIcon("hexagon").onClick(() => this.plugin.openEditor(smi, async (r) => { await navigator.clipboard.writeText(r.smiles); new Notice("SMILES copied"); }, { title: n.alias ?? inf?.code ?? "Structure", saveLabel: "Copy SMILES" })));
      m.addItem((i) => i.setTitle("Copy NMR prediction block").setIcon("activity").onClick(async () => { await navigator.clipboard.writeText(nmrBlock(smi)); new Notice("```chem-nmr block copied — paste it into a note"); }));
      m.addItem((i) => i.setTitle("New experiment from this").setIcon("flask-conical").onClick(() => this.plugin.newExperiment(undefined, { reactants: [{ name: n.kind === "smiles" ? "" : inf?.title ?? "", smiles: smi, role: "reactant" } as any] } as any)));
    }
    if (n.kind === "text") m.addItem((i) => i.setTitle(`Create note “${n.text}”`).setIcon("file-plus").onClick(() => this.plugin.app.workspace.openLinkText((this.folder ? this.folder + "/" : "") + n.text, this.ctx.sourcePath, true)));
    if (!smilesLike(n.text) && !inf) m.addItem((i) => i.setTitle("Copy label").setIcon("copy").onClick(() => navigator.clipboard.writeText(n.text)));
    m.showAtMouseEvent(e);
  }
}

export const SYNTH_PLAN_EXAMPLE = "```synthesis-plan\npath: ELN\n[[EXP-001]] -> [[EXP-002]] -> [[EXP-003]]\nCOc1ccc(I)cc1 -[XEC, Ni/dtbbpy, Mn]-> [[EXP-002]]\nIdea: late-stage C–H arylation ..> [[EXP-003]]\n```\n";
