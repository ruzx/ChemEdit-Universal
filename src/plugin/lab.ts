// ChemEdit Lab — one workspace view with a sidebar, like a standalone LIMS/ELN:
// Overview · Experiments · Compounds · Inventory · Orders · Equipment · Protocols · Analytics · Gallery · Calculators.
// Records are ordinary Markdown notes with YAML front matter (folder or tag), so everything stays in the vault.

import { App, Component, FuzzySuggestModal, ItemView, Menu, Modal, Notice, Setting, TFile, WorkspaceLeaf, debounce, setIcon, stringifyYaml, normalizePath, MarkdownView } from "obsidian";
import type ChemEditPlugin from "./main";
import { parseElnYaml } from "./eln";
import { calculateEln, ElnData, ElnCalc, fmtMass } from "../chem/eln";
import { parseAny, docToSmiles, formatForExtension } from "../chem/index";
import { computeProperties, substructureMatch } from "../chem/props";
import { CALCS, CALC_BY_ID, MATRIX_EXAMPLE } from "../chem/calcs";
import { stripCarbonHydrogens, type ChemDoc } from "../chem/model";
import { SynthesisMap } from "./synthmap";
import { calcBlock } from "./calcview";

export const LAB_VIEW = "chemedit-lab";
export type PageId = "overview" | "experiments" | "synthesis" | "compounds" | "inventory" | "orders" | "equipment" | "protocols" | "analytics" | "gallery" | "calculators";

interface MField { k: string; l: string; t?: "text" | "num" | "date" | "select" | "smiles"; opts?: string[]; col?: boolean; ph?: string }
interface MAction { l: string; icon: string; when: (fm: any) => boolean; run: (fm: any, ctx: ActCtx) => void | Promise<void>; fm?: boolean }
interface ActCtx { plugin: ChemEditPlugin; user: string; today: string; rec: Rec; view: LabCore }
interface ModuleDef {
  id: PageId; title: string; sub: string; icon: string; folder: string; tags: string[]; newLabel: string;
  statuses?: string[]; fields: MField[]; structure?: boolean; actions?: MAction[];
  alert?: (fm: any, today: string) => string | null; body: (fm: any) => string;
}
export interface Rec { file: TFile; fm: any; title: string; status: string; smiles: string; search: string; module: PageId }

const today = () => (window as any).moment?.().format("YYYY-MM-DD") ?? new Date().toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 864e5;
const hasTag = (fm: any, tags: string[]) => { const t = fm?.tags; const arr = Array.isArray(t) ? t : typeof t === "string" ? t.split(/[\s,]+/) : []; return arr.some((x: string) => tags.includes(String(x).replace(/^#/, "").toLowerCase())); };

export const MODULES: ModuleDef[] = [
  {
    id: "compounds", title: "Compounds", sub: "Reference structures, building blocks and your products", icon: "hexagon", folder: "Library", tags: ["library", "compound"], newLabel: "Add compound", structure: true,
    fields: [{ k: "name", l: "Name", col: true }, { k: "smiles", l: "Structure (SMILES)", t: "smiles" }, { k: "code", l: "Code", col: true, ph: "RS-012" }, { k: "cas", l: "CAS", col: true }, { k: "project", l: "Project", col: true }, { k: "notes", l: "Notes" }],
    actions: [
      { l: "Copy SMILES", icon: "copy", when: (fm) => !!fm.smiles, run: async (fm) => { await navigator.clipboard.writeText(String(fm.smiles)); new Notice("SMILES copied"); } },
      { l: "Add to inventory", icon: "package-plus", when: () => true, run: (fm, c) => c.view.newRecord("inventory", { name: fm.name, smiles: fm.smiles, cas: fm.cas }) },
    ],
    body: (fm) => `# ${fm.name}\n\n\`\`\`smiles\n${fm.smiles ?? ""}\n\`\`\`\n\n## Properties & data\n\n\n## Used in\n\n`,
  },
  {
    id: "inventory", title: "Inventory", sub: "Reagents, stock levels, locations and expiry", icon: "package", folder: "Inventory", tags: ["inventory"], newLabel: "Add item", structure: true,
    statuses: ["Available", "Low", "Empty", "Checked out"],
    fields: [{ k: "name", l: "Name", col: true }, { k: "smiles", l: "Structure (SMILES)", t: "smiles" }, { k: "cas", l: "CAS", col: true }, { k: "supplier", l: "Supplier", col: true }, { k: "catalog", l: "Catalog #" }, { k: "lot", l: "Lot" }, { k: "location", l: "Location", col: true, ph: "Cabinet B / shelf 2" }, { k: "amount", l: "Amount", col: true, ph: "25 g" }, { k: "purity", l: "Purity", ph: "98%" }, { k: "expiry", l: "Expiry", t: "date" }, { k: "hazards", l: "Hazards (GHS)", ph: "H225, H314" }],
    actions: [
      { l: "Check out", icon: "log-out", when: (fm) => (fm.status ?? "Available") !== "Checked out", fm: true, run: (fm, c) => { fm.status = "Checked out"; fm.checked_out_by = c.user; fm.last_updated = c.today; } },
      { l: "Return", icon: "log-in", when: (fm) => fm.status === "Checked out", fm: true, run: (fm, c) => { fm.status = "Available"; fm.checked_out_by = ""; fm.last_updated = c.today; } },
      { l: "Mark low", icon: "battery-low", when: (fm) => fm.status !== "Low", fm: true, run: (fm, c) => { fm.status = "Low"; fm.last_updated = c.today; } },
      { l: "Find structure online (CAS/name)", icon: "search", when: (fm) => !fm.smiles, run: async (fm, c) => { const s = await c.plugin.resolveName(String(fm.cas || fm.name)); if (!s) { new Notice("Not found"); return; } await c.plugin.app.fileManager.processFrontMatter(c.rec.file, (x: any) => { x.smiles = s; const p = propsOf(s); if (p && !x.mw) x.mw = +p.mw.toFixed(3); }); new Notice("Structure added"); } },
      { l: "Reorder", icon: "shopping-cart", when: () => true, run: (fm, c) => c.view.newRecord("orders", { name: fm.name, supplier: fm.supplier, catalog: fm.catalog, type: "Chemical", amount: fm.amount }) },
    ],
    alert: (fm, t) => fm.status === "Empty" ? "Empty — reorder" : fm.status === "Low" ? "Low stock" : fm.expiry && daysBetween(t, String(fm.expiry)) < 0 ? "Expired" : fm.expiry && daysBetween(t, String(fm.expiry)) < 30 ? "Expires soon" : null,
    body: (fm) => `# ${fm.name}\n\n\`\`\`smiles\n${fm.smiles ?? ""}\n\`\`\`\n\n## Safety\n- Hazards: ${fm.hazards ?? ""}\n- SDS: \n\n## Usage log\n- ${today()}: added to inventory\n`,
  },
  {
    id: "orders", title: "Orders", sub: "Requests, purchases and deliveries", icon: "shopping-cart", folder: "Orders", tags: ["order"], newLabel: "New request",
    statuses: ["Planned", "Ordered", "Received", "Cancelled"],
    fields: [{ k: "name", l: "Item", col: true }, { k: "type", l: "Type", t: "select", opts: ["Chemical", "Consumable", "Equipment"], col: true }, { k: "supplier", l: "Supplier", col: true }, { k: "catalog", l: "Catalog #", col: true }, { k: "amount", l: "Amount", col: true }, { k: "price", l: "Price", col: true }, { k: "requester", l: "Requester" }, { k: "project", l: "Project / grant" }],
    actions: [
      { l: "Mark ordered", icon: "send", when: (fm) => (fm.status ?? "Planned") === "Planned", fm: true, run: (fm, c) => { fm.status = "Ordered"; fm.order_date = c.today; } },
      { l: "Mark received", icon: "package-check", when: (fm) => fm.status === "Ordered", fm: true, run: (fm, c) => { fm.status = "Received"; fm.receive_date = c.today; } },
      { l: "Add to inventory", icon: "package-plus", when: (fm) => fm.status === "Received" && (fm.type ?? "Chemical") === "Chemical", run: (fm, c) => c.view.newRecord("inventory", { name: fm.name, supplier: fm.supplier, catalog: fm.catalog, amount: fm.amount }) },
    ],
    alert: (fm, t) => fm.status === "Ordered" && fm.order_date && daysBetween(String(fm.order_date), t) > 21 ? "Ordered > 3 weeks ago" : null,
    body: (fm) => `# ${fm.name}\n\n## Quote / links\n- \n\n## Notes\n- Why is this needed?\n`,
  },
  {
    id: "equipment", title: "Equipment", sub: "Instruments, bookings and maintenance", icon: "microscope", folder: "Equipment", tags: ["equipment"], newLabel: "Add instrument",
    statuses: ["Available", "In use", "Maintenance"],
    fields: [{ k: "name", l: "Instrument", col: true }, { k: "location", l: "Location", col: true }, { k: "contact", l: "Responsible", col: true }, { k: "next_maintenance", l: "Next maintenance", t: "date", col: true }, { k: "manual", l: "Manual link" }],
    actions: [
      { l: "Book", icon: "calendar-plus", when: (fm) => (fm.status ?? "Available") === "Available", fm: true, run: (fm, c) => { fm.status = "In use"; fm.booked_by = c.user; fm.booked_at = c.today; } },
      { l: "Release", icon: "calendar-check", when: (fm) => fm.status === "In use", fm: true, run: (fm) => { fm.status = "Available"; fm.booked_by = ""; } },
      { l: "Maintenance", icon: "wrench", when: (fm) => fm.status !== "Maintenance", fm: true, run: (fm) => { fm.status = "Maintenance"; } },
      { l: "Back in service", icon: "check-circle", when: (fm) => fm.status === "Maintenance", fm: true, run: (fm, c) => { fm.status = "Available"; fm.last_maintenance = c.today; fm.next_maintenance = (window as any).moment?.().add(1, "year").format("YYYY-MM-DD") ?? ""; } },
    ],
    alert: (fm, t) => fm.status === "Maintenance" ? "In maintenance" : fm.next_maintenance && daysBetween(t, String(fm.next_maintenance)) < 0 ? "Maintenance overdue" : fm.next_maintenance && daysBetween(t, String(fm.next_maintenance)) < 14 ? "Maintenance due soon" : null,
    body: (fm) => `# ${fm.name}\n\n## Standard operating procedure\n1. \n\n## Links\n- Manual: ${fm.manual ?? ""}\n\n## Service log\n- ${today()}: added\n`,
  },
  {
    id: "protocols", title: "Protocols", sub: "SOPs, methods and safety procedures", icon: "file-text", folder: "Protocols", tags: ["protocol", "sop"], newLabel: "New protocol",
    statuses: ["Draft", "Approved", "Obsolete"],
    fields: [{ k: "name", l: "Title", col: true }, { k: "author", l: "Author", col: true }, { k: "version", l: "Version", col: true, ph: "1.0" }, { k: "category", l: "Category", t: "select", opts: ["Synthesis", "Analytics", "Safety", "Instrument", "Waste", "Other"], col: true }, { k: "last_reviewed", l: "Last reviewed", t: "date", col: true }],
    actions: [
      { l: "Approve / reviewed", icon: "badge-check", when: (fm) => fm.status !== "Obsolete", fm: true, run: (fm, c) => { fm.status = "Approved"; fm.last_reviewed = c.today; fm.reviewed_by = c.user; } },
      { l: "Mark obsolete", icon: "archive", when: (fm) => fm.status !== "Obsolete", fm: true, run: (fm) => { fm.status = "Obsolete"; } },
    ],
    alert: (fm, t) => fm.status === "Approved" && fm.last_reviewed && daysBetween(String(fm.last_reviewed), t) > 365 ? "Review overdue (> 1 year)" : fm.status === "Draft" ? "Draft — needs approval" : null,
    body: (fm) => `# ${fm.name}\n\n## Scope\n\n## Safety precautions\n- PPE: lab coat, goggles, gloves\n\n## Materials\n- \n\n## Procedure\n1. \n\n## Waste disposal\n- \n\n## Revision history\n| Version | Date | Author | Change |\n|---|---|---|---|\n| ${fm.version ?? "1.0"} | ${today()} | ${fm.author ?? ""} | Created |\n`,
  },
  {
    id: "analytics", title: "Analytics", sub: "Characterisation status of your compounds — publication readiness", icon: "bar-chart-3", folder: "Characterization", tags: ["characterization", "compound"], newLabel: "Add compound", structure: true,
    fields: [{ k: "name", l: "Compound", col: true }, { k: "smiles", l: "Structure (SMILES)", t: "smiles" }, { k: "code", l: "Code" }],
    body: (fm) => `# ${fm.name}\n\n\`\`\`smiles\n${fm.smiles ?? ""}\n\`\`\`\n\n## Spectra\n- ¹H NMR: \n- ¹³C NMR: \n- HRMS: \n`,
  },
];
const MOD = new Map(MODULES.map((m) => [m.id, m]));

const NAV: Array<{ id: PageId; l: string; icon: string; sep?: string }> = [
  { id: "overview", l: "Overview", icon: "layout-dashboard" },
  { id: "experiments", l: "Experiments", icon: "flask-conical", sep: "Notebook" },
  { id: "synthesis", l: "Synthesis map", icon: "git-fork" },
  { id: "compounds", l: "Compounds", icon: "hexagon" },
  { id: "analytics", l: "Analytics", icon: "bar-chart-3" },
  { id: "gallery", l: "Gallery", icon: "images" },
  { id: "inventory", l: "Inventory", icon: "package", sep: "Lab management" },
  { id: "orders", l: "Orders", icon: "shopping-cart" },
  { id: "equipment", l: "Equipment", icon: "microscope" },
  { id: "protocols", l: "Protocols", icon: "file-text" },
  { id: "calculators", l: "Calculators", icon: "calculator", sep: "Tools" },
];

interface ExpRow { f: TFile; d: ElnData; calc: ElnCalc; text: string }

/** Options for an embedded Lab page (code blocks such as ```chem-db``` / ```chem-gallery``` / ```eln-gallery```). */
export interface LabEmbedOpts { page: PageId; folder?: string; mode?: "cards" | "table"; filter?: string; query?: string; limit?: number; title?: string }

/** ChemEdit Lab as a full workspace view (sidebar + pages). */
export class LabView extends ItemView {
  core: LabCore;
  constructor(leaf: WorkspaceLeaf, private plugin: ChemEditPlugin) { super(leaf); this.core = new LabCore(plugin); }
  getViewType() { return LAB_VIEW; }
  getDisplayText() { return "ChemEdit Lab"; }
  getIcon() { return "flask-conical"; }
  getState() { return { page: this.core.page, focus: this.core.focus }; }
  async setState(s: any, r: any) { if (s?.page) this.core.page = s.page; this.core.focus = s?.focus; this.core.refreshAll(); return (ItemView.prototype as any).setState?.call(this, s, r); }
  async onOpen() { this.addChild(this.core); this.core.mount(this.contentEl); }
  async onClose() { this.removeChild(this.core); }
  go(p: PageId, focus?: string) { this.core.go(p, focus); }
}

/** The Lab engine. Used by the workspace view (with navigation) and embedded in notes (single page, fixed folder). */
export class LabCore extends Component {
  page: PageId = "overview";
  app: App;
  private main!: HTMLElement;
  private nav: HTMLElement | null = null;
  private observer: IntersectionObserver | null = null;
  private q = "";
  private filter = "";
  private mode: "cards" | "table" = "table";
  private subQuery: ChemDoc | null = null;
  private expCache: ExpRow[] | null = null;
  private lastMd: MarkdownView | null = null;
  focus: string | undefined;

  constructor(public plugin: ChemEditPlugin, public embed: LabEmbedOpts | null = null) {
    super();
    this.app = plugin.app;
    if (embed) { this.page = embed.page; this.mode = embed.mode ?? (MOD.get(embed.page)?.structure || embed.page === "experiments" ? "cards" : "table"); this.filter = embed.filter ?? ""; this.q = (embed.query ?? "").toLowerCase(); }
  }
  /** folder for a module: the embed's folder for its own page, otherwise the settings */
  folderOf(id: PageId | "gallery"): string {
    if (this.embed?.folder !== undefined && this.embed.page === id) return this.embed.folder.replace(/\/$/, "");
    if (id === "experiments") return this.plugin.settings.elnFolder;
    return ((this.plugin.settings.labFolders as any)?.[id] ?? MOD.get(id as PageId)?.folder ?? "").replace(/\/$/, "");
  }
  private get fixedFolder() { return this.embed?.folder !== undefined; }
  refreshAll() { if (this.main) { this.drawNav(); this.renderPage(); } }

  mount(c: HTMLElement) {
    c.empty();
    c.addClass("ce-lab");
    if (this.embed) c.addClass("is-embed");
    else this.nav = c.createDiv({ cls: "ce-lab-nav" });
    this.main = c.createDiv({ cls: "ce-lab-main" });
    this.drawNav();
    const live = (p: PageId) => p !== "gallery" && p !== "synthesis" && p !== "calculators";
    const refresh = debounce(() => { this.expCache = null; if (live(this.page)) this.renderPage(true); }, 1500, true);
    this.registerEvent(this.app.metadataCache.on("changed", () => refresh()));
    this.registerEvent(this.app.vault.on("delete", () => refresh()));
    this.registerEvent(this.app.vault.on("rename", () => refresh()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf: any) => { if (leaf?.view instanceof MarkdownView) this.lastMd = leaf.view; }));
    this.renderPage();
  }
  onunload() { this.observer?.disconnect(); }

  go(p: PageId, focus?: string) { this.focus = focus; this.page = p; this.q = ""; this.filter = ""; this.subQuery = null; this.mode = MOD.get(p)?.structure ? "cards" : "table"; this.drawNav(); this.renderPage(); }

  private drawNav() {
    const n = this.nav;
    if (!n) return;
    n.empty();
    const brand = n.createDiv({ cls: "ce-lab-brand" });
    setIcon(brand.createSpan({ cls: "ce-lab-logo" }), "hexagon");
    brand.createSpan({ text: "ChemEdit Lab" });
    for (const it of NAV) {
      if (it.sep) n.createDiv({ cls: "ce-lab-sep", text: it.sep });
      const b = n.createDiv({ cls: "ce-lab-navitem" + (it.id === this.page ? " is-active" : ""), attr: { role: "button", tabindex: "0" } });
      setIcon(b.createSpan({ cls: "ce-lab-navicon" }), it.icon);
      b.createSpan({ cls: "ce-lab-navlabel", text: it.l });
      b.onclick = () => this.go(it.id);
    }
    const foot = n.createDiv({ cls: "ce-lab-navfoot" });
    const s = foot.createDiv({ cls: "ce-lab-navitem", attr: { role: "button" } });
    setIcon(s.createSpan({ cls: "ce-lab-navicon" }), "settings");
    s.createSpan({ cls: "ce-lab-navlabel", text: "Settings" });
    s.onclick = () => { const st = (this.app as any).setting; st?.open?.(); st?.openTabById?.(this.plugin.manifest.id); };
  }

  // ---------------------------------------------------------------- data

  records(id: PageId): Rec[] {
    const m = MOD.get(id)!;
    const folder = this.folderOf(id);
    const tagsToo = !(this.fixedFolder && this.embed!.page === id);
    const out: Rec[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter ?? null;
      const inFolder = folder && f.path.startsWith(folder + "/");
      if (!inFolder && !(tagsToo && fm && hasTag(fm, m.tags))) continue;
      const d: any = fm ?? {};
      const title = String(d.name ?? d.title ?? f.basename);
      out.push({ file: f, fm: d, title, status: String(d.status ?? m.statuses?.[0] ?? ""), smiles: String(d.smiles ?? ""), module: id, search: [title, f.basename, ...m.fields.map((x) => d[x.k] ?? ""), d.status ?? ""].join(" ").toLowerCase() });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  private async experiments(): Promise<ExpRow[]> {
    if (this.expCache) return this.expCache;
    const folder = this.folderOf("experiments");
    const tagsToo = !(this.fixedFolder && this.embed!.page === "experiments");
    const out: ExpRow[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (!(folder && f.path.startsWith(folder + "/")) && !(tagsToo && fm && hasTag(fm, ["experiment"]))) continue;
      const txt = await this.app.vault.cachedRead(f);
      const m = /```eln\s*\n([\s\S]*?)\n```/.exec(txt);
      if (!m) continue;
      try { const d = parseElnYaml(m[1]); out.push({ f, d, calc: calculateEln(d), text: (f.basename + " " + txt.slice(0, 4000)).toLowerCase() }); } catch { /* skip */ }
    }
    out.sort((a, b) => (b.d.date ?? "").localeCompare(a.d.date ?? "") || b.f.stat.mtime - a.f.stat.mtime);
    return (this.expCache = out);
  }

  // ---------------------------------------------------------------- page chrome

  private async renderPage(soft = false) {
    if (!this.main) return;
    const scroll = soft ? this.main.scrollTop : 0;
    this.observer?.disconnect();
    this.queue = [];
    this.observer = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) this.lazyRender(e.target as HTMLElement); }), { root: this.embed ? null : this.main, rootMargin: "200px" });
    this.main.empty();
    this.main.removeClass("is-full");
    const p = this.page;
    if (p === "overview") await this.pageOverview();
    else if (p === "experiments") await this.pageExperiments();
    else if (p === "gallery") await this.pageGallery();
    else if (p === "synthesis") { this.main.addClass("is-full"); const m = new SynthesisMap(this.plugin, this.main.createDiv(), { focus: this.focus }); await m.load(); }
    else if (p === "calculators") this.pageCalculators();
    else if (p === "analytics") this.pageAnalytics();
    else this.pageModule(MOD.get(p)!);
    this.main.scrollTop = scroll;
  }

  private head(title: string, sub: string, action?: { l: string; run: () => void }, extra?: (el: HTMLElement) => void) {
    if (this.embed) { title = this.embed.title ?? title; const fo = this.folderOf(this.embed.page); sub = fo ? `📁 ${fo}` : sub; }
    const h = this.main.createDiv({ cls: "ce-lab-head" });
    const t = h.createDiv({ cls: "ce-lab-titles" });
    t.createEl("h2", { text: title });
    t.createDiv({ cls: "ce-lab-sub", text: sub });
    const a = h.createDiv({ cls: "ce-lab-headactions" });
    extra?.(a);
    if (action) { const b = a.createEl("button", { cls: "mod-cta", text: "+ " + action.l }); b.onclick = action.run; }
  }

  private toolbar(opts: { statuses?: string[]; counts?: Map<string, number>; placeholder: string; modes?: boolean; onChange: () => void; extra?: (el: HTMLElement) => void }) {
    const tb = this.main.createDiv({ cls: "ce-lab-toolbar" });
    if (opts.statuses?.length) {
      const chips = tb.createDiv({ cls: "ce-lab-chips" });
      for (const s of ["", ...opts.statuses]) {
        const c = chips.createEl("button", { cls: "ce-lab-chip" + (this.filter === s ? " is-on" : ""), text: (s || "All") + (opts.counts ? ` ${s ? opts.counts.get(s) ?? 0 : [...opts.counts.values()].reduce((a, b) => a + b, 0)}` : "") });
        c.onclick = () => { this.filter = s; chips.querySelectorAll(".ce-lab-chip").forEach((x) => (x as HTMLElement).removeClass("is-on")); c.addClass("is-on"); opts.onChange(); };
      }
    }
    const right = tb.createDiv({ cls: "ce-lab-tbright" });
    opts.extra?.(right);
    const s = right.createEl("input", { type: "search", cls: "ce-lab-search", value: this.q, attr: { placeholder: opts.placeholder } });
    s.oninput = () => { this.q = s.value.toLowerCase(); opts.onChange(); };
    if (opts.modes) {
      const mb = right.createEl("button", { cls: "clickable-icon", attr: { "aria-label": this.mode === "cards" ? "Table view" : "Card view" } });
      setIcon(mb, this.mode === "cards" ? "table-2" : "layout-grid");
      mb.onclick = () => { this.mode = this.mode === "cards" ? "table" : "cards"; this.renderPage(); };
    }
  }

  private badge(el: HTMLElement, status: string, onClick?: (e: MouseEvent) => void) {
    const b = el.createSpan({ cls: `ce-lab-badge ce-st-${status.toLowerCase().replace(/[^a-z]/g, "")}`, text: status || "–" });
    if (onClick) { b.addClass("is-click"); b.onclick = (e) => { e.stopPropagation(); onClick(e); }; }
    return b;
  }

  private structSlot(el: HTMLElement, data: string, h = 90) {
    const s = el.createDiv({ cls: "ce-lab-struct" });
    if (!data.trim()) { s.addClass("is-empty"); setIcon(s, "hexagon"); return s; }
    s.dataset.struct = data;
    s.dataset.h = String(h);
    this.observer?.observe(s);
    return s;
  }
  private queue: HTMLElement[] = [];
  private pumping = false;
  private lazyRender(el: HTMLElement) {
    if (el.dataset.done) return;
    el.dataset.done = "1";
    this.observer?.unobserve(el);
    this.queue.push(el);
    if (!this.pumping) { this.pumping = true; window.requestAnimationFrame(() => this.pump()); }
  }
  /** render a few structures per frame (≤ 10 ms) so big vaults never block the UI */
  private pump() {
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < 10) {
      const el = this.queue.shift()!;
      if (!el.isConnected) continue;
      if (el.dataset.file && !el.dataset.struct) { this.loadFileStruct(el); continue; }
      this.drawStruct(el);
    }
    if (this.queue.length) window.requestAnimationFrame(() => this.pump()); else this.pumping = false;
  }
  private drawStruct(el: HTMLElement) {
    const key = (el.dataset.key ?? el.dataset.struct!) + "|" + el.dataset.h;
    let svg = SVG_CACHE.get(key);
    if (svg === undefined) {
      try {
        const doc = parseAny(el.dataset.struct!, (el.dataset.fmt as any) ?? "auto");
        if (!doc.atoms.length) throw new Error("no atoms");
        svg = this.plugin.svgFor(stripCarbonHydrogens(doc), { maxHeight: +(el.dataset.h ?? 90), padding: 3 });
      } catch { svg = ""; }
      if (SVG_CACHE.size > 3000) SVG_CACHE.clear();
      SVG_CACHE.set(key, svg);
    }
    delete el.dataset.struct;
    el.removeClass("is-loading");
    if (svg) el.innerHTML = svg;
    else { el.addClass("is-empty", "is-error"); el.setText("no preview (open file)"); }
  }
  private async loadFileStruct(el: HTMLElement) {
    const tf = this.app.vault.getAbstractFileByPath(el.dataset.file!);
    if (!(tf instanceof TFile)) return;
    const key = tf.path + "@" + tf.stat.mtime;
    el.dataset.key = key;
    if (SVG_CACHE.has(key + "|" + el.dataset.h)) { el.dataset.struct = "cached"; this.queue.unshift(el); return; }
    if (tf.stat.size > 400_000) { el.removeClass("is-loading"); el.addClass("is-empty"); el.setText("large file — open to view"); return; }
    let t = await this.app.vault.cachedRead(tf);
    const ext = tf.extension.toLowerCase();
    if (ext === "sdf" || ext === "sd") { const i = t.indexOf("$$$$"); if (i > 0) t = t.slice(0, i); }
    el.dataset.struct = t;
    el.dataset.fmt = ext === "sdf" || ext === "sd" ? "mol" : formatForExtension(ext);
    this.queue.unshift(el);
    if (!this.pumping) { this.pumping = true; window.requestAnimationFrame(() => this.pump()); }
  }

  openNote(f: TFile) { this.app.workspace.getLeaf(false).openFile(f); }

  // ---------------------------------------------------------------- overview

  private async pageOverview() {
    const t = today();
    const hour = new Date().getHours();
    this.head(`${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}${this.plugin.settings.userName ? ", " + this.plugin.settings.userName : ""}`, (window as any).moment?.().format("dddd, D MMMM YYYY") ?? t, { l: "New experiment", run: () => this.plugin.newExperiment() });
    const exps = await this.experiments();
    const recs = Object.fromEntries(MODULES.map((m) => [m.id, this.records(m.id)])) as Record<string, Rec[]>;
    const month = t.slice(0, 7);
    const yields = exps.map((e) => e.calc.products[0]?.yieldPct).filter((y): y is number => typeof y === "number" && isFinite(y));
    const kpi = this.main.createDiv({ cls: "ce-lab-kpis" });
    const tile = (icon: string, v: string | number, l: string, go?: PageId, tone = "") => {
      const k = kpi.createDiv({ cls: "ce-lab-kpi " + tone });
      setIcon(k.createDiv({ cls: "ce-lab-kpiicon" }), icon);
      k.createDiv({ cls: "ce-lab-kpiv", text: String(v) });
      k.createDiv({ cls: "ce-lab-kpil", text: l });
      if (go) { k.addClass("is-click"); k.onclick = () => this.go(go); }
    };
    const active = exps.filter((e) => /running|work|purif/i.test(e.d.status ?? "")).length;
    tile("flask-conical", active, "experiments in progress", "experiments", active ? "is-accent" : "");
    tile("check-circle-2", exps.filter((e) => e.d.status === "Completed" && String(e.d.date ?? "").startsWith(month)).length, "completed this month", "experiments");
    tile("percent", yields.length ? (yields.reduce((a, b) => a + b, 0) / yields.length).toFixed(0) + "%" : "–", "average isolated yield", "experiments");
    tile("hexagon", recs.compounds.length, "compounds", "compounds");
    const low = recs.inventory.filter((r) => /low|empty/i.test(r.status)).length;
    tile("package", recs.inventory.length, low ? `inventory items · ${low} low` : "inventory items", "inventory", low ? "is-warn" : "");
    const pend = recs.orders.filter((r) => r.status === "Planned" || r.status === "Ordered").length;
    tile("shopping-cart", pend, "open orders", "orders");

    const cols = this.main.createDiv({ cls: "ce-lab-cols" });
    // attention
    const att = cols.createDiv({ cls: "ce-lab-panel" });
    att.createDiv({ cls: "ce-lab-panelh", text: "Needs attention" });
    const alerts: Array<{ r: Rec; msg: string; icon: string }> = [];
    for (const m of MODULES) if (m.alert) for (const r of recs[m.id]) { const a = m.alert(r.fm, t); if (a) alerts.push({ r, msg: a, icon: m.icon }); }
    for (const e of exps) if (e.d.status === "Running" && e.d.started && daysBetween(String(e.d.started).slice(0, 10), t) > 3) alerts.push({ r: { file: e.f, title: e.d.code ?? e.f.basename } as Rec, msg: "Running > 3 days", icon: "flask-conical" });
    if (!alerts.length) att.createDiv({ cls: "ce-lab-empty", text: "All good — nothing needs attention." });
    for (const a of alerts.slice(0, 12)) {
      const row = att.createDiv({ cls: "ce-lab-alert" });
      setIcon(row.createSpan({ cls: "ce-lab-alerticon" }), a.icon);
      row.createSpan({ cls: "ce-lab-alertt", text: a.r.title });
      row.createSpan({ cls: "ce-lab-alertm", text: a.msg });
      row.onclick = () => this.openNote(a.r.file);
    }
    // recent experiments
    const rec = cols.createDiv({ cls: "ce-lab-panel" });
    const rh = rec.createDiv({ cls: "ce-lab-panelh" });
    rh.createSpan({ text: "Recent experiments" });
    const all = rh.createEl("a", { text: "View all →" }); all.onclick = () => this.go("experiments");
    if (!exps.length) rec.createDiv({ cls: "ce-lab-empty", text: `No experiments yet in “${this.plugin.settings.elnFolder}”.` });
    for (const e of exps.slice(0, 6)) {
      const row = rec.createDiv({ cls: "ce-lab-recent" });
      const smi = e.calc.products.find((p) => p.src.smiles)?.src.smiles;
      this.structSlot(row, smi ? String(smi) : "", 46);
      const tx = row.createDiv({ cls: "ce-lab-recentt" });
      tx.createDiv({ cls: "ce-lab-strong", text: `${e.d.code ?? e.f.basename}${e.d.title ? " · " + e.d.title : ""}` });
      tx.createDiv({ cls: "ce-lab-muted", text: [e.d.date, e.d.project].filter(Boolean).join(" · ") });
      this.badge(row, e.d.status ?? "Planned");
      row.onclick = () => this.openNote(e.f);
    }
    // quick actions
    const qa = this.main.createDiv({ cls: "ce-lab-panel" });
    qa.createDiv({ cls: "ce-lab-panelh", text: "Quick actions" });
    const qr = qa.createDiv({ cls: "ce-lab-quick" });
    const q = (icon: string, l: string, run: () => void) => { const b = qr.createEl("button", { cls: "ce-lab-quickbtn" }); setIcon(b.createSpan(), icon); b.createSpan({ text: l }); b.onclick = run; };
    q("flask-conical", "New experiment", () => this.plugin.newExperiment());
    q("pen-tool", "Experiment from drawing", () => (this.app as any).commands?.executeCommandById?.(`${this.plugin.manifest.id}:new-experiment-from-drawing`));
    q("hexagon", "Add compound", () => this.newRecord("compounds"));
    q("package-plus", "Add inventory item", () => this.newRecord("inventory"));
    q("shopping-cart", "New order", () => this.newRecord("orders"));
    q("git-fork", "Synthesis map", () => this.go("synthesis"));
    q("calculator", "Calculators", () => this.go("calculators"));
  }

  // ---------------------------------------------------------------- experiments

  private async pageExperiments() {
    this.head("Experiments", "Your electronic lab notebook", { l: "New experiment", run: () => this.plugin.newExperiment() });
    const rows = await this.experiments();
    const sts = ["Planned", "Running", "Work-up", "Purification", "Completed", "Failed"];
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.d.status ?? "Planned", (counts.get(r.d.status ?? "Planned") ?? 0) + 1);
    const projects = [...new Set(rows.map((r) => r.d.project).filter(Boolean))] as string[];
    let project = "";
    let lim = this.embed?.limit ?? Infinity;
    const list = () => {
      body.empty();
      const fAll = rows.filter((r) => (!this.filter || (r.d.status ?? "Planned") === this.filter) && (!project || r.d.project === project) && (!this.q || this.q.split(/\s+/).every((w) => r.text.includes(w))));
      const f = fAll.slice(0, lim);
      const tok = ((body as any)._tok = ((body as any)._tok ?? 0) + 1);
      if (fAll.length > lim) window.setTimeout(() => { if ((body as any)._tok !== tok) return; const more = body.createEl("button", { cls: "ce-lab-more", text: `Show more (${fAll.length - lim} left)` }); more.onclick = () => { lim += Math.max(6, this.embed?.limit ?? 12); list(); }; }, 0);
      if (!f.length) { body.createDiv({ cls: "ce-lab-empty", text: rows.length ? "Nothing matches the filter." : `No experiments in “${this.folderOf("experiments")}” yet. Create one with “+ New experiment”.` }); return; }
      const yld = (r: ExpRow) => { const p = r.calc.products[0]; return p?.yieldPct !== null && p?.yieldPct !== undefined && isFinite(p.yieldPct) ? `${p.yieldPct.toFixed(0)}%` : "–"; };
      const scheme = (r: ExpRow) => { const rs = (r.d.reactants ?? []).filter((c) => c.smiles && (c.role ?? "reactant") === "reactant").map((c) => c.smiles).join("."); const ps = (r.d.products ?? []).filter((c) => c.smiles).map((c) => c.smiles).join("."); return rs || ps ? `${rs}>>${ps}` : ""; };
      const setStatus = (r: ExpRow, e: MouseEvent) => { const m = new Menu(); for (const s of sts) m.addItem((i) => i.setTitle(s).onClick(() => this.setElnStatus(r.f, s))); m.showAtMouseEvent(e); };
      if (this.mode === "cards") {
        const g = body.createDiv({ cls: "ce-lab-grid" });
        for (const r of f) {
          const c = g.createDiv({ cls: "ce-lab-card" });
          c.onclick = () => this.openNote(r.f);
          const h = c.createDiv({ cls: "ce-lab-cardh" });
          h.createSpan({ cls: "ce-lab-code", text: r.d.code ?? r.f.basename });
          this.badge(h, r.d.status ?? "Planned", (e) => setStatus(r, e));
          this.structSlot(c, scheme(r), 80);
          c.createDiv({ cls: "ce-lab-strong", text: r.d.title ?? r.calc.products[0]?.src.name ?? "" });
          c.createDiv({ cls: "ce-lab-muted", text: [r.d.date, r.d.project, `yield ${yld(r)}`].filter(Boolean).join(" · ") });
        }
      } else {
        const t = body.createDiv({ cls: "ce-lab-tablewrap" }).createEl("table", { cls: "ce-lab-table" });
        const hr = t.createEl("thead").createEl("tr");
        for (const x of ["Code", "Reaction", "Title", "Project", "Scale", "Yield", "Date", "Status"]) hr.createEl("th", { text: x });
        const tb = t.createEl("tbody");
        for (const r of f) {
          const tr = tb.createEl("tr");
          tr.onclick = () => this.openNote(r.f);
          tr.createEl("td", { cls: "ce-lab-code", text: r.d.code ?? r.f.basename });
          this.structSlot(tr.createEl("td", { cls: "ce-lab-tdstruct is-wide" }), scheme(r), 56);
          tr.createEl("td", { text: r.d.title ?? "" });
          tr.createEl("td", { text: r.d.project ?? "" });
          tr.createEl("td", { text: r.calc.refMmol !== null ? `${+r.calc.refMmol.toFixed(2)} mmol` : "" });
          tr.createEl("td", { cls: "ce-lab-num", text: yld(r) });
          tr.createEl("td", { cls: "ce-lab-muted", text: r.d.date ?? "" });
          this.badge(tr.createEl("td"), r.d.status ?? "Planned", (e) => setStatus(r, e));
        }
      }
    };
    this.toolbar({ statuses: sts, counts, placeholder: "Search code, compound, solvent, text…", modes: true, onChange: list, extra: (el) => {
      if (!projects.length) return;
      const s = el.createEl("select", { cls: "dropdown" });
      s.createEl("option", { value: "", text: "All projects" });
      for (const p of projects) s.createEl("option", { value: p, text: p });
      s.onchange = () => { project = s.value; list(); };
    } });
    const body = this.main.createDiv({ cls: "ce-lab-body" });
    list();
  }

  private async setElnStatus(f: TFile, s: string) {
    await this.app.vault.process(f, (txt) => txt.replace(/(```eln\s*\n[\s\S]*?)(^status:.*$)/m, `$1status: ${s}`).replace(/^(```eln\s*\n)(?![\s\S]*?^status:)/m, `$1status: ${s}\n`));
    await this.app.fileManager.processFrontMatter(f, (fm: any) => { if ("status" in fm) fm.status = s; });
    new Notice(`Status → ${s}`);
  }

  // ---------------------------------------------------------------- generic record module

  private pageModule(m: ModuleDef) {
    const recs = this.records(m.id);
    const extra = (el: HTMLElement) => {
      const fb = el.createEl("button", { cls: "clickable-icon", attr: { "aria-label": `Folder: ${this.folderOf(m.id)}` } });
      setIcon(fb, "folder-open");
      if (this.fixedFolder) fb.remove();
      fb.onclick = () => new FolderPrompt(this.app, m.title, this.folderOf(m.id), async (v) => { this.plugin.settings.labFolders = { ...(this.plugin.settings.labFolders ?? {}), [m.id]: v }; await this.plugin.saveSettings(); this.renderPage(); }).open();
      if (m.id === "inventory" || m.id === "compounds") {
        const ib = el.createEl("button", { cls: "ce-lab-importbtn", attr: { "aria-label": "Import a CSV export (e.g. KLARA / ChemInventory): name, CAS, SMILES, MW, amount, location…" } });
        setIcon(ib.createSpan(), "file-up"); ib.createSpan({ text: "Import CSV" });
        ib.onclick = () => {
          const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".csv,.tsv,.txt"; inp.multiple = true;
          inp.onchange = async () => {
            let total = 0, skipped = 0;
            for (const file of Array.from(inp.files ?? [])) { const r = await importCsv(this.plugin, m, this.folderOf(m.id), await file.text()); total += r.created; skipped += r.skipped; }
            new Notice(`Imported ${total} item(s)${skipped ? `, ${skipped} already present` : ""}`);
            window.setTimeout(() => this.renderPage(), 800);
          };
          inp.click();
        };
      }
      const ex = el.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Copy table (Excel)" } });
      setIcon(ex, "sheet");
      ex.onclick = async () => {
        const cols = m.fields.filter((f) => f.t !== "smiles" || m.structure);
        const lines = [["file", "status", ...cols.map((c) => c.l)].join("\t"), ...recs.map((r) => [r.file.basename, r.status, ...cols.map((c) => String(r.fm[c.k] ?? ""))].join("\t"))];
        await navigator.clipboard.writeText(lines.join("\n")); new Notice(`${recs.length} rows copied`);
      };
    };
    this.head(m.title, m.sub, { l: m.newLabel, run: () => this.newRecord(m.id) }, extra);
    const counts = new Map<string, number>();
    for (const r of recs) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    const list = () => {
      body.empty();
      let f = recs.filter((r) => (!this.filter || r.status === this.filter) && (!this.q || this.q.split(/\s+/).every((w) => r.search.includes(w))));
      if (this.subQuery) f = f.filter((r) => { try { return r.smiles && substructureMatch(parseAny(r.smiles), this.subQuery!); } catch { return false; } });
      if (!f.length) {
        const e = body.createDiv({ cls: "ce-lab-emptybig" });
        setIcon(e.createDiv({ cls: "ce-lab-emptyicon" }), m.icon);
        e.createDiv({ text: recs.length ? "Nothing matches the filter." : `No ${m.title.toLowerCase()} yet.` });
        if (!recs.length) { e.createDiv({ cls: "ce-lab-muted", text: `Notes in “${this.folderOf(m.id)}/” or tagged #${m.tags[0]} appear here.` }); const b = e.createEl("button", { cls: "mod-cta", text: "+ " + m.newLabel }); b.onclick = () => this.newRecord(m.id); }
        return;
      }
      const t0 = today();
      const statusMenu = (r: Rec, e: MouseEvent) => { if (!m.statuses) return; const mm = new Menu(); for (const s of m.statuses) mm.addItem((i) => i.setTitle(s).onClick(() => this.app.fileManager.processFrontMatter(r.file, (fm: any) => { fm.status = s; fm.last_updated = t0; }))); mm.showAtMouseEvent(e); };
      const actions = (el: HTMLElement, r: Rec) => {
        const acts = (m.actions ?? []).filter((a) => a.when(r.fm));
        const wrap = el.createDiv({ cls: "ce-lab-acts" });
        for (const a of acts.slice(0, 2)) {
          const b = wrap.createEl("button", { cls: "ce-lab-act", attr: { "aria-label": a.l } });
          setIcon(b.createSpan(), a.icon); b.createSpan({ cls: "ce-lab-actl", text: a.l });
          b.onclick = (e) => { e.stopPropagation(); this.runAction(a, r); };
        }
        const more = wrap.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "More" } });
        setIcon(more, "more-horizontal");
        more.onclick = (e) => {
          e.stopPropagation();
          const mm = new Menu();
          for (const a of acts) mm.addItem((i) => i.setTitle(a.l).setIcon(a.icon).onClick(() => this.runAction(a, r)));
          mm.addSeparator();
          mm.addItem((i) => i.setTitle("Open note").setIcon("file").onClick(() => this.openNote(r.file)));
          mm.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus").onClick(() => this.app.workspace.getLeaf("tab").openFile(r.file)));
          if (m.structure) mm.addItem((i) => i.setTitle("Edit structure…").setIcon("hexagon").onClick(() => this.plugin.openEditor(r.smiles || null, (res) => this.app.fileManager.processFrontMatter(r.file, (fm: any) => { fm.smiles = res.smiles; }), { title: r.title })));
          mm.showAtMouseEvent(e);
        };
      };
      const alertOf = (r: Rec) => m.alert?.(r.fm, t0);
      if (this.mode === "cards" && m.structure) {
        const g = body.createDiv({ cls: "ce-lab-grid" });
        for (const r of f) {
          const c = g.createDiv({ cls: "ce-lab-card" });
          c.onclick = () => this.openNote(r.file);
          const h = c.createDiv({ cls: "ce-lab-cardh" });
          h.createSpan({ cls: "ce-lab-strong ce-lab-ellipsis", text: r.title });
          if (m.statuses) this.badge(h, r.status, (e) => statusMenu(r, e));
          this.structSlot(c, r.smiles, 100);
          const p = r.smiles ? propsOf(r.smiles) : null;
          c.createDiv({ cls: "ce-lab-muted", text: [p?.formula, p?.mw ? p.mw.toFixed(2) + " g/mol" : "", r.fm.cas ? "CAS " + r.fm.cas : "", r.fm.location].filter(Boolean).join(" · ") });
          const a = alertOf(r);
          if (a) c.createDiv({ cls: "ce-lab-flag", text: "⚠ " + a });
          actions(c, r);
        }
      } else {
        const cols = m.fields.filter((x) => x.col);
        const t = body.createDiv({ cls: "ce-lab-tablewrap" }).createEl("table", { cls: "ce-lab-table" });
        const hr = t.createEl("thead").createEl("tr");
        if (m.structure) hr.createEl("th", { text: "Structure" });
        for (const c of cols) hr.createEl("th", { text: c.l });
        if (m.structure) hr.createEl("th", { text: "Formula / MW" });
        if (m.statuses) hr.createEl("th", { text: "Status" });
        hr.createEl("th");
        const tb = t.createEl("tbody");
        for (const r of f) {
          const tr = tb.createEl("tr");
          tr.onclick = () => this.openNote(r.file);
          if (m.structure) this.structSlot(tr.createEl("td", { cls: "ce-lab-tdstruct" }), r.smiles, 54);
          cols.forEach((c, i) => {
            const td = tr.createEl("td", { text: String(r.fm[c.k] ?? (i === 0 ? r.title : "")) });
            if (i === 0) { td.addClass("ce-lab-strong"); const a = alertOf(r); if (a) td.createDiv({ cls: "ce-lab-flag", text: "⚠ " + a }); }
            if (c.t === "date" && r.fm[c.k] && daysBetween(t0, String(r.fm[c.k])) < 0 && c.k !== "last_reviewed") td.addClass("is-overdue");
          });
          if (m.structure) { const p = r.smiles ? propsOf(r.smiles) : null; tr.createEl("td", { cls: "ce-lab-muted", text: p ? `${p.formula} · ${p.mw.toFixed(2)}` : "" }); }
          if (m.statuses) { const td = tr.createEl("td"); this.badge(td, r.status, (e) => statusMenu(r, e)); const who = r.fm.checked_out_by || r.fm.booked_by; if (who) td.createDiv({ cls: "ce-lab-muted", text: who }); }
          actions(tr.createEl("td", { cls: "ce-lab-tdacts" }), r);
        }
      }
    };
    this.toolbar({ statuses: m.statuses, counts, placeholder: `Search ${m.title.toLowerCase()}…`, modes: m.structure, onChange: list, extra: m.structure ? (el) => {
      const sb = el.createEl("button", { cls: "ce-lab-chip" + (this.subQuery ? " is-on" : ""), text: this.subQuery ? "Substructure ✕" : "Substructure…" });
      setIcon(sb.createSpan({ cls: "ce-lab-chipicon" }), "search");
      sb.onclick = () => {
        if (this.subQuery) { this.subQuery = null; this.renderPage(); return; }
        this.plugin.openEditor(null, (res) => { this.subQuery = res.doc; this.renderPage(); }, { title: "Draw substructure query", saveLabel: "Search" });
      };
    } : undefined });
    const body = this.main.createDiv({ cls: "ce-lab-body" });
    list();
  }

  private async runAction(a: MAction, r: Rec) {
    const ctx: ActCtx = { plugin: this.plugin, user: this.plugin.settings.userName || "me", today: today(), rec: r, view: this };
    if (a.fm) { await this.app.fileManager.processFrontMatter(r.file, (fm: any) => a.run(fm, ctx)); new Notice(`${r.title}: ${a.l}`); }
    else await a.run(r.fm, ctx);
  }

  newRecord(id: PageId, preset: any = {}) {
    const m = MOD.get(id)!;
    new RecordModal(this.plugin, m, preset, async (fm) => {
      const folder = normalizePath(this.folderOf(id) || m.folder);
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
      const data: any = { tags: [m.tags[0]], ...fm };
      if (m.statuses && !data.status) data.status = m.statuses[0];
      if (id === "orders" && !data.requester) data.requester = this.plugin.settings.userName || "";
      if (id === "protocols" && !data.author) data.author = this.plugin.settings.userName || "";
      if (data.smiles) { const p = propsOf(String(data.smiles)); if (p) { data.formula = p.formula; data.mw = +p.mw.toFixed(3); } }
      data.created = today();
      const safe = String(fm.name || m.newLabel).replace(/[\\/:*?"<>|#^[\]]/g, "-").trim();
      let path = normalizePath(`${folder}/${safe}.md`), k = 2;
      while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${safe} ${k++}.md`);
      const file = await this.app.vault.create(path, `---\n${stringifyYaml(data)}---\n${m.body(data)}`);
      new Notice(`Created ${file.basename}`);
      this.app.workspace.getLeaf("tab").openFile(file);
    }).open();
  }

  // ---------------------------------------------------------------- analytics (characterisation readiness)

  private pageAnalytics() {
    const m = MOD.get("analytics")!;
    const metrics = (this.plugin.settings.charMetrics || "hnmr, cnmr, hrms, ir, mp").split(",").map((s) => s.trim()).filter(Boolean);
    const label = (k: string) => ({ hnmr: "¹H NMR", cnmr: "¹³C NMR", fnmr: "¹⁹F NMR", pnmr: "³¹P NMR", hrms: "HRMS", ir: "IR", mp: "m.p.", ea: "EA", xray: "X-ray", hplc: "HPLC", rf: "Rf" } as Record<string, string>)[k.toLowerCase()] ?? k.toUpperCase();
    const recs = this.records("analytics");
    const done = (v: any) => !!v && v !== "false" && v !== false && v !== "✗";
    this.head(m.title, m.sub, { l: m.newLabel, run: () => this.newRecord("analytics", Object.fromEntries(metrics.map((k) => [k, false]))) }, (el) => {
      const b = el.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Edit tracked analyses" } });
      setIcon(b, "sliders-horizontal");
      b.onclick = () => new FolderPrompt(this.app, "Tracked analyses (YAML keys, comma-separated)", this.plugin.settings.charMetrics || "hnmr, cnmr, hrms, ir, mp", async (v) => { this.plugin.settings.charMetrics = v; await this.plugin.saveSettings(); this.renderPage(); }, "Analyses").open();
    });
    const scores = recs.map((r) => metrics.length ? Math.round((100 * metrics.filter((k) => done(r.fm[k])).length) / metrics.length) : 0);
    const kpi = this.main.createDiv({ cls: "ce-lab-kpis" });
    const tile = (v: string | number, l: string) => { const k = kpi.createDiv({ cls: "ce-lab-kpi" }); k.createDiv({ cls: "ce-lab-kpiv", text: String(v) }); k.createDiv({ cls: "ce-lab-kpil", text: l }); };
    tile(recs.length, "compounds tracked"); tile(scores.filter((s) => s === 100).length, "fully characterised"); tile(scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) + "%" : "–", "average readiness");
    const list = () => {
      body.empty();
      const f = recs.map((r, i) => ({ r, s: scores[i] })).filter(({ r }) => !this.q || r.search.includes(this.q));
      if (!f.length) { body.createDiv({ cls: "ce-lab-empty", text: recs.length ? "Nothing matches." : `No compounds in “${this.plugin.settings.labFolders?.analytics ?? m.folder}/” (or tagged #characterization) yet.` }); return; }
      const t = body.createDiv({ cls: "ce-lab-tablewrap" }).createEl("table", { cls: "ce-lab-table ce-lab-chartable" });
      const hr = t.createEl("thead").createEl("tr");
      for (const x of ["Structure", "Compound", ...metrics.map(label), "Readiness"]) hr.createEl("th", { text: x });
      const tb = t.createEl("tbody");
      for (const { r, s } of f) {
        const tr = tb.createEl("tr");
        this.structSlot(tr.createEl("td", { cls: "ce-lab-tdstruct" }), r.smiles, 54);
        const nm = tr.createEl("td", { cls: "ce-lab-strong ce-lab-link", text: r.title }); nm.onclick = () => this.openNote(r.file);
        for (const k of metrics) {
          const v = r.fm[k], isLink = typeof v === "string" && v.includes("[[");
          const td = tr.createEl("td", { cls: "ce-lab-cell" });
          const b = td.createEl("button", { cls: "ce-lab-check " + (isLink ? "is-link" : done(v) ? "is-done" : "is-miss"), attr: { "aria-label": typeof v === "string" ? v : label(k) } });
          setIcon(b, isLink ? "paperclip" : done(v) ? "check" : "minus");
          b.onclick = (e) => {
            const mm = new Menu();
            if (isLink) mm.addItem((i) => i.setTitle("Open " + v.replace(/[[\]]/g, "")).setIcon("link").onClick(() => { const tf = this.app.metadataCache.getFirstLinkpathDest(v.replace(/^\[\[|\]\]$/g, "").split("|")[0], r.file.path); if (tf) this.openNote(tf); }));
            mm.addItem((i) => i.setTitle("Mark done").setIcon("check").onClick(() => this.app.fileManager.processFrontMatter(r.file, (fm: any) => { fm[k] = true; })));
            mm.addItem((i) => i.setTitle("Link spectrum / note…").setIcon("paperclip").onClick(() => new FolderPrompt(this.app, `${label(k)} — link or value`, typeof v === "string" ? v : "[[]]", (nv) => this.app.fileManager.processFrontMatter(r.file, (fm: any) => { fm[k] = nv; }), "Value").open()));
            mm.addItem((i) => i.setTitle("Mark missing").setIcon("x").onClick(() => this.app.fileManager.processFrontMatter(r.file, (fm: any) => { fm[k] = false; })));
            mm.showAtMouseEvent(e);
          };
        }
        const pc = tr.createEl("td");
        const bar = pc.createDiv({ cls: "ce-lab-bar " + (s === 100 ? "is-good" : s >= 60 ? "is-mid" : "is-bad") });
        bar.createDiv({ cls: "ce-lab-barfill" }).setCssStyles({ width: s + "%" });
        pc.createDiv({ cls: "ce-lab-muted", text: s + "%" });
      }
    };
    this.toolbar({ placeholder: "Search compounds…", onChange: list });
    const body = this.main.createDiv({ cls: "ce-lab-body" });
    list();
  }

  // ---------------------------------------------------------------- gallery

  private async pageGallery() {
    this.head("Gallery", "Every structure in your vault — files and note blocks");
    const exts = new Set(["mol", "sdf", "sd", "rxn", "cdxml", "ket", "cml", "xyz", "mol2", "chemedit", "smi"]);
    const folder = this.folderOf("gallery");
    const body0 = this.main.createDiv({ cls: "ce-lab-muted", text: "Scanning vault…" });
    const items: Array<{ f: TFile; kind: string; data: string | null }> = [];
    let k = 0;
    for (const f of this.app.vault.getFiles()) {
      if (folder && !f.path.startsWith(folder + "/")) continue;
      const e = f.extension.toLowerCase();
      if (exts.has(e)) { items.push({ f, kind: e === "sd" ? "sdf" : e, data: null }); continue; }
      if (e !== "md") continue;
      const ck = f.path + "@" + f.stat.mtime;
      let hit = SCAN_CACHE.get(ck);
      if (hit === undefined) {
        const c = this.app.metadataCache.getFileCache(f);
        hit = null;
        if (c?.sections?.some((x: any) => x.type === "code")) {
          const txt = await this.app.vault.cachedRead(f);
          const m = /```(smiles|mol|chemedit)\s*\n([\s\S]*?)\n```/.exec(txt);
          if (m && m[2].trim()) hit = { kind: m[1], data: m[2].trim() };
        }
        SCAN_CACHE.set(ck, hit);
        if (++k % 40 === 0) await new Promise((r) => window.setTimeout(r, 0)); // keep UI responsive
      }
      if (hit) items.push({ f, kind: hit.kind, data: hit.data });
    }
    body0.remove();
    items.sort((a, b) => a.f.basename.localeCompare(b.f.basename));
    const kinds = [...new Set(items.map((i) => i.kind))];
    const PAGE = this.embed?.limit ?? 60;
    let shown = PAGE;
    const list = () => {
      body.empty();
      const f = items.filter((i) => (!this.filter || i.kind === this.filter) && (!this.q || i.f.path.toLowerCase().includes(this.q)));
      if (!f.length) { body.createDiv({ cls: "ce-lab-empty", text: "No structures found." }); return; }
      body.createDiv({ cls: "ce-lab-muted ce-lab-count", text: `${f.length} structures` });
      const g = body.createDiv({ cls: "ce-lab-grid is-dense" });
      for (const it of f.slice(0, shown)) {
        const c = g.createDiv({ cls: "ce-lab-card" });
        c.onclick = () => this.openNote(it.f);
        const s = c.createDiv({ cls: "ce-lab-struct is-loading" });
        s.dataset.h = "100";
        if (it.data) { s.dataset.struct = it.data; s.dataset.key = it.f.path + "@" + it.f.stat.mtime; if (it.kind === "mol") s.dataset.fmt = "mol"; }
        else s.dataset.file = it.f.path;
        this.observer?.observe(s);
        const ft = c.createDiv({ cls: "ce-lab-cardf" });
        ft.createSpan({ cls: "ce-lab-ellipsis", text: it.f.basename });
        ft.createSpan({ cls: "ce-lab-ext", text: it.kind });
      }
      if (f.length > shown) { const more = body.createEl("button", { cls: "ce-lab-more", text: `Show more (${f.length - shown} left)` }); more.onclick = () => { shown += PAGE * 2; list(); }; }
    };
    this.toolbar({ statuses: kinds, placeholder: "Search file names…", onChange: () => { shown = PAGE; list(); }, extra: (el) => {
      const fb = el.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Limit to folder" } });
      setIcon(fb, "folder-open");
      if (this.fixedFolder) fb.remove();
      fb.onclick = () => new FolderPrompt(this.app, "Gallery (empty = whole vault)", folder, async (v) => { this.plugin.settings.labFolders = { ...(this.plugin.settings.labFolders ?? {}), gallery: v }; await this.plugin.saveSettings(); this.renderPage(); }).open();
      const rb = el.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Rescan" } });
      setIcon(rb, "refresh-cw");
      rb.onclick = () => { SCAN_CACHE.clear(); SVG_CACHE.clear(); this.renderPage(); };
    } });
    const body = this.main.createDiv({ cls: "ce-lab-body" });
    list();
  }

  // ---------------------------------------------------------------- calculators

  private pageCalculators() {
    this.head("Calculators", "Tap a calculator to insert it into the current note (or a new note)");
    for (const g of ["Organic", "Analytical", "Bio", "Polymer", "HTE"]) {
      this.main.createDiv({ cls: "ce-lab-sectionh", text: g });
      const grid = this.main.createDiv({ cls: "ce-lab-calcgrid" });
      const items = g === "HTE" ? [{ id: "hte", title: "HTE planner", icon: "grid-3x3", desc: "Visual plate/vial screen: prep step, stock solutions, pipetting sheet, HPLC yields, Bayesian next batch." }] : CALCS.filter((c) => c.group === g);
      for (const c of items) {
        const b = grid.createDiv({ cls: "ce-lab-calccard", attr: { role: "button", tabindex: "0" } });
        setIcon(b.createDiv({ cls: "ce-lab-calcicon" }), c.icon);
        b.createDiv({ cls: "ce-lab-strong", text: c.title });
        b.createDiv({ cls: "ce-lab-muted", text: c.desc });
        b.onclick = () => this.insertCalc(c.id);
      }
    }
  }

  private async insertCalc(id: string) {
    const block = "\n" + calcBlock(id);
    const md = this.lastMd && this.app.workspace.getLeavesOfType("markdown").some((l: any) => l.view === this.lastMd) ? this.lastMd : null;
    if (md?.editor && md.file) {
      md.editor.replaceSelection(block);
      this.app.workspace.revealLeaf(md.leaf);
      new Notice(`Inserted into ${md.file.basename}`);
      return;
    }
    const dir = "Calculations";
    if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => {});
    const name = `${dir}/${(CALC_BY_ID.get(id)?.title ?? "HTE screen").replace(/[\\/:*?"<>|]/g, "-")} ${today()}.md`;
    let path = normalizePath(name), k = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(name.replace(/\.md$/, ` ${k++}.md`));
    const f = await this.app.vault.create(path, `---\ntags: [calculation]\n---\n${block}`);
    this.app.workspace.getLeaf("tab").openFile(f);
  }
}

const SVG_CACHE = new Map<string, string>();
const SCAN_CACHE = new Map<string, { kind: string; data: string } | null>();
const propCache = new Map<string, { formula: string; mw: number } | null>();
function propsOf(smi: string) {
  if (!propCache.has(smi)) { try { const p = computeProperties(parseAny(smi), "all"); propCache.set(smi, p ? { formula: p.formula.replace(/\d/g, (c) => "₀₁₂₃₄₅₆₇₈₉"[+c]), mw: p.mw } : null); } catch { propCache.set(smi, null); } }
  return propCache.get(smi)!;
}

// ---------------------------------------------------------------- modals

class FolderPrompt extends Modal {
  constructor(app: any, private label: string, private value: string, private onOk: (v: string) => void, private field = "Folder") { super(app); }
  onOpen() {
    this.titleEl.setText(this.label);
    let v = this.value;
    new Setting(this.contentEl).setName(this.field).addText((t) => { t.setValue(v).onChange((x) => (v = x)); window.setTimeout(() => t.inputEl.focus(), 30); t.inputEl.onkeydown = (e) => { if (e.key === "Enter") { this.onOk(v.trim().replace(/\/$/, "")); this.close(); } }; });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("Save").setCta().onClick(() => { this.onOk(v.trim().replace(/\/$/, "")); this.close(); }));
  }
  onClose() { this.contentEl.empty(); }
}

class RecordModal extends Modal {
  private fm: any;
  constructor(private plugin: ChemEditPlugin, private m: ModuleDef, preset: any, private onOk: (fm: any) => void) { super(plugin.app); this.fm = { ...preset }; }
  onOpen() {
    this.modalEl.addClass("ce-lab-modal");
    this.titleEl.setText(this.m.newLabel);
    this.draw();
  }
  private draw() {
    const c = this.contentEl;
    c.empty();
    if (this.m.structure) {
      const sw = c.createDiv({ cls: "ce-lab-modalstruct" });
      const pv = sw.createDiv({ cls: "ce-lab-struct" });
      if (this.fm.smiles) { try { pv.innerHTML = this.plugin.svgFor(parseAny(String(this.fm.smiles)), { maxHeight: 140, padding: 4 }); } catch { pv.setText("Invalid structure"); } }
      else { pv.addClass("is-empty"); pv.setText("No structure yet"); }
      const bs = sw.createDiv({ cls: "ce-lab-modalbtns" });
      bs.createEl("button", { text: "Draw…" }).onclick = () => this.plugin.openEditor(this.fm.smiles || null, (r) => { this.fm.smiles = r.smiles; this.draw(); }, { title: this.fm.name || "Structure" });
      bs.createEl("button", { text: "From name" }).onclick = async () => {
        const nm = this.fm.name?.trim();
        if (!nm) { new Notice("Enter a name first"); return; }
        new Notice(`Looking up ${nm}…`);
        const s = await this.plugin.resolveName(nm);
        if (s) { this.fm.smiles = s; this.draw(); } else new Notice("Not found");
      };
    }
    for (const f of this.m.fields) {
      if (f.t === "smiles") {
        new Setting(c).setName(f.l).addText((t) => t.setPlaceholder("CCO").setValue(this.fm.smiles ?? "").onChange((v) => (this.fm.smiles = v.trim())).inputEl.addEventListener("change", () => this.draw()));
        continue;
      }
      const s = new Setting(c).setName(f.l);
      if (f.t === "select") s.addDropdown((d) => { for (const o of f.opts ?? []) d.addOption(o, o); d.setValue(this.fm[f.k] ?? f.opts?.[0] ?? ""); this.fm[f.k] = d.getValue(); d.onChange((v) => (this.fm[f.k] = v)); });
      else s.addText((t) => { t.setPlaceholder(f.ph ?? (f.t === "date" ? "YYYY-MM-DD" : "")).setValue(this.fm[f.k] !== undefined ? String(this.fm[f.k]) : "").onChange((v) => { if (v.trim()) this.fm[f.k] = f.t === "num" ? +v : v.trim(); else delete this.fm[f.k]; }); if (f.t === "date") t.inputEl.type = "date"; });
    }
    if (this.m.statuses) new Setting(c).setName("Status").addDropdown((d) => { for (const o of this.m.statuses!) d.addOption(o, o); d.setValue(this.fm.status ?? this.m.statuses![0]); d.onChange((v) => (this.fm.status = v)); });
    new Setting(c).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close())).addButton((b) => b.setButtonText("Create").setCta().onClick(() => {
      if (!String(this.fm.name ?? "").trim()) { new Notice("Name is required"); return; }
      this.onOk(this.fm); this.close();
    }));
  }
  onClose() { this.contentEl.empty(); }
}

export { docToSmiles, fmtMass };

/** Pick a compound from the Compounds library or Inventory (used by the ELN “+ Reagent” menu). */
export class CompoundPicker extends FuzzySuggestModal<{ name: string; smiles: string; src: string; extra: string }> {
  constructor(private plugin: ChemEditPlugin, private onPick: (c: { name: string; smiles: string; cas?: string; lot?: string }) => void) {
    super(plugin.app);
    this.setPlaceholder("Search compounds library & inventory…");
  }
  getItems() {
    const out: Array<{ name: string; smiles: string; src: string; extra: string; cas?: string; lot?: string }> = [];
    for (const id of ["compounds", "inventory"] as const) {
      const m = MOD.get(id)!;
      const folder = (this.plugin.settings.labFolders?.[id] ?? m.folder).replace(/\/$/, "");
      for (const f of this.app.vault.getMarkdownFiles()) {
        const fm: any = this.app.metadataCache.getFileCache(f)?.frontmatter;
        if (!fm || !(f.path.startsWith(folder + "/") || hasTag(fm, m.tags))) continue;
        out.push({ name: String(fm.name ?? f.basename), smiles: String(fm.smiles ?? ""), src: id === "compounds" ? "Library" : "Inventory", extra: [fm.cas && "CAS " + fm.cas, fm.location, fm.amount].filter(Boolean).join(" · "), cas: fm.cas, lot: fm.lot, mw: fm.mw } as any);
      }
    }
    return out;
  }
  getItemText(i: { name: string; src: string; extra: string }) { return `${i.name} — ${i.src}${i.extra ? " · " + i.extra : ""}`; }
  onChooseItem(i: any) { this.onPick({ name: i.name, smiles: i.smiles, cas: i.cas, lot: i.lot, mw: i.mw } as any); }
}

// ---------------------------------------------------------------- CSV import (KLARA / ChemInventory / generic)

export function parseCsv(text: string): string[][] {
  const t = text.replace(/^\uFEFF/, "");
  const first = t.split(/\r?\n/)[0] ?? "";
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : first.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; row.push(cell); if (row.some((c) => c.trim())) rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell); if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

async function importCsv(plugin: ChemEditPlugin, m: ModuleDef, folder: string, text: string) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { created: 0, skipped: 0 };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
  const C = { name: col("product", "name", "compound", "chemical"), cas: col("cas"), mw: col("mol weight", "mw", "molecular weight"), qty: col("quantity", "amount"), unit: col("unit"), building: col("building"), room: col("room"), storage: col("storage", "location"), smiles: col("smiles"), barcode: col("barcode", "id"), purity: col("concentration", "purity"), quality: col("quality", "grade"), expiry: col("use before", "expiry", "expiration"), lot: col("batch", "lot"), article: col("article", "catalog"), owner: col("buyer", "owner"), comments: col("comments", "notes"), supplier: col("supplier", "vendor", "brand") };
  if (C.name < 0) { new Notice("CSV: no name/product column found"); return { created: 0, skipped: 0 }; }
  const app = plugin.app;
  const dir = normalizePath(folder);
  if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
  const existing = new Set<string>();
  for (const f of app.vault.getMarkdownFiles()) { const fm: any = app.metadataCache.getFileCache(f)?.frontmatter; if (fm?.barcode) existing.add(String(fm.barcode)); }
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  let created = 0, skipped = 0;
  for (const r of rows.slice(1)) {
    const name = get(r, C.name).replace(/<br\s*\/?>/gi, "").replace(/\s+/g, " ").replace(/\s*\((mass|volume|massa)\)\s*$/i, "").trim();
    if (!name) continue;
    const barcode = get(r, C.barcode);
    if (barcode && existing.has(barcode)) { skipped++; continue; }
    const fm: any = { tags: [m.tags[0]], name };
    const cas = get(r, C.cas); if (cas) fm.cas = cas;
    let smi = get(r, C.smiles).replace(/\s*\|.*\|\s*$/, ""); // drop ChemAxon extensions
    if (smi) { try { parseAny(smi, "smiles"); fm.smiles = smi; } catch { fm.smiles_raw = smi; } }
    const mw = parseFloat(get(r, C.mw).replace(",", ".")); if (isFinite(mw) && mw > 0) fm.mw = +mw.toFixed(3);
    else if (fm.smiles) { const p = propsOf(fm.smiles); if (p) fm.mw = +p.mw.toFixed(3); }
    if (fm.smiles) { const p = propsOf(fm.smiles); if (p) fm.formula = p.formula.replace(/[₀-₉]/g, (c) => String("₀₁₂₃₄₅₆₇₈₉".indexOf(c))); }
    const q = get(r, C.qty).replace(",", "."), u = get(r, C.unit); if (q) fm.amount = `${q} ${u}`.trim();
    const loc = [get(r, C.room), get(r, C.storage)].filter(Boolean).join(" / "); if (loc) fm.location = loc;
    if (C.building >= 0 && get(r, C.building)) fm.building = get(r, C.building);
    const pur = get(r, C.purity) || get(r, C.quality); if (pur) fm.purity = pur;
    const exp = get(r, C.expiry); if (exp && exp !== "0") fm.expiry = exp;
    for (const [k, i] of [["lot", C.lot], ["catalog", C.article], ["owner", C.owner], ["supplier", C.supplier], ["comments", C.comments]] as const) { const v = get(r, i); if (v) fm[k] = v; }
    if (/glyme|dimethyl ether|methoxyethyl ether|hydrate|complex|·/i.test(name) && fm.mw) fm.mw_check = "verify MW — database values often omit the bound solvent/water";
    if (barcode) { fm.barcode = barcode; existing.add(barcode); }
    if (m.statuses) fm.status = m.statuses[0];
    fm.imported = today();
    const safe = `${name}${barcode ? ` (${barcode})` : ""}`.replace(/[\\/:*?"<>|#^[\]]/g, "-").slice(0, 120);
    let path = normalizePath(`${dir}/${safe}.md`), k = 2;
    while (app.vault.getAbstractFileByPath(path)) path = normalizePath(`${dir}/${safe} ${k++}.md`);
    await app.vault.create(path, `---\n${stringifyYaml(fm)}---\n${m.body(fm)}`);
    created++;
  }
  return { created, skipped };
}
