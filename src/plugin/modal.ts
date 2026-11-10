// Obsidian modal hosting the ChemEditor.
import { App, Modal, Notice } from "obsidian";
import { ChemEditor } from "../editor/editor";
import type { ChemDoc } from "../chem/model";
import { isEmpty } from "../chem/model";

export interface EditorResult {
  doc: ChemDoc;
  smiles: string;
  molfile: string;
  native: string;
  hasText: boolean;
}

export interface EditorModalOptions {
  pngScale?: number;
  title?: string;
  saveLabel?: string;
  colorAtoms?: boolean;
  resolveName?: (n: string) => Promise<string | null>;
  saveFile?: (name: string, data: string | Blob) => void;
  extraButtons?: Array<{ label: string; onClick: (r: EditorResult) => void; closes?: boolean }>;
}

export class ChemEditorModal extends Modal {
  editor: ChemEditor | null = null;

  constructor(app: App, private initial: string | ChemDoc | null, private onSave: (r: EditorResult) => void | Promise<void>, private o: EditorModalOptions = {}) {
    super(app);
  }

  private result(): EditorResult {
    const ed = this.editor!;
    const doc = ed.getDoc();
    let smiles = "";
    try { smiles = ed.getSmiles(); } catch { /* */ }
    return { doc, smiles, molfile: ed.getMolfile(), native: ed.getNative(), hasText: doc.texts.length > 0 };
  }

  onOpen() {
    this.modalEl.addClass("chemedit-modal");
    this.titleEl.setText(this.o.title ?? "ChemEdit");
    const body = this.contentEl.createDiv({ cls: "chemedit-modal-body" });
    const host = body.createDiv({ cls: "chemedit-modal-editor" });
    const foot = body.createDiv({ cls: "chemedit-modal-footer" });
    foot.createSpan({ cls: "chemedit-modal-hint", text: "Ctrl/Cmd+Enter to save · ? for shortcuts" });
    const right = foot.createDiv({ cls: "chemedit-modal-buttons" });
    for (const b of this.o.extraButtons ?? []) {
      const btn = right.createEl("button", { text: b.label });
      btn.onclick = () => { if (!this.editor) return; b.onClick(this.result()); if (b.closes) { this.close(); } };
    }
    const cancel = right.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const save = right.createEl("button", { text: this.o.saveLabel ?? "Save", cls: "mod-cta" });
    save.onclick = () => this.doSave();

    this.editor = new ChemEditor(host, {
      initial: this.initial ?? undefined,
      colorAtoms: this.o.colorAtoms,
      pngScale: this.o.pngScale,
      injectCss: false,
      resolveName: this.o.resolveName,
      saveFile: this.o.saveFile,
      onSubmit: () => this.doSave(),
    });
    // Esc: let the editor consume it first (deselect / close popovers)
    this.modalEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.editor?.handleEscape()) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    this.scope.register([], "Escape", () => { if (this.editor?.handleEscape()) return false; this.close(); return false; });
  }

  private async doSave() {
    if (!this.editor) return;
    if (this.editor.isEmpty()) { new Notice("Nothing drawn yet."); return; }
    const r = this.result();
    this.close();
    try { await this.onSave(r); } catch (e: any) { new Notice("ChemEdit: could not save – " + (e?.message ?? e)); }
  }

  onClose() {
    this.editor?.destroy();
    this.editor = null;
    this.contentEl.empty();
  }
}

export { isEmpty };
