// ELN dashboard: all experiments at a glance — search, status/project filters, stats, cards or table.

import { ItemView, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type ChemEditPlugin from "./main";
import { parseElnYaml } from "./eln";
import { calculateEln, ElnData, ElnCalc, fmtMass } from "../chem/eln";
import { parseAny } from "../chem/index";

export const DASHBOARD_VIEW = "chemedit-eln-dashboard";
interface Row { f: TFile; d: ElnData; calc: ElnCalc; text: string }

export class ElnDashboard extends ItemView {
  private rows: Row[] = [];
  private q = "";
  private status = "";
  private project = "";
  private mode: "cards" | "table" = "cards";
  private list!: HTMLElement;
  private stats!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: ChemEditPlugin) { super(leaf); }
  getViewType() { return DASHBOARD_VIEW; }
  getDisplayText() { return "ELN dashboard"; }
  getIcon() { return "flask-conical"; }

  async onOpen() {
    const reload = debounce(() => this.load(), 800, true);
    this.registerEvent(this.app.vault.on("modify", (f) => { if (f instanceof TFile && this.inFolder(f)) reload(); }));
    this.registerEvent(this.app.vault.on("create", (f) => { if (f instanceof TFile && this.inFolder(f)) reload(); }));
    this.registerEvent(this.app.vault.on("delete", () => reload()));
    await this.load();
  }

  private inFolder(f: TFile) { const fo = this.plugin.settings.elnFolder; return f.extension === "md" && (!fo || f.path.startsWith(fo + "/")); }

  async load() {
    const out: Row[] = [];
    for (const f of this.app.vault.getMarkdownFiles().filter((x) => this.inFolder(x))) {
      const txt = await this.app.vault.cachedRead(f);
      const m = /```eln\s*\n([\s\S]*?)\n```/.exec(txt);
      if (!m) continue;
      try { const d = parseElnYaml(m[1]); out.push({ f, d, calc: calculateEln(d), text: (f.basename + " " + txt).toLowerCase() }); } catch { /* skip */ }
    }
    out.sort((a, b) => (b.d.date ?? "").localeCompare(a.d.date ?? "") || b.f.stat.mtime - a.f.stat.mtime);
    this.rows = out;
    this.render();
  }

  private render() {
    const c = this.contentEl;
    c.empty();
    c.addClass("ce-dash");
    const top = c.createDiv({ cls: "ce-dash-top" });
    const s = top.createEl("input", { type: "search", placeholder: "Search code, compound, solvent, text…", value: this.q, cls: "ce-dash-search" });
    s.oninput = () => { this.q = s.value.toLowerCase(); this.drawList(); };
    const st = top.createEl("select", { cls: "dropdown" });
    st.createEl("option", { value: "", text: "All statuses" });
    for (const v of [...new Set(this.rows.map((r) => r.d.status ?? "Planned"))]) st.createEl("option", { value: v, text: v });
    st.value = this.status;
    st.onchange = () => { this.status = st.value; this.drawList(); };
    const pr = top.createEl("select", { cls: "dropdown" });
    pr.createEl("option", { value: "", text: "All projects" });
    for (const v of [...new Set(this.rows.map((r) => r.d.project).filter(Boolean))] as string[]) pr.createEl("option", { value: v, text: v });
    pr.value = this.project;
    pr.onchange = () => { this.project = pr.value; this.drawList(); };
    const mb = top.createEl("button", { attr: { "aria-label": "Cards / table" } });
    setIcon(mb, this.mode === "cards" ? "table" : "layout-grid");
    mb.onclick = () => { this.mode = this.mode === "cards" ? "table" : "cards"; this.render(); };
    const rb = top.createEl("button", { attr: { "aria-label": "Reload" } });
    setIcon(rb, "refresh-cw");
    rb.onclick = () => this.load();
    const nb = top.createEl("button", { text: "+ New experiment", cls: "mod-cta" });
    nb.onclick = () => this.plugin.newExperiment();
    this.stats = c.createDiv({ cls: "ce-dash-stats" });
    this.list = c.createDiv();
    this.drawList();
  }

  private filtered() {
    return this.rows.filter((r) => (!this.status || (r.d.status ?? "Planned") === this.status) && (!this.project || r.d.project === this.project) && (!this.q || this.q.split(/\s+/).every((w) => r.text.includes(w))));
  }

  private drawList() {
    const rows = this.filtered();
    this.stats.empty();
    const yields = rows.map((r) => r.calc.products[0]?.yieldPct).filter((y): y is number => y !== null && y !== undefined && isFinite(y));
    const count = (s: string) => rows.filter((r) => (r.d.status ?? "Planned") === s).length;
    const stat = (n: string | number, l: string) => { const b = this.stats.createDiv({ cls: "ce-dash-stat" }); b.createDiv({ cls: "ce-dash-n", text: String(n) }); b.createDiv({ cls: "ce-dash-l", text: l }); };
    stat(rows.length, "experiments");
    stat(count("Running") + count("Work-up") + count("Purification"), "in progress");
    stat(count("Completed"), "completed");
    stat(count("Failed"), "failed");
    stat(yields.length ? (yields.reduce((a, b) => a + b, 0) / yields.length).toFixed(0) + "%" : "–", "Ø yield");
    this.list.empty();
    if (!rows.length) { this.list.createDiv({ cls: "ce-eln-empty", text: this.rows.length ? "Nothing matches the filter." : `No experiments in “${this.plugin.settings.elnFolder}” yet.` }); return; }
    const open = (f: TFile) => this.app.workspace.getLeaf(false).openFile(f);
    const thumb = (el: HTMLElement, r: Row, h: number) => {
      const smi = r.calc.products.find((p) => p.src.smiles)?.src.smiles;
      if (smi) try { el.innerHTML = this.plugin.svgFor(parseAny(String(smi)), { maxHeight: h, padding: 2 }); } catch { /* */ }
    };
    const yld = (r: Row) => { const p = r.calc.products[0]; return p?.yieldPct !== null && p?.yieldPct !== undefined && isFinite(p.yieldPct) ? `${p.yieldPct.toFixed(0)}%` : "–"; };
    const badge = (el: HTMLElement, r: Row) => el.createSpan({ cls: `ce-eln-status ce-st-${(r.d.status ?? "Planned").toLowerCase().replace(/\s/g, "")}`, text: r.d.status ?? "Planned" });
    if (this.mode === "cards") {
      const g = this.list.createDiv({ cls: "ce-dash-grid" });
      for (const r of rows) {
        const card = g.createDiv({ cls: "ce-dash-card" });
        card.onclick = () => open(r.f);
        const h = card.createDiv({ cls: "ce-dash-card-h" });
        h.createSpan({ cls: "ce-eln-code", text: r.d.code || r.f.basename });
        badge(h, r);
        thumb(card.createDiv({ cls: "ce-dash-thumb" }), r, 90);
        card.createDiv({ cls: "ce-dash-title", text: r.d.title || r.calc.products[0]?.src.name || "" });
        const p = r.calc.products[0];
        card.createDiv({ cls: "ce-dash-meta", text: [r.d.date, r.d.project, `yield ${yld(r)}`, p?.isoMass ? fmtMass(p.isoMass) : ""].filter(Boolean).join(" · ") });
      }
    } else {
      const t = this.list.createDiv({ cls: "ce-eln-tablewrap" }).createEl("table", { cls: "ce-eln-table" });
      const hr = t.createEl("thead").createEl("tr");
      for (const x of ["Code", "Product", "Title", "Project", "Scale", "Yield", "Status", "Date"]) hr.createEl("th", { text: x });
      const tb = t.createEl("tbody");
      for (const r of rows) {
        const tr = tb.createEl("tr");
        const a = tr.createEl("td").createEl("a", { cls: "internal-link", text: r.d.code || r.f.basename });
        a.onclick = (e) => { e.preventDefault(); open(r.f); };
        thumb(tr.createEl("td", { cls: "ce-eln-thumb" }), r, 44);
        tr.createEl("td", { text: r.d.title ?? "" });
        tr.createEl("td", { text: r.d.project ?? "" });
        tr.createEl("td", { text: r.calc.refMmol !== null ? `${+r.calc.refMmol.toFixed(2)} mmol` : "" });
        tr.createEl("td", { text: yld(r) });
        badge(tr.createEl("td"), r);
        tr.createEl("td", { text: r.d.date ?? "" });
      }
    }
  }
}
