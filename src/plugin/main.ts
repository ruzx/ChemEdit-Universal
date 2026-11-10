// ChemEdit (new) — lightweight chemical structure editor for Obsidian.
import { Editor, MarkdownView, Menu, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { ChemEditSettings, ChemEditSettingTab, DEFAULT_SETTINGS, BlockFormat } from "./settings";
import { ChemEditorModal, EditorModalOptions, EditorResult } from "./modal";
import { StructureView, ChemFileEmbed, BLOCK_LANGS, contentFor, BlockLang } from "./render";
import { ChemFileView, CHEM_VIEW_TYPE } from "./fileview";
import { buildChemEditAPI, ChemEditAPI, HeadlessShim, SaveCallback } from "./api";
import { metadataXml, embedDataInSvg, extractDataFromSvg } from "./svgmeta";
import { resolveName } from "./names";
import { initCanvasBridge } from "./bridges/canvas";
import { initExcalidrawBridge } from "./bridges/excalidraw";
import { ChemDoc } from "../chem/model";
import { parseAny, docToSmiles, docToNative, looksLikeSmiles, computeProperties } from "../chem/index";
import { renderSVG, RenderOptions } from "../render/svg";
import { contractAbbreviations } from "../chem/abbrev";
import { LabView, LAB_VIEW, PageId } from "./lab";
import { CalcRenderer, LEGACY_DEFAULT, insertCalc, calcBlock } from "./calcview";
import { SynthesisMapBlock } from "./synthmap";
import { SynthesisPlanBlock } from "./synthplan";
import { LabEmbedBlock } from "./embeds";
import { NmrBlock, nmrBlock } from "./nmrview";
import { BlockPicker } from "./inserts";
import { CALCS } from "../chem/calcs";
import { TlcModal } from "./tlc";
import { PhotoModal, StepModal, elnCtxForFile } from "./labbook";
import { ElnRenderer, PromptModal, experimentTemplate, createExperimentFile, nextExperimentCode, elnFromDoc } from "./eln";
import { ElnData } from "../chem/eln";
import { setSvg, setRich, setSvgChildren, serializeEl } from "../render/dom";

export { embedDataInSvg, extractDataFromSvg, ChemFileView };

const FILE_EXTS = ["mol", "chemedit", "smi", "sdf", "rxn", "cdxml", "ket", "cml", "xyz", "mol2", "pdb"];

export default class ChemEditPlugin extends Plugin {
  settings: ChemEditSettings = { ...DEFAULT_SETTINGS };
  api!: ChemEditAPI;
  view!: StructureView;
  private headless: HeadlessShim | null = null;
  private registeredEmbeds: string[] = [];

  async onload() {
    await this.loadSettings();
    this.view = new StructureView(this);
    this.api = buildChemEditAPI(this);
    (window as any).ChemEditAPI = this.api;
    this.register(() => { if ((window as any).ChemEditAPI === this.api) delete (window as any).ChemEditAPI; });

    this.addSettingTab(new ChemEditSettingTab(this.app, this));

    // code blocks
    for (const [tag, lang] of Object.entries(BLOCK_LANGS)) {
      try { this.registerMarkdownCodeBlockProcessor(tag, (src, el, ctx) => this.view.codeBlock(lang, src, el, ctx)); }
      catch { console.warn(`ChemEdit: \`\`\`${tag} blocks are already handled by another plugin (disable the old ChemEdit).`); }
    }
    this.registerMarkdownPostProcessor((el, ctx) => this.view.inline(el, ctx));
    const eln = new ElnRenderer(this);
    for (const [tag, fn] of [["eln", (s: string, el: HTMLElement, ctx: any) => eln.render(s, el, ctx)], ["eln-list", (s: string, el: HTMLElement, ctx: any) => eln.renderList(s, el, ctx)]] as const) {
      try { this.registerMarkdownCodeBlockProcessor(tag, fn); } catch { console.warn(`ChemEdit: \`\`\`${tag} already handled by another plugin.`); }
    }

    // ribbon & commands
    this.addRibbonIcon("hexagon", "Draw chemical structure", () => this.drawNew());
    this.addCommand({ id: "insert-structure", name: "Insert chemical structure", callback: () => this.drawNew() });
    this.addCommand({ id: "insert-structure-svg", name: "Insert chemical structure as SVG file", callback: () => this.drawNew("svg") });
    this.addCommand({ id: "insert-structure-drawing", name: "Insert chemical drawing (exact layout, arrows & text)", callback: () => this.drawNew("chemedit") });
    this.addCommand({ id: "edit-structure-at-cursor", name: "Edit structure at cursor", editorCallback: (ed) => this.editAtCursor(ed) });
    this.addCommand({ id: "selection-to-structure", name: "Convert selected SMILES / name to structure", editorCallback: (ed) => this.selectionToStructure(ed) });
    this.addCommand({ id: "open-editor", name: "Open structure editor (copy result)", callback: () => this.openEditor(null, async (r) => { await navigator.clipboard.writeText(r.smiles); new Notice("SMILES copied to clipboard"); }) });
    this.addCommand({ id: "new-experiment", name: "New experiment (ELN)", callback: () => this.newExperiment() });
    this.addCommand({ id: "new-experiment-from-drawing", name: "New experiment from a drawn reaction", callback: () => this.openEditor(null, (r) => this.newExperiment(undefined, elnFromDoc(r.doc)), { title: "Draw the reaction", saveLabel: "Create experiment" }) });
    this.addCommand({ id: "insert-experiment-index", name: "Insert experiments index (ELN)", editorCallback: (ed) => ed.replaceSelection("```eln-list\nfolder: " + this.settings.elnFolder + "\n```\n") });
    this.registerView(LAB_VIEW, (leaf) => new LabView(leaf, this));
    this.addRibbonIcon("flask-conical", "ChemEdit Lab", () => this.openLab("overview"));
    this.addCommand({ id: "open-lab", name: "Open ChemEdit Lab (overview)", callback: () => this.openLab("overview") });
    this.addCommand({ id: "open-eln-dashboard", name: "Open experiments (ELN dashboard)", callback: () => this.openLab("experiments") });
    for (const [id, nm] of [["compounds", "compounds library"], ["inventory", "inventory"], ["orders", "orders"], ["equipment", "equipment"], ["protocols", "protocols"], ["analytics", "analytics / characterisation"], ["gallery", "structure gallery"], ["calculators", "calculators"]] as const)
      this.addCommand({ id: `open-lab-${id}`, name: `Open ${nm}`, callback: () => this.openLab(id) });
    this.addCommand({ id: "insert-calculator", name: "Insert lab calculator…", editorCallback: (ed) => insertCalc(this.app, ed) });
    for (const c of [...CALCS.map((x) => ({ id: x.id, title: x.title })), { id: "hte", title: "HTE planner" }])
      this.addCommand({ id: `calc-${c.id}`, name: `Insert calculator: ${c.title}`, editorCallback: (ed) => ed.replaceSelection(calcBlock(c.id)) });
    this.addCommand({ id: "open-lab-synthesis", name: "Open synthesis map", callback: () => this.openLab("synthesis") });
    this.addCommand({ id: "insert-synthesis-map", name: "Insert synthesis map", editorCallback: (ed) => ed.replaceSelection("```synthesis-map\nview: sequences\nheight: 520\n```\n") });
    this.registerMarkdownCodeBlockProcessor("synthesis-map", (src, el, ctx) => ctx.addChild(new SynthesisMapBlock(this, el, src, ctx.sourcePath)));
    const reg = (tag: string, fn: (src: string, el: HTMLElement, ctx: any) => void) => { try { this.registerMarkdownCodeBlockProcessor(tag, fn); } catch { console.warn(`ChemEdit: \`\`\`${tag} already handled by another plugin.`); } };
    reg("synthesis-plan", (src, el, ctx) => ctx.addChild(new SynthesisPlanBlock(this, el, src, ctx)));
    for (const k of ["chem-gallery", "eln-gallery", "chem-db"] as const) reg(k, (src, el, ctx) => ctx.addChild(new LabEmbedBlock(this, el, src, ctx, k)));
    reg("chem-nmr", (src, el, ctx) => ctx.addChild(new NmrBlock(this, el, src, ctx)));
    this.addCommand({ id: "insert-block", name: "Insert ChemEdit block (gallery, inventory, plan, NMR…)", editorCallback: (ed) => new BlockPicker(this.app, this, ed).open() });
    this.addCommand({ id: "insert-nmr-prediction", name: "Insert NMR prediction (selected SMILES or draw)", editorCallback: (ed) => {
      const sel = ed.getSelection().trim();
      if (sel && !/\s/.test(sel)) { try { parseAny(sel, "smiles"); ed.replaceSelection(nmrBlock(sel)); return; } catch { /* draw instead */ } }
      this.openEditor(null, (r) => ed.replaceSelection(nmrBlock(r.smiles)), { title: "Structure for NMR prediction", saveLabel: "Predict" });
    } });
    this.addCommand({ id: "insert-synthesis-plan", name: "Insert synthesis plan (mind map)", editorCallback: (ed) => ed.replaceSelection("```synthesis-plan\npath: " + this.settings.elnFolder + "\n[[EXP-001]] -> [[EXP-002]]\n```\n") });
    const calc = new CalcRenderer(this);
    for (const tag of ["chem-calc", ...Object.keys(LEGACY_DEFAULT)]) {
      try { this.registerMarkdownCodeBlockProcessor(tag, (s, el, ctx) => calc.render(tag, s, el, ctx)); } catch { console.warn(`ChemEdit: \`\`\`${tag} already handled by another plugin.`); }
    }
    const withNote = (fn: (c: Awaited<ReturnType<typeof elnCtxForFile>>) => void) => (checking: boolean) => {
      const f = this.app.workspace.getActiveFile();
      if (!f || f.extension !== "md") return false;
      if (!checking) elnCtxForFile(this, f).then(fn);
      return true;
    };
    this.addCommand({ id: "eln-tlc", name: "Lab book: TLC from photo", checkCallback: withNote((c) => new TlcModal(c).open()) });
    this.addCommand({ id: "eln-photo", name: "Lab book: add photo", checkCallback: withNote((c) => new PhotoModal(c).open()) });
    this.addCommand({ id: "eln-step", name: "Lab book: add experimental step", checkCallback: withNote((c) => new StepModal(c, "experimental").open()) });
    this.addCommand({ id: "new-chem-file", name: "Create new .chemedit drawing file", callback: () => this.createFile() });

    // file view & embeds for .mol / .chemedit / .smi
    if (this.settings.enableFileView) {
      this.registerView(CHEM_VIEW_TYPE, (leaf) => new ChemFileView(leaf, this));
      for (const ext of FILE_EXTS) {
        try { this.registerExtensions([ext], CHEM_VIEW_TYPE); } catch { console.warn(`ChemEdit: .${ext} already handled by another plugin`); }
      }
      this.registerEmbeds();
    }

    // double-click on an embedded ChemEdit SVG image → edit
    this.registerDomEvent(document, "dblclick", (e) => this.onDocDblClick(e as MouseEvent), true);
    // editor context menu
    this.registerEvent((this.app.workspace as any).on("editor-menu", (menu: Menu, editor: Editor) => {
      menu.addItem((i) => i.setTitle("Insert chemical structure").setIcon("hexagon").onClick(() => this.drawNew()));
      menu.addItem((i) => i.setTitle("Insert lab calculator…").setIcon("calculator").onClick(() => insertCalc(this.app, editor)));
      const f = this.app.workspace.getActiveFile();
      if (f && f.extension === "md") {
        menu.addItem((i) => i.setTitle("Lab book: add step…").setIcon("list-plus").onClick(() => elnCtxForFile(this, f).then((c) => new StepModal(c, "experimental").open())));
        menu.addItem((i) => i.setTitle("Lab book: TLC from photo…").setIcon("scan-line").onClick(() => elnCtxForFile(this, f).then((c) => new TlcModal(c).open())));
        menu.addItem((i) => i.setTitle("Lab book: add photo…").setIcon("camera").onClick(() => elnCtxForFile(this, f).then((c) => new PhotoModal(c).open())));
      }
      menu.addItem((i) => i.setTitle("Insert ChemEdit block…").setIcon("layout-grid").onClick(() => new BlockPicker(this.app, this, editor).open()));
      if (editor.getSelection().trim()) menu.addItem((i) => i.setTitle("Convert selection to structure").setIcon("hexagon").onClick(() => this.selectionToStructure(editor)));
    }));

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.enableCanvasBridge) initCanvasBridge(this);
      if (this.settings.enableExcalidrawBridge) initExcalidrawBridge(this);
    });
  }

  onunload() {
    const reg = (this.app as any).embedRegistry;
    for (const ext of this.registeredEmbeds) try { reg?.unregisterExtension?.(ext); } catch { /* */ }
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); this.settings.labFolders = { ...(this.settings.labFolders ?? {}) }; }
  async saveSettings() { await this.saveData(this.settings); }
  refreshAll() { /* re-render happens on note re-open; force current view refresh */ (this.app.workspace as any).getActiveViewOfType?.(MarkdownView)?.previewMode?.rerender?.(true); }

  private registerEmbeds() {
    const reg = (this.app as any).embedRegistry;
    if (!reg?.registerExtension) return;
    for (const ext of FILE_EXTS) {
      try {
        reg.registerExtension(ext, (ctx: any, file: TFile) => new ChemFileEmbed(this, ctx.containerEl, file));
        this.registeredEmbeds.push(ext);
      } catch { /* another plugin owns it */ }
    }
  }

  // ------------------------------------------------------------------ rendering helpers
  svgFor(doc: ChemDoc, o: { forFile?: boolean; withMeta?: boolean; maxHeight?: number; padding?: number } = {}): string {
    const s = this.settings;
    const shown = s.abbreviateInNotes ? safeContract(doc) : doc;
    const opts: RenderOptions = {
      bondLength: s.bondLength,
      colorAtoms: s.colorAtoms,
      color: o.forFile && s.svgInk === "black" ? "#000000" : "currentColor",
      maxWidth: o.forFile ? undefined : s.maxWidth,
      maxHeight: o.maxHeight ?? (o.forFile ? undefined : s.maxHeight),
      padding: o.padding ?? (o.forFile ? 6 : 6),
    };
    if (o.withMeta || o.forFile) opts.metadata = metadataXml(docToNative(doc), "chemedit", safeSmiles(doc));
    return renderSVG(shown, opts);
  }

  async resolveName(n: string) { return resolveName(n); }

  /** Editor "Save as…" → file in the SVG folder of the vault. */
  async saveExport(name: string, data: string | Blob) {
    const folder = normalizePath(this.settings.svgFolder || "/");
    if (folder !== "/" && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
    const stamp = window.moment ? window.moment().format("YYYYMMDD_HHmmss") : String(Date.now());
    const ext = name.split(".").pop();
    let path = normalizePath(`${folder === "/" ? "" : folder + "/"}${name.replace(/\.[^.]+$/, "")}_${stamp}.${ext}`);
    if (typeof data === "string") await this.app.vault.create(path, data);
    else await this.app.vault.createBinary(path, await data.arrayBuffer());
    new Notice(`Saved ${path}`);
  }

  async openDashboard() { return this.openLab("experiments"); }

  async openLab(page: PageId = "overview", focus?: string) {
    const ex = this.app.workspace.getLeavesOfType(LAB_VIEW)[0];
    const leaf = ex ?? this.app.workspace.getLeaf("tab");
    if (ex) await (ex as any).loadIfDeferred?.();
    const v = leaf.view as unknown;
    if (ex && v instanceof LabView) v.go(page, focus);
    else await leaf.setViewState({ type: LAB_VIEW, active: true, state: { page, focus } });
    this.app.workspace.revealLeaf(leaf);
  }

  newExperiment(folder?: string, data: ElnData = { reactants: [], products: [] }) {
    const dir = folder ?? this.settings.elnFolder;
    const suggestion = nextExperimentCode(this.app, dir, this.settings.elnPrefix || "EXP");
    new PromptModal(this.app, "New experiment", "Experiment code", suggestion, async (code) => {
      const date = window.moment ? window.moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0, 10);
      const sections = this.settings.elnSections.split(",").map((x) => x.trim()).filter(Boolean);
      const f = await createExperimentFile(this.app, dir, code, experimentTemplate(code, date, data, sections, this.settings.elnTemplate));
      await this.app.workspace.getLeaf(false).openFile(f);
      new Notice(`Created ${f.basename}`);
    }).open();
  }

  // ------------------------------------------------------------------ editor entry points
  openEditor(initial: string | ChemDoc | null, onSave: (r: EditorResult) => void | Promise<void>, o: EditorModalOptions = {}) {
    new ChemEditorModal(this.app, initial, onSave, {
      colorAtoms: this.settings.colorAtoms,
      pngScale: this.settings.pngScale ?? 4,
      resolveName: this.settings.nameLookup ? (n) => this.resolveName(n) : undefined,
      saveFile: (name, data) => this.saveExport(name, data),
      ...o,
    }).open();
  }

  private activeEditor(): Editor | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null;
  }

  drawNew(format?: BlockFormat) {
    const ed = this.activeEditor();
    this.openEditor(null, async (r) => {
      if (!ed) { await navigator.clipboard.writeText(r.smiles); new Notice("No note open — SMILES copied to clipboard."); return; }
      await this.insertResult(ed, r, format ?? this.settings.newBlockFormat);
    }, { title: "New structure", saveLabel: "Insert" });
  }

  async insertResult(ed: Editor, r: EditorResult, format: BlockFormat) {
    if (format === "svg") {
      const f = await this.saveSvgFile(r.doc);
      if (f) ed.replaceSelection(`![[${f.path}]]\n`);
      return;
    }
    const out = contentFor(format as BlockLang, r);
    const cur = ed.getCursor();
    const needsNl = ed.getLine(cur.line).trim().length > 0 && cur.ch > 0;
    ed.replaceSelection(`${needsNl ? "\n" : ""}\`\`\`${out.lang}\n${out.content}\n\`\`\`\n`);
    if (out.note) new Notice(out.note);
  }

  async saveSvgFile(doc: ChemDoc, existing?: TFile): Promise<TFile | null> {
    const svg = this.svgFor(doc, { forFile: true });
    if (existing) { await this.app.vault.modify(existing, svg); return existing; }
    let folder = normalizePath(this.settings.svgFolder || "/");
    if (folder !== "/" && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
    const stamp = window.moment ? window.moment().format("YYYYMMDD_HHmmss") : String(Date.now());
    let path = normalizePath(`${folder === "/" ? "" : folder + "/"}Structure_${stamp}.svg`);
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) path = path.replace(/(_\d+)?\.svg$/, `_${n++}.svg`);
    return this.app.vault.create(path, svg);
  }

  private editAtCursor(ed: Editor) {
    const cur = ed.getCursor().line;
    let start = -1, end = -1, lang: BlockLang | null = null;
    for (let i = cur; i >= 0; i--) {
      const m = /^\s*(?:>\s*)*(`{3,}|~{3,})\s*([\w-]*)/.exec(ed.getLine(i));
      if (m) { if (BLOCK_LANGS[m[2]]) { start = i; lang = BLOCK_LANGS[m[2]]; } break; }
    }
    if (start >= 0) {
      for (let i = Math.max(cur, start + 1); i < ed.lineCount(); i++) if (/^\s*(?:>\s*)*(`{3,}|~{3,})\s*$/.test(ed.getLine(i))) { end = i; break; }
    }
    if (start < 0 || end < 0 || !lang) {
      // inline $smiles= on the current line?
      const line = ed.getLine(cur);
      const prefix = this.settings.inlineSmilesPrefix;
      const idx = line.indexOf(prefix);
      if (idx >= 0) {
        const smi = line.slice(idx + prefix.length).split(/[\s`]/)[0];
        this.openEditor(smi, (r) => { ed.replaceRange(r.smiles, { line: cur, ch: idx + prefix.length }, { line: cur, ch: idx + prefix.length + smi.length }); });
        return;
      }
      new Notice("Place the cursor inside a ```smiles, ```mol or ```chemedit block.");
      return;
    }
    const src = ed.getRange({ line: start + 1, ch: 0 }, { line: end, ch: 0 });
    const l = lang;
    this.openEditor(src.trim() ? src : null, (r) => {
      const out = contentFor(l, r);
      ed.replaceRange(`\`\`\`${out.lang}\n${out.content}\n\`\`\``, { line: start, ch: 0 }, { line: end, ch: ed.getLine(end).length });
    }, { title: "Edit structure" });
  }

  private async selectionToStructure(ed: Editor) {
    const sel = ed.getSelection().trim();
    if (!sel) { new Notice("Select a SMILES string or a chemical name first."); return; }
    let smi: string | null = looksLikeSmiles(sel) ? sel : null;
    if (!smi && this.settings.nameLookup) { new Notice("Looking up name…"); smi = await this.resolveName(sel); }
    if (!smi) { new Notice(`Could not resolve “${sel}”.`); return; }
    const doc = parseAny(smi);
    const r: EditorResult = { doc, smiles: docToSmiles(doc), molfile: "", native: docToNative(doc), hasText: false };
    ed.replaceSelection(`\`\`\`smiles\n${r.smiles}\n\`\`\`\n`);
  }

  private async createFile() {
    const folder = this.app.workspace.getActiveFile()?.parent?.path ?? "";
    let path = normalizePath(`${folder ? folder + "/" : ""}Structure.chemedit`);
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder ? folder + "/" : ""}Structure ${n++}.chemedit`);
    const f = await this.app.vault.create(path, "");
    await this.app.workspace.getLeaf(true).openFile(f);
  }

  private async onDocDblClick(e: MouseEvent) {
    const img = e.target as HTMLElement;
    if (!img || img.tagName !== "IMG") return;
    const embed = img.closest(".internal-embed, .image-embed") as HTMLElement | null;
    const src = embed?.getAttribute("src") ?? img.getAttribute("alt") ?? "";
    if (!/\.svg(\||#|$)/i.test(src) && !/\.svg(\?|$)/i.test(img.getAttribute("src") ?? "")) return;
    const link = src.split("|")[0].split("#")[0];
    const from = this.app.workspace.getActiveFile()?.path ?? "";
    const file = link ? this.app.metadataCache.getFirstLinkpathDest(link, from) : null;
    if (!file) return;
    const text = await this.app.vault.read(file);
    const meta = extractDataFromSvg(text);
    if (!meta) return;
    e.preventDefault(); e.stopPropagation();
    this.openEditor(meta.data, async (r) => { await this.saveSvgFile(r.doc, file); new Notice("Structure updated"); }, { title: `Edit ${file.name}` });
  }

  // ------------------------------------------------------------------ backward-compatible surface (old ChemEdit modules)
  openKetcherModal(initialData: string, format: string, onSave: SaveCallback) {
    this.openEditor(initialData || null, (r) => {
      const f = (format || "smiles").toLowerCase();
      let data: string;
      if (f === "svg") data = this.svgFor(r.doc, { forFile: true });
      else if (f === "mol" || f === "molfile" || f === "rxn" || f === "cdxml") data = r.molfile;
      else if (f === "ket" || f === "chemedit") data = r.native;
      else data = r.smiles;
      onSave(data, false, f);
    });
  }

  async renderMoleculeToPreview(data: string, format: string, _isInline = false, width?: number, height?: number): Promise<HTMLElement | null> {
    try {
      const doc = parseAny(data, format === "mol" ? "mol" : format === "chemedit" ? "chemedit" : "auto");
      const el = createDiv({ cls: "chemedit-preview" });
      setSvg(el, renderSVG(doc, {
        bondLength: this.settings.bondLength, colorAtoms: this.settings.colorAtoms, color: "currentColor",
        maxWidth: width ?? this.settings.maxWidth, maxHeight: height ?? this.settings.maxHeight, padding: 4,
      }));
      return el;
    } catch { return null; }
  }

  get headlessKetcher() { return (this.headless ??= new HeadlessShim(this)); }
  bootHeadlessKetcher() { this.headless ??= new HeadlessShim(this); }
  openKetcherForFile(file: TFile, data: string, format: string, preview?: HTMLElement) {
    this.openEditor(data, async (r) => {
      const out = file.extension === "chemedit" ? r.native : file.extension === "smi" || file.extension === "smiles" ? r.smiles : r.molfile;
      await this.app.vault.modify(file, out);
      if (preview) { const el = await this.renderMoleculeToPreview(out, format); preview.empty(); if (el) preview.appendChild(el); }
    });
  }
  properties(data: string) { try { return computeProperties(parseAny(data), "products"); } catch { return null; } }
}

function safeContract(doc: ChemDoc) { try { return contractAbbreviations(doc); } catch { return doc; } }
function safeSmiles(doc: ChemDoc) { try { return docToSmiles(doc); } catch { return ""; } }
