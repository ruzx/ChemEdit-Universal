// Full-tab views: editor for .mol/.chemedit/.smi/.rxn/.cdxml/.ket, and a record gallery for .sdf files.
import { TextFileView, WorkspaceLeaf, debounce, Notice } from "obsidian";
import type ChemEditPlugin from "./main";
import { ChemEditor } from "../editor/editor";
import { parseAny, docToMolfile, docToNative, docToSmiles, formatForExtension, serialize, parseSdf, writeSdf, SdfRecord } from "../chem/index";
import { setSvg } from "../render/dom";
import { errMsg } from "../chem/util";

export const CHEM_VIEW_TYPE = "chemedit-file-view";

export class ChemFileView extends TextFileView {
  private editor: ChemEditor | null = null;
  private loading = false;
  private records: SdfRecord[] | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: ChemEditPlugin) { super(leaf); }

  getViewType() { return CHEM_VIEW_TYPE; }
  getDisplayText() { return this.file?.basename ?? "Structure"; }
  getIcon() { return "hexagon"; }
  private get ext() { return (this.file?.extension ?? "mol").toLowerCase(); }

  getViewData(): string {
    if (this.records) return writeSdf(this.records);
    if (!this.editor) return this.data;
    const doc = this.editor.getDoc();
    const f = formatForExtension(this.ext);
    if (f === "chemedit") return docToNative(doc);
    if (f === "smiles") return docToSmiles(doc) + "\n";
    if (f === "mol" || f === "auto") return docToMolfile(doc, this.file?.basename ?? "");
    if (f === "pdb") return this.data; // PDB is read-only (use "Save as" for other formats)
    return serialize(doc, f);
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (this.ext === "sdf" || this.ext === "sd") { this.renderSdf(data); return; }
    this.loading = true;
    if (!this.editor || clear) {
      this.editor?.destroy();
      this.contentEl.empty();
      this.contentEl.addClass("chemedit-fileview");
      const save = debounce(() => { if (!this.loading) this.requestSave(); }, 400, true);
      this.editor = new ChemEditor(this.contentEl, {
        colorAtoms: this.plugin.settings.colorAtoms,
        injectCss: false,
        resolveName: this.plugin.settings.nameLookup ? (n) => this.plugin.resolveName(n) : undefined,
        saveFile: (n, d) => { void this.plugin.saveExport(n, d); },
        onChange: () => save(),
      });
    }
    try {
      if (data.trim()) this.editor.setDoc(parseAny(data, formatForExtension(this.ext)), false);
    } catch (e) {
      this.editor.toast("Could not read file: " + errMsg(e));
    }
    this.loading = false;
  }

  private renderSdf(data: string) {
    this.contentEl.empty();
    this.contentEl.addClass("chemedit-sdfview");
    try { this.records = parseSdf(data); } catch (e) { this.contentEl.createDiv({ cls: "chemedit-error", text: "SDF: " + errMsg(e) }); return; }
    const recs = this.records;
    const head = this.contentEl.createDiv({ cls: "ce-sdf-head" });
    head.createSpan({ text: `${recs.length} record${recs.length === 1 ? "" : "s"}` });
    const search = head.createEl("input", { type: "search", placeholder: "Filter by name or field…" });
    const add = head.createEl("button", { text: "+ Add record" });
    const grid = this.contentEl.createDiv({ cls: "ce-sdf-grid" });
    const cards: Array<{ el: HTMLElement; text: string }> = [];
    recs.forEach((r, i) => {
      const card = grid.createDiv({ cls: "ce-sdf-card" });
      const fig = card.createDiv({ cls: "ce-sdf-fig" });
      try { setSvg(fig, this.plugin.svgFor(r.doc, { maxHeight: 150 })); } catch { fig.setText("?"); }
      card.createDiv({ cls: "ce-sdf-name", text: r.name });
      const fields = card.createDiv({ cls: "ce-sdf-fields" });
      for (const [k, v] of Object.entries(r.fields).slice(0, 6)) fields.createDiv({ text: `${k}: ${v}` });
      card.title = "Double-click to edit · right-click: copy SMILES";
      card.addEventListener("dblclick", () => this.plugin.openEditor(r.doc, (res) => { recs[i] = { ...r, doc: res.doc }; this.requestSave(); this.renderSdf(this.getViewData()); }, { title: `Edit ${r.name}` }));
      card.addEventListener("contextmenu", (e) => { e.preventDefault(); void navigator.clipboard.writeText(docToSmiles(r.doc)).then(() => new Notice("SMILES copied")); });
      cards.push({ el: card, text: (r.name + " " + Object.entries(r.fields).map(([k, v]) => k + " " + v).join(" ")).toLowerCase() });
    });
    search.addEventListener("input", () => { const q = search.value.toLowerCase(); for (const c of cards) c.el.toggleClass("ce-hidden", !c.text.includes(q)); });
    add.onclick = () => this.plugin.openEditor(null, (res) => { recs.push({ doc: res.doc, name: `Record ${recs.length + 1}`, fields: {} }); this.requestSave(); this.renderSdf(this.getViewData()); }, { title: "New SDF record", saveLabel: "Add" });
  }

  clear(): void { this.records = null; this.editor?.setDoc("", false); }

  async onClose() {
    this.editor?.destroy();
    this.editor = null;
  }
}
