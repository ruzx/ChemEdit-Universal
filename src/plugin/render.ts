// Rendering of structures inside notes + interactions (double-click edit, hover toolbar, context menu).
import { Component, MarkdownPostProcessorContext, Menu, Notice, TFile, setIcon } from "obsidian";
import type ChemEditPlugin from "./main";
import { ChemDoc, isEmpty } from "../chem/model";
import { parseAny, docToSmiles, docToMolfile, docToNative, computeProperties, formatForExtension, serialize, Format } from "../chem/index";
import { EditorResult } from "./modal";
import { setSvg, setRich, setSvgChildren, serializeEl } from "../render/dom";

export type BlockLang = "smiles" | "mol" | "chemedit";
export const BLOCK_LANGS: Record<string, BlockLang> = { smiles: "smiles", smi: "smiles", mol: "mol", molfile: "mol", chemedit: "chemedit" };

export function langFor(format: string): BlockLang {
  return format === "mol" ? "mol" : format === "chemedit" ? "chemedit" : "smiles";
}

/** Serialise a result for a given block language; SMILES falls back to chemedit when text is present. */
export function contentFor(lang: BlockLang, r: EditorResult): { lang: BlockLang; content: string; note?: string } {
  if (lang === "smiles" && r.hasText) return { lang: "chemedit", content: r.native, note: "Drawing contains text, saved as a ChemEdit drawing block." };
  if (lang === "smiles") return { lang, content: r.smiles };
  if (lang === "mol") return { lang, content: r.molfile };
  return { lang, content: r.native };
}

export class StructureView {
  constructor(private plugin: ChemEditPlugin) {}

  /** Render a document into a container; returns the wrapper element. */
  mount(container: HTMLElement, doc: ChemDoc, opts: { inline?: boolean; height?: number; onEdit?: () => void; source?: () => string; menuExtras?: (m: Menu) => void } = {}): HTMLElement {
    const s = this.plugin.settings;
    const wrap = container.createDiv({ cls: opts.inline ? "chemedit-inline" : "chemedit-block" });
    const svg = this.plugin.svgFor(doc, opts.inline ? { maxHeight: opts.height ?? s.inlineHeight, padding: 2 } : {});
    const fig = wrap.createDiv({ cls: "chemedit-figure" });
    setSvg(fig, svg);
    if (!opts.inline && s.showFormula && doc.atoms.length) {
      const p = computeProperties(doc, doc.arrows.length ? "products" : "all");
      if (p) { const cap = wrap.createDiv({ cls: "chemedit-caption" }); setRich(cap, `${p.formulaHtml} · ${p.mw.toFixed(2)} g/mol`); }
    }
    if (opts.onEdit) {
      wrap.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); opts.onEdit!(); });
      wrap.title = "Double-click to edit";
    }
    wrap.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      const m = new Menu();
      if (opts.onEdit) m.addItem((i) => i.setTitle("Edit structure").setIcon("pencil").onClick(() => opts.onEdit!()));
      this.populateMenu(m, doc);
      opts.menuExtras?.(m);
      m.showAtMouseEvent(e);
    });
    if (!opts.inline) {
      const bar = wrap.createDiv({ cls: "chemedit-toolbar" });
      const mk = (icon: string, title: string, fn: (e: MouseEvent) => void) => {
        const b = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": title } });
        setIcon(b, icon);
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(e); };
      };
      if (opts.onEdit) mk("pencil", "Edit structure", () => opts.onEdit!());
      mk("copy", "Copy SMILES", () => this.copy(docToSmiles(doc), "SMILES copied"));
      mk("more-horizontal", "More", (e) => {
        const m = new Menu();
        this.populateMenu(m, doc);
        opts.menuExtras?.(m);
        m.showAtMouseEvent(e);
      });
    }
    return wrap;
  }

  populateMenu(m: Menu, doc: ChemDoc) {
    m.addItem((i) => i.setTitle("Copy SMILES").setIcon("copy").onClick(() => this.copy(docToSmiles(doc), "SMILES copied")));
    m.addItem((i) => i.setTitle("Copy Molfile").setIcon("file-text").onClick(() => this.copy(docToMolfile(doc), "Molfile copied")));
    m.addItem((i) => i.setTitle("Copy SVG").setIcon("image").onClick(() => this.copy(this.plugin.svgFor(doc, { forFile: true }), "SVG copied")));
    m.addItem((i) => i.setTitle("Copy formula & MW").setIcon("info").onClick(() => {
      const p = computeProperties(doc, doc.arrows.length ? "products" : "all");
      if (p) this.copy(`${p.formula}, MW ${p.mw.toFixed(2)}, exact mass ${p.exactMass.toFixed(4)}`, "Copied");
    }));
    m.addSeparator();
    m.addItem((i) => i.setTitle("Save as SVG file").setIcon("save").onClick(async () => {
      const f = await this.plugin.saveSvgFile(doc);
      if (f) { await navigator.clipboard.writeText(`![[${f.path}]]`); new Notice(`Saved ${f.path} (link copied)`); }
    }));
    m.addItem((i) => i.setTitle("Search PubChem").setIcon("globe").onClick(() => window.open(`https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(docToSmiles(doc))}`)));
  }

  async copy(text: string, msg: string) {
    await navigator.clipboard.writeText(text);
    new Notice(msg);
  }

  /** ```smiles / ```mol / ```chemedit code block processor */
  async codeBlock(lang: BlockLang, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    let doc: ChemDoc | null = null;
    let err = "";
    try { doc = parseAny(source, lang === "smiles" ? "smiles" : lang === "mol" ? "mol" : "chemedit"); }
    catch (e: any) { err = e?.message ?? String(e); }
    const edit = () => this.plugin.openEditor(doc && !isEmpty(doc) ? doc : source, async (r) => {
      await this.writeBack(el, ctx, lang, r);
    }, { title: "Edit structure" });
    if (!doc || isEmpty(doc)) {
      const box = el.createDiv({ cls: "chemedit-error" });
      box.setText(err ? `⚠ ${err}` : "Empty structure — double-click to draw");
      box.addEventListener("dblclick", edit);
      return;
    }
    this.mount(el, doc, {
      onEdit: edit,
      menuExtras: (m) => {
        m.addSeparator();
        for (const [l, title] of [["smiles", "Convert block to SMILES"], ["chemedit", "Convert block to ChemEdit drawing"], ["mol", "Convert block to Molfile"]] as const) {
          if (l === lang) continue;
          m.addItem((i) => i.setTitle(title).setIcon("replace").onClick(() => {
            const d = doc!;
            this.writeBack(el, ctx, l, { doc: d, smiles: docToSmiles(d), molfile: docToMolfile(d), native: docToNative(d), hasText: d.texts.length > 0 });
          }));
        }
      },
    });
  }

  /** Replace the code block that produced `el` with new content. */
  async writeBack(el: HTMLElement, ctx: MarkdownPostProcessorContext, lang: BlockLang, r: EditorResult) {
    const info = ctx.getSectionInfo(el);
    const file = this.plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
    const out = contentFor(lang, r);
    if (!info || !(file instanceof TFile)) {
      await navigator.clipboard.writeText(out.content);
      new Notice("Couldn't locate the block in the note (embedded?). Result copied to clipboard.");
      return;
    }
    await this.plugin.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const open = lines[info.lineStart] ?? "";
      const m = /^(\s*(?:>\s*)*)(`{3,}|~{3,})\s*([\w-]*)(.*)$/.exec(open);
      if (!m) return data;
      const [, prefix, fence, , rest] = m;
      const body = out.content.split("\n").map((l) => prefix + l);
      lines.splice(info.lineStart, info.lineEnd - info.lineStart + 1, `${prefix}${fence}${out.lang}${rest}`, ...body, `${prefix}${fence}`);
      return lines.join("\n");
    });
    if (out.note) new Notice(out.note);
  }

  /** $smiles=... inline rendering (reading view) */
  inline(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const prefix = this.plugin.settings.inlineSmilesPrefix;
    if (!prefix || !el.textContent?.includes(prefix)) return;
    const esc = prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re = new RegExp(esc + "([^\\s`]+)", "g");
    // inline code first
    el.querySelectorAll("code").forEach((code) => {
      if (code.parentElement?.tagName === "PRE") return;
      const t = code.textContent ?? "";
      if (!t.startsWith(prefix)) return;
      const smi = t.slice(prefix.length).trim();
      const span = createSpan();
      code.replaceWith(span);
      this.inlineInto(span, smi, el, ctx);
    });
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest("code,pre,.chemedit-inline") ? NodeFilter.FILTER_REJECT : n.textContent?.includes(prefix) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const text = node.textContent ?? "";
      const frag = document.createDocumentFragment();
      let last = 0;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const span = createSpan();
        frag.appendChild(span);
        this.inlineInto(span, m[1], el, ctx);
        last = m.index + m[0].length;
      }
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.replaceWith(frag);
    }
  }

  private inlineInto(span: HTMLElement, smi: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    let doc: ChemDoc;
    try { doc = parseAny(smi, "smiles"); } catch { span.setText(this.plugin.settings.inlineSmilesPrefix + smi); return; }
    const w = this.mount(span, doc, {
      inline: true,
      onEdit: () => this.plugin.openEditor(doc, async (r) => {
        const info = ctx.getSectionInfo(el);
        const file = this.plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if (!info || !(file instanceof TFile)) { await navigator.clipboard.writeText(r.smiles); new Notice("SMILES copied"); return; }
        const prefix = this.plugin.settings.inlineSmilesPrefix;
        await this.plugin.app.vault.process(file, (data) => {
          const lines = data.split("\n");
          for (let i = info.lineStart; i <= info.lineEnd; i++) {
            const idx = lines[i].indexOf(prefix + smi);
            if (idx >= 0) { lines[i] = lines[i].slice(0, idx) + prefix + r.smiles + lines[i].slice(idx + prefix.length + smi.length); break; }
          }
          return lines.join("\n");
        });
      }, { title: "Edit inline structure" }),
    });
    w.title = smi;
  }
}

/** Embed component for ![[file.mol]] / ![[file.chemedit]] (Obsidian embed registry). */
export class ChemFileEmbed extends Component {
  constructor(private plugin: ChemEditPlugin, private containerEl: HTMLElement, private file: TFile) { super(); }
  async loadFile() {
    const data = await this.plugin.app.vault.read(this.file);
    this.containerEl.empty();
    this.containerEl.addClass("chemedit-embed");
    let doc: ChemDoc;
    try { doc = parseAny(data, formatForExtension(this.file.extension)); }
    catch (e: any) { this.containerEl.createDiv({ cls: "chemedit-error", text: `⚠ ${this.file.name}: ${e?.message ?? e}` }); return; }
    this.plugin.view.mount(this.containerEl, doc, {
      onEdit: () => this.plugin.openEditor(doc, async (r) => {
        const f = formatForExtension(this.file.extension);
        const out = f === "chemedit" ? r.native : f === "smiles" ? r.smiles : f === "mol" || f === "auto" ? r.molfile : serialize(r.doc, f as Exclude<Format, "auto">);
        await this.plugin.app.vault.modify(this.file, out);
        this.loadFile();
      }, { title: `Edit ${this.file.name}` }),
    });
  }
}
