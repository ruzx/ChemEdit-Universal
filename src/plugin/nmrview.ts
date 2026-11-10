// ```chem-nmr``` — predicted ¹H / ¹³C NMR for a structure: interactive spectrum,
// structure ↔ peak highlighting, signal table and ACS-style text to paste into the SI.

import { MarkdownPostProcessorContext, MarkdownRenderChild, Menu, Notice, setIcon } from "obsidian";
import type ChemEditPlugin from "./main";
import { parseAny } from "../chem/index";
import { expandAbbreviations } from "../chem/abbrev";
import type { ChemDoc } from "../chem/model";
import { renderSVG } from "../render/svg";
import { svgToPngBlob } from "../render/png";
import { predictNmr, acsText, spectrumSvg, SOLVENTS, solventOf, carbonMHz, NmrPrediction, Nucleus, PredSignal, multipletRange, spectrumRange as spectrumSvgRange } from "../chem/nmr/spectrum";
import { blockOptions, writeBlockOptions, insertAfterBlock } from "./blockopts";
import { setSvg, setRich, setSvgChildren, serializeEl } from "../render/dom";

const KEYS = ["smiles", "mol", "nucleus", "mhz", "solvent", "range", "name", "title"];
const MHZ = [300, 400, 500, 600];

/** Structure source → doc (SMILES, reaction SMILES → product side, molfile). */
function docOf(src: string): ChemDoc {
  let s = src.trim();
  if (!/V2000|V3000/.test(s) && s.includes(">")) s = s.split(">").pop()!.trim();
  const d = parseAny(s);
  return d.atoms.some((a) => a.label || a.expand) ? expandAbbreviations(d) : d;
}

export function nmrBlock(smiles: string, nucleus: "1H" | "13C" | "both" = "both", extra = "") {
  return "```chem-nmr\nsmiles: " + smiles + "\nnucleus: " + nucleus + "\nmhz: 400\nsolvent: CDCl3\n" + extra + "```\n";
}

export class NmrBlock extends MarkdownRenderChild {
  private pred!: NmrPrediction;
  private doc!: ChemDoc;
  private tab: Nucleus = "1H";
  private mhz = 400;
  private solvent = SOLVENTS[0];
  private range: [number, number] | undefined;
  private showNums = false;
  private both = true;
  private name = "";

  constructor(private plugin: ChemEditPlugin, el: HTMLElement, private src: string, private ctx: MarkdownPostProcessorContext) { super(el); }

  onload() {
    const { opts, rest } = blockOptions(this.src, this.containerEl, this.ctx, KEYS);
    const struct = opts.smiles || opts.mol || rest.join("\n").trim();
    const root = this.containerEl.createDiv({ cls: "ce-nmr" });
    if (!struct) { root.createDiv({ cls: "ce-nmr-err", text: "Add a structure: smiles: CCO (or a molfile)." }); return; }
    try { this.doc = docOf(struct); this.pred = predictNmr(this.doc); }
    catch (e) { root.createDiv({ cls: "ce-nmr-err", text: "Cannot read structure: " + (e as Error).message }); return; }
    const nuc = (opts.nucleus ?? "both").toLowerCase();
    this.both = !/^(1h|h|13c|c)$/.test(nuc);
    this.tab = /13c|^c$/.test(nuc) ? "13C" : "1H";
    this.mhz = parseInt(opts.mhz ?? "") || 400;
    this.solvent = solventOf(opts.solvent);
    this.name = opts.name ?? opts.title ?? "";
    const r = /^\s*(-?[\d.]+)\s*[-–:]\s*(-?[\d.]+)\s*$/.exec(opts.range ?? "");
    if (r) this.range = [Math.min(+r[1], +r[2]), Math.max(+r[1], +r[2])];
    this.draw(root);
  }

  private sigs(): PredSignal[] { return this.tab === "13C" ? this.pred.c : this.pred.h; }
  private text(n: Nucleus = this.tab) { return acsText(n === "13C" ? this.pred.c : this.pred.h, n, this.mhz, this.solvent); }

  private draw(root: HTMLElement) {
    root.empty();
    // header
    const head = root.createDiv({ cls: "ce-nmr-head" });
    const t = head.createDiv({ cls: "ce-nmr-title" });
    setIcon(t.createSpan({ cls: "ce-nmr-ico" }), "activity");
    t.createSpan({ text: "Predicted NMR" + (this.name ? " · " + this.name : "") });
    const tabs = head.createDiv({ cls: "ce-nmr-tabs" });
    for (const n of ["1H", "13C"] as Nucleus[]) {
      if (!this.both && n !== this.tab) continue;
      const b = tabs.createEl("button", { cls: "ce-nmr-tab" + (n === this.tab ? " is-on" : ""), text: n === "1H" ? "¹H" : "¹³C" });
      b.onclick = () => { this.tab = n; this.range = undefined; this.draw(root); };
    }
    const right = head.createDiv({ cls: "ce-nmr-ctrls" });
    const ms = right.createEl("select", { cls: "dropdown", attr: { "aria-label": "Spectrometer frequency" } });
    for (const m of MHZ) ms.createEl("option", { value: String(m), text: this.tab === "13C" ? `${carbonMHz(m)} MHz` : `${m} MHz` });
    ms.value = String(this.mhz);
    ms.onchange = () => { this.mhz = +ms.value; this.draw(root); this.persist({ mhz: ms.value }); };
    const ss = right.createEl("select", { cls: "dropdown", attr: { "aria-label": "Solvent" } });
    for (const s of SOLVENTS) ss.createEl("option", { value: s.id, text: s.label });
    ss.value = this.solvent.id;
    ss.onchange = () => { this.solvent = solventOf(ss.value); this.draw(root); this.persist({ solvent: ss.value }); };
    const nb = right.createEl("button", { cls: "clickable-icon" + (this.showNums ? " is-active" : ""), attr: { "aria-label": "Show atom numbers" } });
    setIcon(nb, "hash");
    nb.onclick = () => { this.showNums = !this.showNums; this.draw(root); };
    const more = right.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Copy / export" } });
    setIcon(more, "more-horizontal");
    more.onclick = (e) => this.menu(e, root);

    // body: structure + spectrum
    const body = root.createDiv({ cls: "ce-nmr-body" });
    const st = body.createDiv({ cls: "ce-nmr-struct" });
    setSvg(st, this.structSvg());
    const sp = body.createDiv({ cls: "ce-nmr-spec" });
    const sigs = this.sigs();
    setSvg(sp, spectrumSvg(sigs, { nucleus: this.tab, mhz: this.tab === "13C" ? carbonMHz(this.mhz) : this.mhz, solvent: this.solvent, range: this.range }));
    this.zoom(sp, root);

    // table
    const tw = root.createDiv({ cls: "ce-nmr-tablewrap" });
    const tb = tw.createEl("table", { cls: "ce-nmr-table" });
    const hr = tb.createEl("thead").createEl("tr");
    for (const h of this.tab === "13C" ? ["δ (ppm)", "C", "Atoms"] : ["δ (ppm)", "Mult.", "J (Hz)", "Int.", "Atoms"]) hr.createEl("th", { text: h });
    const tbody = tb.createEl("tbody");
    sigs.forEach((s, k) => {
      const tr = tbody.createEl("tr", { attr: { "data-i": String(k) } });
      let d = this.tab === "13C" ? s.shift.toFixed(1) : s.shift.toFixed(2);
      if (s.mult === "m") { const [lo, hi] = multipletRange(s, this.mhz); d = `${hi.toFixed(2)}–${lo.toFixed(2)}`; }
      tr.createEl("td", { cls: "ce-nmr-num", text: d });
      if (this.tab === "13C") { tr.createEl("td", { text: String(s.n) }); }
      else {
        tr.createEl("td", { text: s.mult });
        tr.createEl("td", { text: s.J.map((j) => j.toFixed(1)).join(", ") || "–" });
        tr.createEl("td", { text: `${s.n}H` });
      }
      tr.createEl("td", { cls: "ce-nmr-muted", text: s.label + (s.exch ? " (exch.)" : "") });
    });

    // ACS text
    const tx = root.createDiv({ cls: "ce-nmr-text" });
    tx.createDiv({ cls: "ce-nmr-acs", text: this.text() });
    const acts = tx.createDiv({ cls: "ce-nmr-acts" });
    const cp = acts.createEl("button", { text: "Copy" });
    cp.onclick = async () => { await navigator.clipboard.writeText(this.text()); new Notice("NMR text copied"); };
    const ins = acts.createEl("button", { text: "Insert below" });
    ins.onclick = async () => { const ok = await insertAfterBlock(this.plugin.app, this.containerEl, this.ctx, this.both ? `${this.text("1H")}\n${this.text("13C")}` : this.text()); if (!ok) { new Notice("Could not locate the block — copied instead"); await navigator.clipboard.writeText(this.text()); } };
    root.createDiv({ cls: "ce-nmr-note", text: "Increment-based estimate (≈ ±0.2 ppm ¹H, ±3–5 ppm ¹³C; first-order multiplets). Use for assignment and planning — always confirm experimentally." });

    this.wireHover(root);
  }

  private structSvg(): string {
    const bl = 30;
    let svg = renderSVG(this.doc, { bondLength: bl, color: "currentColor", padding: 14, maxHeight: 220, maxWidth: 300 });
    const pos = new Map(this.doc.atoms.map((a) => [a.id, a]));
    const marks: string[] = [];
    this.pred.mol.atoms.forEach((a, k) => {
      const p = pos.get(a.id); if (!p) return;
      const x = (p.x * bl).toFixed(1), y = (p.y * bl).toFixed(1);
      marks.push(`<circle class="ce-nmr-atom" data-a="${k}" cx="${x}" cy="${y}" r="${(bl * 0.42).toFixed(1)}"/>`);
      const relevant = this.tab === "13C" ? a.el === "C" : a.h > 0;
      if (this.showNums && relevant) marks.push(`<text class="ce-nmr-anum" x="${(p.x * bl + bl * 0.28).toFixed(1)}" y="${(p.y * bl - bl * 0.22).toFixed(1)}">${k + 1}</text>`);
    });
    return svg.replace(/<\/svg>$/, `<g class="ce-nmr-marks">${marks.join("")}</g></svg>`);
  }

  private wireHover(root: HTMLElement) {
    const sigs = this.sigs();
    const atomsOf = (i: number) => new Set(sigs[i]?.atoms ?? []);
    const set = (i: number | null) => {
      root.querySelectorAll(".is-hl").forEach((e) => e.classList.remove("is-hl"));
      root.toggleClass("has-hl", i !== null);
      if (i === null) return;
      root.querySelectorAll(`[data-i="${i}"]`).forEach((e) => e.classList.add("is-hl"));
      const as = atomsOf(i);
      root.querySelectorAll<SVGElement>(".ce-nmr-atom").forEach((c) => { if (as.has(+c.dataset.a!)) c.classList.add("is-hl"); });
    };
    root.querySelectorAll<HTMLElement>("[data-i]").forEach((e) => { e.addEventListener("mouseenter", () => set(+e.dataset.i!)); e.addEventListener("mouseleave", () => set(null)); e.addEventListener("click", () => set(+e.dataset.i!)); });
    root.querySelectorAll<SVGElement>(".ce-nmr-atom").forEach((c) => {
      const a = +c.dataset.a!;
      const i = sigs.findIndex((s) => s.atoms.includes(a));
      if (i < 0) return;
      c.classList.add("is-active");
      c.addEventListener("mouseenter", () => set(i)); c.addEventListener("mouseleave", () => set(null)); c.addEventListener("click", () => set(i));
    });
  }

  /** drag across the spectrum to zoom; double-click to reset */
  private zoom(sp: HTMLElement, root: HTMLElement) {
    const svg = sp.querySelector("svg"); if (!svg) return;
    let x0: number | null = null;
    const box = sp.createDiv({ cls: "ce-nmr-brush" });
    const rel = (e: PointerEvent) => { const r = svg.getBoundingClientRect(); return (e.clientX - r.left) / r.width; };
    svg.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; x0 = rel(e); box.setCssStyles({ display: "none" }); });
    svg.addEventListener("pointermove", (e) => {
      if (x0 === null) return;
      const x1 = rel(e); if (Math.abs(x1 - x0) < 0.01) return;
      box.setCssStyles({ display: "block", left: Math.min(x0, x1) * 100 + "%", width: Math.abs(x1 - x0) * 100 + "%" });
    });
    svg.addEventListener("pointerup", (e) => {
      if (x0 === null) return;
      const x1 = rel(e); const a = x0; x0 = null; box.setCssStyles({ display: "none" });
      if (Math.abs(x1 - a) < 0.02) return;
      const W = 760, L = 18, R = 18;
      const [lo, hi] = this.range ?? (spectrumSvgRange(this.sigs(), this.tab));
      const ppm = (f: number) => hi - ((f * W - L) / (W - L - R)) * (hi - lo);
      const p1 = ppm(Math.min(a, x1)), p2 = ppm(Math.max(a, x1));
      this.range = [Math.min(p1, p2), Math.max(p1, p2)];
      this.draw(root);
    });
    svg.addEventListener("dblclick", () => { this.range = undefined; this.draw(root); });
    if (this.range) { const r = sp.createEl("button", { cls: "ce-nmr-reset", text: "Reset zoom" }); r.onclick = () => { this.range = undefined; this.draw(root); }; }
  }

  private menu(e: MouseEvent, root: HTMLElement) {
    const m = new Menu();
    m.addItem((i) => i.setTitle("Copy ¹H text").setIcon("copy").onClick(async () => { await navigator.clipboard.writeText(this.text("1H")); new Notice("Copied"); }));
    m.addItem((i) => i.setTitle("Copy ¹³C text").setIcon("copy").onClick(async () => { await navigator.clipboard.writeText(this.text("13C")); new Notice("Copied"); }));
    m.addItem((i) => i.setTitle("Copy peak list (CSV)").setIcon("sheet").onClick(async () => {
      const rows = ["nucleus,shift_ppm,multiplicity,J_Hz,n,atoms", ...[...this.pred.h, ...this.pred.c].map((s) => [s.nucleus, s.shift, s.mult, s.J.join(" "), s.n, s.label].join(","))];
      await navigator.clipboard.writeText(rows.join("\n")); new Notice("Peak list copied");
    }));
    m.addSeparator();
    m.addItem((i) => i.setTitle("Copy spectrum as PNG").setIcon("image").onClick(async () => {
      const svg = this.exportSvg(root); if (!svg) return;
      try { const blob = await svgToPngBlob(svg, this.plugin.settings.pngScale ?? 3); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); new Notice("PNG copied"); }
      catch { new Notice("Clipboard images are not supported here — use “Save spectrum as SVG”."); }
    }));
    m.addItem((i) => i.setTitle("Save spectrum as SVG").setIcon("download").onClick(async () => { const svg = this.exportSvg(root); if (svg) await this.plugin.saveExport(`NMR_${this.tab}.svg`, svg); }));
    m.showAtMouseEvent(e);
  }

  /** standalone SVG with resolved colours (black on white) for export */
  private exportSvg(root: HTMLElement): string | null {
    const s = root.querySelector(".ce-nmr-spec svg"); if (!s) return null;
    const css = `.ce-nmr-line,.ce-nmr-stick{fill:none;stroke:#1f4fbf;stroke-width:1.2}.ce-nmr-axis{stroke:#333;stroke-width:1}.ce-nmr-tick,.ce-nmr-int,.ce-nmr-lab,.ce-nmr-solvt{font:10px Arial,sans-serif;fill:#222}.ce-nmr-lead{fill:none;stroke:#777;stroke-width:.6}.ce-nmr-solv{stroke:#aaa;stroke-dasharray:3 3}.ce-nmr-hit,.ce-nmr-sigpath{fill:none;stroke:none}`;
    return serializeEl(s).replace(/^<svg([^>]*)>/, `<svg$1 width="1520" height="540"><style>${css}</style><rect width="100%" height="100%" fill="#fff"/>`).replace(/width="100%" preserveAspectRatio="xMidYMid meet"/, "");
  }

  private persist(set: Record<string, string>) { writeBlockOptions(this.plugin.app, this.containerEl, this.ctx, set).catch(() => {}); }
}

