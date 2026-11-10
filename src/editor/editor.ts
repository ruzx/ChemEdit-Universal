// ChemEditor: a lightweight, dependency-free chemical structure editor (DOM + SVG).

import {
  ArrowKind, Atom, Bond, BondStereo, ChemDoc, Graph, addAtom, addBond, buildGraph, cloneDoc, emptyDoc,
  findBond, getAtom, newId, removeAtom, removeBond, docBBox, translateDoc, mergeInto, isEmpty, components,
} from "../chem/model";
import { isElement, periodicLayout } from "../chem/elements";
import { cleanComponents, freeDirection, polyRadius } from "../chem/layout";
import { parseAny, docToSmiles, docToMolfile, docToNative, formatForExtension, writeCdxml, writeRxn, writeKet, docToSdf, serialize } from "../chem/index";
import { analyse } from "../chem/analysis";
import { svgToPngBlob } from "../render/png";
import { PopupMenu, MenuEntry } from "./menu";
import { computeProperties } from "../chem/props";
import { lookupAbbreviation, ABBREVIATIONS, contractAbbreviations, expandAbbreviations, DEFAULT_CONTRACT } from "../chem/abbrev";
import { renderBody, renderSVG, RenderOptions } from "../render/svg";
import { ICONS } from "./icons";
import { injectEditorCss } from "./css";

const BL = 30; // px per bond in drawing space
const DEG = Math.PI / 180;
type P = { x: number; y: number };
type BondType = "single" | "double" | "triple" | "wedge" | "hash" | "wavy";
type Tool =
  | { k: "select" } | { k: "erase" } | { k: "bond"; t: BondType } | { k: "chain" }
  | { k: "ring"; n: number; arom: boolean } | { k: "atom"; el: string; label?: string; expand?: string }
  | { k: "charge"; d: 1 | -1 } | { k: "arrow"; kind: ArrowKind } | { k: "plus" } | { k: "text" } | { k: "template"; name: string; smi: string };
type Variant = { key: string; icon: string; title: string; tool: Tool; thumb?: string };
type Hit = { t: "atom" | "bond" | "arrow" | "plus" | "text"; id: number; end?: 1 | 2 } | null;

type Drag =
  | { k: "pan"; sx: number; sy: number; px: number; py: number; ctx?: boolean; moved?: boolean; hit?: Hit }
  | { k: "move"; start: P; last: P; ids: Set<number>; moved: boolean; snap: string }
  | { k: "rubber"; start: P; cur: P; add: boolean }
  | { k: "rotate"; c: P; a0: number; ids: Set<number>; orig: string; snap: string; moved: boolean }
  | { k: "bond"; atom: number | null; p: P; cur: P; moved: boolean }
  | { k: "chain"; atom: number | null; p: P; cur: P; moved: boolean }
  | { k: "atomdrag"; atom: number; cur: P; moved: boolean }
  | { k: "arrow"; start: P; cur: P; moved: boolean }
  | { k: "arrowEnd"; id: number; end: 1 | 2; snap: string; moved: boolean }
  | { k: "erase"; snap: string; changed: boolean };

export interface EditorOptions {
  initial?: ChemDoc | string;
  resolveName?: (name: string) => Promise<string | null>;
  onChange?: (doc: ChemDoc) => void;
  colorAtoms?: boolean;
  /** called when the user presses Ctrl/Cmd+Enter */
  onSubmit?: () => void;
  /** host-provided file saving (Obsidian: write into the vault); default = browser download */
  saveFile?: (name: string, data: string | Blob) => void;
  /** inject the editor stylesheet into the document (default true; the Obsidian plugin ships styles.css) */
  injectCss?: boolean;
  /** PNG export: pixels per SVG pixel (default 4 ≈ 300 dpi at journal size) */
  pngScale?: number;
}

const ELEMENT_KEYS: Record<string, string> = { c: "C", n: "N", o: "O", s: "S", p: "P", f: "F", h: "H", i: "I", l: "Cl", b: "Br" };
export const TEMPLATES: Array<[string, string]> = [
  ["Naphthalene", "c1ccc2ccccc2c1"], ["Pyridine", "c1ccncc1"], ["Pyrimidine", "c1cncnc1"], ["Pyrrole", "c1cc[nH]c1"],
  ["Furan", "c1ccoc1"], ["Thiophene", "c1ccsc1"], ["Imidazole", "c1c[nH]cn1"], ["Indole", "c1ccc2[nH]ccc2c1"],
  ["Quinoline", "c1ccc2ncccc2c1"], ["Purine", "c1ncc2[nH]cnc2n1"], ["Piperidine", "C1CCNCC1"], ["Piperazine", "C1CNCCN1"],
  ["Morpholine", "C1COCCN1"], ["Tetrahydropyran", "C1CCOCC1"], ["Cyclohexane", "C1CCCCC1"], ["Adamantane", "C1C2CC3CC1CC(C2)C3"],
  ["Steroid", "C1CCC2C(C1)CCC1C2CCC2CCCC12"], ["β-D-Glucose", "OC[C@H]1O[C@@H](O)[C@H](O)[C@@H](O)[C@@H]1O"],
  ["Ph-CO-", "O=Cc1ccccc1"], ["Amide", "CC(=O)NC"], ["Ester", "CC(=O)OC"], ["Biphenyl", "c1ccc(cc1)-c1ccccc1"],
];

const TOOL_HINTS: Record<string, string> = {
  select: "Click to select · drag to move · drag empty space for a box · round handle rotates · right-click for options",
  erase: "Click or drag over atoms, bonds, arrows and text to delete",
  bond: "Click empty space or an atom · drag for direction · click a bond to change it",
  chain: "Drag to draw a zigzag chain — the bond count is shown",
  ring: "Click empty space, an atom (spiro) or a bond (fused)",
  template: "Click empty space to place · click an atom to attach",
  atom: "Click atoms to change element · click empty space for a new atom · drag from an atom to add a bonded atom",
  charge: "Click atoms to change charge",
  arrow: "Drag to draw · click for a standard arrow · right-click an arrow to change type",
  plus: "Click to place a plus sign",
  text: "Click to type · digits after letters become subscripts (H2SO4)",
};

function toolKey(t: Tool): string {
  switch (t.k) {
    case "bond": return "bond:" + t.t;
    case "ring": return t.arom ? "ring:benz" : "ring:" + t.n;
    case "charge": return t.d > 0 ? "charge:+" : "charge:-";
    case "arrow": return "arrow:" + t.kind;
    case "template": return "tmpl:" + t.name;
    case "atom": return t.label ? "atom:label" : ["C", "H", "N", "O", "S", "P", "F", "Cl", "Br", "I"].includes(t.el) ? "atom:" + t.el : "atom:other";
    default: return t.k;
  }
}

const QUICK_LABELS = ["Me", "Et", "iPr", "tBu", "Ph", "Bn", "OMe", "OAc", "OH", "NH2", "NO2", "CN", "CF3", "CO2Me", "CO2H", "CHO", "Boc", "Cbz", "Ts", "Ms", "OTf", "TBS", "TMS", "Bpin", "Ac", "Bz", "SMe", "NMe2"];

export class ChemEditor {
  readonly root: HTMLDivElement;
  private svg!: SVGSVGElement;
  private viewG!: SVGGElement;
  private contentG!: SVGGElement;
  private overlayG!: SVGGElement;
  private wrap!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private toastEl!: HTMLDivElement;
  private importInput!: HTMLInputElement;
  private toolBtns = new Map<string, HTMLButtonElement>();
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private pop: HTMLElement | null = null;
  private textEditor: HTMLTextAreaElement | null = null;

  doc: ChemDoc = emptyDoc();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private sel = new Set<number>();
  private hover: Hit = null;
  private tool: Tool = { k: "bond", t: "single" };
  private arrowKind: ArrowKind = "forward";
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private drag: Drag | null = null;
  private pointer: P = { x: 0, y: 0 };
  private spaceDown = false;
  private clip: { native: string; smiles: string } | null = null;
  private g: Graph | null = null;
  private statusTimer: number | null = null;
  private ro: ResizeObserver | null = null;
  private lastClick = { t: 0, x: 0, y: 0 };
  private destroyed = false;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { d0: number; z0: number; mx: number; my: number; px: number; py: number } | null = null;
  private longPress: number | null = null;
  private suppressUp = false;
  private lastPointerType = "mouse";

  constructor(host: HTMLElement, private opts: EditorOptions = {}) {
    if (opts.injectCss !== false) injectEditorCss(host.ownerDocument);
    this.root = host.ownerDocument.createElement("div");
    this.root.className = "ce-root";
    this.root.tabIndex = 0;
    host.appendChild(this.root);
    this.build();
    if (opts.initial) this.setDoc(opts.initial, false);
    else this.render();
    this.ro = new ResizeObserver(() => { if (!this.fitted && this.wrap.clientWidth > 0) { this.fitted = true; this.fit(); } });
    this.ro.observe(this.wrap);
    requestAnimationFrame(() => { this.fit(); this.root.focus({ preventScroll: true }); });
  }
  private fitted = false;

  // ------------------------------------------------------------------ public API
  getDoc(): ChemDoc { return cloneDoc(this.doc); }
  getSmiles(): string { return docToSmiles(this.doc); }
  getMolfile(): string { return docToMolfile(this.doc); }
  getNative(): string { return docToNative(this.doc); }
  getSVG(opts: RenderOptions = {}): string { return renderSVG(this.doc, { colorAtoms: this.opts.colorAtoms !== false, ...opts }); }
  isEmpty(): boolean { return isEmpty(this.doc); }

  setDoc(input: ChemDoc | string, undoable = true) {
    let d: ChemDoc;
    try { d = typeof input === "string" ? parseAny(input) : cloneDoc(input); }
    catch (e: any) { this.toast("Could not read structure: " + (e?.message ?? e)); return; }
    if (undoable) this.pushUndo();
    this.doc = d;
    this.sel.clear();
    this.changed(false);
    requestAnimationFrame(() => this.fit());
  }

  /** Esc handling for hosts (modal). Returns true if consumed. */
  handleEscape(): boolean {
    if (this.menu?.open) { this.menu.close(); return true; }
    if (this.pop) { this.closePop(); return true; }
    if (this.textEditor) { this.textEditor.blur(); return true; }
    if (this.drag) { this.drag = null; this.render(); return true; }
    if (this.sel.size) { this.sel.clear(); this.renderOverlay(); return true; }
    return false;
  }

  focus() { this.root.focus({ preventScroll: true }); }

  destroy() {
    this.destroyed = true;
    this.ro?.disconnect();
    if (this.statusTimer) window.clearTimeout(this.statusTimer);
    this.root.remove();
  }

  // ------------------------------------------------------------------ DOM
  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
    const e = this.root.ownerDocument.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  private btn(parent: HTMLElement, icon: string, title: string, onClick: (e: MouseEvent) => void, label?: string): HTMLButtonElement {
    const b = this.el("button", "ce-btn", parent);
    b.type = "button";
    b.title = title;
    b.innerHTML = (ICONS[icon] ?? "") + (label ? `<span>${label}</span>` : "");
    b.addEventListener("click", (e) => { e.preventDefault(); onClick(e); this.focus(); });
    return b;
  }

  private groups = new Map<string, { btn: HTMLButtonElement; variants: Variant[]; cur: number }>();
  private menu!: PopupMenu;
  private analysisEl!: HTMLDivElement;
  private analysisOn = false;
  private hintEl!: HTMLSpanElement;
  private fileInput!: HTMLInputElement;

  private build() {
    this.menu = new PopupMenu(this.root);
    const top = this.el("div", "ce-top", this.root);
    this.undoBtn = this.btn(top, "undo", "Undo (Ctrl+Z)", () => this.undo());
    this.redoBtn = this.btn(top, "redo", "Redo (Ctrl+Shift+Z)", () => this.redo());
    this.el("span", "ce-sep", top);
    this.group(top, "select", [{ key: "select", icon: "select", title: "Select, move, rotate (V / Esc)", tool: { k: "select" } }]);
    this.group(top, "erase", [{ key: "erase", icon: "erase", title: "Eraser (E)", tool: { k: "erase" } }]);
    this.el("span", "ce-sep", top);
    this.group(top, "bond", [
      { key: "bond:single", icon: "single", title: "Single bond (1) — click a bond to cycle order", tool: { k: "bond", t: "single" } },
      { key: "bond:double", icon: "double", title: "Double bond (2)", tool: { k: "bond", t: "double" } },
      { key: "bond:triple", icon: "triple", title: "Triple bond (3)", tool: { k: "bond", t: "triple" } },
      { key: "bond:wedge", icon: "wedge", title: "Wedge (W) — click again to reverse", tool: { k: "bond", t: "wedge" } },
      { key: "bond:hash", icon: "hash", title: "Hashed wedge (H)", tool: { k: "bond", t: "hash" } },
      { key: "bond:wavy", icon: "wavy", title: "Wavy (unknown stereo)", tool: { k: "bond", t: "wavy" } },
    ]);
    this.group(top, "chain", [{ key: "chain", icon: "chain", title: "Chain — drag to draw (C)", tool: { k: "chain" } }]);
    this.group(top, "ring", [
      { key: "ring:benz", icon: "benzene", title: "Benzene (A)", tool: { k: "ring", n: 6, arom: true } },
      { key: "ring:6", icon: "r6", title: "Cyclohexane (6)", tool: { k: "ring", n: 6, arom: false } },
      { key: "ring:5", icon: "r5", title: "Cyclopentane (5)", tool: { k: "ring", n: 5, arom: false } },
      { key: "ring:3", icon: "r3", title: "Cyclopropane (3)", tool: { k: "ring", n: 3, arom: false } },
      { key: "ring:4", icon: "r4", title: "Cyclobutane (4)", tool: { k: "ring", n: 4, arom: false } },
      { key: "ring:7", icon: "r7", title: "Cycloheptane (7)", tool: { k: "ring", n: 7, arom: false } },
      { key: "ring:8", icon: "r8", title: "Cyclooctane (8)", tool: { k: "ring", n: 8, arom: false } },
    ]);
    this.group(top, "tmpl", TEMPLATES.map(([name, smi]) => ({ key: "tmpl:" + name, icon: "tmpl", title: name + " template", tool: { k: "template", name, smi } as Tool, thumb: smi })));
    this.group(top, "charge", [
      { key: "charge:+", icon: "plusCharge", title: "Positive charge (+)", tool: { k: "charge", d: 1 } },
      { key: "charge:-", icon: "minusCharge", title: "Negative charge (−)", tool: { k: "charge", d: -1 } },
    ]);
    this.group(top, "arrow", (["forward", "equilibrium", "retro", "resonance", "dashed"] as ArrowKind[]).map((k) => ({
      key: "arrow:" + k, icon: k === "forward" ? "arrow" : k, title: { forward: "Reaction arrow (R)", equilibrium: "Equilibrium arrow", retro: "Retrosynthetic arrow", resonance: "Resonance arrow", dashed: "Dashed arrow" }[k], tool: { k: "arrow", kind: k } as Tool,
    })));
    this.group(top, "plus", [{ key: "plus", icon: "plus", title: "Reaction plus", tool: { k: "plus" } }]);
    this.group(top, "text", [{ key: "text", icon: "text", title: "Text / caption (T) — digits after letters become subscripts", tool: { k: "text" } }]);
    this.el("span", "ce-sep", top);
    this.btn(top, "clean", "Clean up structure (selection or all)", () => this.clean());
    this.btn(top, "flipH", "Flip horizontal", () => this.flip(true));
    this.btn(top, "flipV", "Flip vertical", () => this.flip(false));
    this.btn(top, "more", "More structure commands", (e) => this.showMenuAt(e.currentTarget as HTMLElement, this.structureMenu()));
    this.el("span", "ce-sep ce-hide-narrow", top);
    this.btn(top, "zoomOut", "Zoom out", () => this.zoomBy(1 / 1.25)).classList.add("ce-hide-narrow");
    this.btn(top, "fit", "Fit to view (Ctrl+0)", () => this.fit());
    this.btn(top, "zoomIn", "Zoom in", () => this.zoomBy(1.25)).classList.add("ce-hide-narrow");
    this.el("span", "ce-spacer", top);
    this.importInput = this.el("input", "ce-import", top);
    this.importInput.placeholder = this.opts.resolveName ? "SMILES / name…" : "SMILES / Molfile…";
    this.importInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); this.importText(this.importInput.value); }
      if (e.key === "Escape") { this.importInput.value = ""; this.focus(); }
    });
    this.btn(top, "open", "Add structure: from the text box, or open a file (MOL, SDF, RXN, CDXML, KET, SMI, SVG)", () => {
      if (this.importInput.value.trim()) this.importText(this.importInput.value); else this.fileInput.click();
    });
    this.btn(top, "download", "Copy / export (SMILES, Molfile, CDXML, SVG, PNG…)", (e) => this.showMenuAt(e.currentTarget as HTMLElement, this.exportMenu()));
    const an = this.btn(top, "sigma", "Analysis: formula, exact mass, m/z, elemental analysis", () => this.toggleAnalysis());
    this.toolBtns.set("analysis", an);
    this.btn(top, "help", "Shortcuts & help (?)", (e) => this.showHelp(e));

    // second bar: elements & labels (ChemWindow-style style bar)
    const sub = this.el("div", "ce-sub", this.root);
    for (const el of ["C", "H", "N", "O", "S", "P", "F", "Cl", "Br", "I"]) {
      const b = this.btn(sub, "", `${el} — click atoms to set, or hover an atom and press ${Object.keys(ELEMENT_KEYS).find((k) => ELEMENT_KEYS[k] === el)?.toUpperCase() ?? el}`, () => this.setTool({ k: "atom", el }), el);
      b.classList.add(`ce-el-${el}`, "ce-elbtn");
      this.toolBtns.set("atom:" + el, b);
    }
    const pt = this.btn(sub, "table", "Periodic table", () => this.showPeriodicTable(pt));
    this.toolBtns.set("atom:other", pt);
    const lb = this.btn(sub, "", "Label / abbreviation (OMe, Boc, Ph…)", () => this.showLabelPop(lb), "Abc");
    lb.classList.add("ce-elbtn");
    this.toolBtns.set("atom:label", lb);
    this.el("span", "ce-sep", sub);
    this.hintEl = this.el("span", "ce-hint", sub);

    const main = this.el("div", "ce-main", this.root);
    this.wrap = this.el("div", "ce-canvas-wrap", main);
    const NS = "http://www.w3.org/2000/svg";
    this.svg = this.root.ownerDocument.createElementNS(NS, "svg") as SVGSVGElement;
    this.svg.setAttribute("class", "ce-canvas");
    this.viewG = this.root.ownerDocument.createElementNS(NS, "g") as SVGGElement;
    this.contentG = this.root.ownerDocument.createElementNS(NS, "g") as SVGGElement;
    this.overlayG = this.root.ownerDocument.createElementNS(NS, "g") as SVGGElement;
    this.viewG.appendChild(this.contentG);
    this.viewG.appendChild(this.overlayG);
    this.svg.appendChild(this.viewG);
    this.wrap.appendChild(this.svg);
    this.analysisEl = this.el("div", "ce-analysis", main);

    this.statusEl = this.el("div", "ce-status", this.root);
    this.toastEl = this.el("div", "ce-toast", this.root);
    this.fileInput = this.el("input", "", this.root);
    this.fileInput.type = "file";
    this.fileInput.accept = ".mol,.sdf,.sd,.rxn,.cdxml,.ket,.smi,.smiles,.chemedit,.svg,.txt,.cml,.xyz,.mol2,.pdb";
    this.fileInput.style.display = "none";
    this.fileInput.addEventListener("change", async () => {
      const f = this.fileInput.files?.[0];
      if (!f) return;
      const text = await f.text();
      this.fileInput.value = "";
      this.importFileText(text, f.name);
    });

    // events
    this.svg.addEventListener("pointerdown", (e) => this.onDown(e));
    this.svg.addEventListener("pointermove", (e) => this.onMove(e));
    this.svg.addEventListener("pointerup", (e) => this.onUp(e));
    this.svg.addEventListener("pointercancel", (e) => { this.touches.delete(e.pointerId); this.pinch = null; this.drag = null; this.render(); });
    this.svg.addEventListener("pointerleave", () => { if (!this.drag) { this.hover = null; this.renderOverlay(); } });
    this.svg.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.svg.addEventListener("contextmenu", (e) => e.preventDefault());
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    this.root.addEventListener("keyup", (e) => { if (e.key === " ") { this.spaceDown = false; this.svg.classList.remove("ce-panning"); } });
    this.root.addEventListener("paste", (e) => this.onPaste(e as ClipboardEvent));
    this.root.addEventListener("copy", (e) => this.onCopy(e as ClipboardEvent, false));
    this.root.addEventListener("cut", (e) => this.onCopy(e as ClipboardEvent, true));
    this.setTool(this.tool);
  }

  private group(parent: HTMLElement, id: string, variants: Variant[]) {
    const b = this.el("button", "ce-btn ce-tool", parent);
    b.type = "button";
    const entry = { btn: b, variants, cur: 0 };
    this.groups.set(id, entry);
    const paint = () => {
      const v = variants[entry.cur];
      b.title = v.title + (variants.length > 1 ? " — click again for more" : "");
      b.innerHTML = (ICONS[v.icon] ?? "") + (variants.length > 1 ? `<i class="ce-tri"></i>` : "");
    };
    paint();
    (b as any).__paint = paint;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      const onTri = (e.target as HTMLElement).classList?.contains("ce-tri");
      if (variants.length > 1 && (onTri || b.classList.contains("ce-on"))) { this.showFlyout(id); return; }
      this.setTool(variants[entry.cur].tool);
      this.focus();
    });
  }

  private showFlyout(id: string) {
    const g = this.groups.get(id)!;
    this.openPop(g.btn, (p) => {
      p.classList.add("ce-flyout");
      if (id === "tmpl") p.classList.add("ce-flyout-tmpl");
      g.variants.forEach((v, i) => {
        const b = this.el("button", "ce-btn" + (i === g.cur ? " ce-on" : ""), p);
        b.type = "button";
        b.title = v.title;
        if (v.thumb) {
          let svg = "";
          try { svg = renderSVG(parseAny(v.thumb), { bondLength: 11, padding: 2, maxWidth: 64, maxHeight: 46, colorAtoms: true }); } catch { /* */ }
          b.innerHTML = `<span class="ce-thumb">${svg}</span><span class="ce-thumb-l">${v.title.replace(" template", "")}</span>`;
        } else b.innerHTML = (ICONS[v.icon] ?? "") + `<span class="ce-fly-l">${v.title.split(" (")[0].split(" —")[0]}</span>`;
        b.addEventListener("click", () => { g.cur = i; this.setTool(v.tool); this.closePop(); this.focus(); });
      });
    });
  }

  private showMenuAt(anchor: HTMLElement, items: MenuEntry[]) {
    const r = anchor.getBoundingClientRect(), rr = this.root.getBoundingClientRect();
    this.closePop();
    this.menu.show(items, r.left - rr.left, r.bottom - rr.top + 2);
  }

  setTool(t: Tool) {
    this.tool = t;
    if (t.k === "arrow") this.arrowKind = t.kind;
    const key = toolKey(t);
    for (const [, g] of this.groups) {
      const idx = g.variants.findIndex((v) => v.key === key);
      if (idx >= 0) { g.cur = idx; (g.btn as any).__paint(); }
      g.btn.classList.toggle("ce-on", idx >= 0);
    }
    for (const [k, b] of this.toolBtns) if (k.startsWith("atom:")) b.classList.toggle("ce-on", k === key || (key === "atom:other" && k === "atom:other"));
    const lb = this.toolBtns.get("atom:label");
    if (lb) lb.innerHTML = `<span>${t.k === "atom" && t.label ? t.label : "Abc"}</span>`;
    const ob = this.toolBtns.get("atom:other");
    if (ob) ob.innerHTML = t.k === "atom" && !t.label && !this.toolBtns.has("atom:" + t.el) ? `<span>${t.el}</span>` : ICONS.table;
    this.svg.setAttribute("class", `ce-canvas ce-tool-${t.k}`);
    if (this.hintEl) this.hintEl.textContent = TOOL_HINTS[t.k] ?? "";
    this.renderOverlay();
  }

  // ------------------------------------------------------------------ menus
  private structureMenu(): MenuEntry[] {
    const hasSel = this.sel.size > 0;
    return [
      { label: "Clean up", action: () => this.clean() },
      { label: "Abbreviate groups (OAc, CO₂Me, Boc…)", action: () => this.abbreviate() },
      { label: "Expand abbreviations", action: () => this.expandLabels() },
      "-",
      { label: "Rotate 90° clockwise", action: () => this.rotateBy(90) },
      { label: "Rotate 90° counter-clockwise", action: () => this.rotateBy(-90) },
      { label: "Rotate 180°", action: () => this.rotateBy(180) },
      "-",
      { label: "Select all", shortcut: "Ctrl+A", action: () => this.selectAll() },
      { label: "Delete selection", disabled: !hasSel, action: () => this.deleteSelection() },
      { label: "Clear canvas", danger: true, action: () => this.mutate(() => { this.doc = emptyDoc(); this.sel.clear(); }) },
    ];
  }

  private exportMenu(): MenuEntry[] {
    const d = this.selectionDoc() ?? this.doc;
    const what = this.sel.size ? " (selection)" : "";
    const saveAs = (ext: string, data: () => string | Promise<Blob>) => ({ label: `.${ext}`, action: async () => this.saveFile(`structure.${ext}`, await data()) });
    return [
      { label: "Copy SMILES" + what, action: () => this.copyText(docToSmiles(d), "SMILES copied") },
      { label: "Copy SMILES (Kekulé)" + what, action: () => this.copyText(docToSmiles(d, { aromatic: false }), "Kekulé SMILES copied") },
      { label: "Copy Molfile" + what, action: () => this.copyText(docToMolfile(d), "Molfile copied") },
      { label: "Copy CDXML (ChemDraw)" + what, action: () => this.copyText(writeCdxml(d), "CDXML copied — paste into ChemDraw") },
      { label: "Copy SVG" + what, action: () => this.copyText(this.svgOf(d), "SVG copied") },
      { label: "Copy image (PNG)" + what, action: () => this.copyPng(d) },
      "-",
      { label: "Save as…", submenu: [
        saveAs("mol", () => docToMolfile(d)), saveAs("sdf", () => docToSdf(d)), saveAs("rxn", () => writeRxn(d)),
        saveAs("cdxml", () => writeCdxml(d)), saveAs("ket", () => writeKet(d)), saveAs("smi", () => docToSmiles(d) + "\n"),
        saveAs("cml", () => serialize(d, "cml")), saveAs("mol2", () => serialize(d, "mol2")), saveAs("xyz", () => serialize(d, "xyz")),
        saveAs("svg", () => this.svgOf(d)), saveAs("png", () => svgToPngBlob(this.svgOf(d), this.opts.pngScale ?? 4)),
      ] },
      { label: "Open file…", action: () => this.fileInput.click() },
    ];
  }

  private svgOf(d: ChemDoc) {
    return renderSVG(d, { bondLength: 30, colorAtoms: this.opts.colorAtoms !== false, color: "#000000", padding: 10 });
  }

  private async copyPng(d: ChemDoc) {
    try {
      const blob = await svgToPngBlob(this.svgOf(d), this.opts.pngScale ?? 4);
      const CI = (window as any).ClipboardItem;
      await navigator.clipboard.write([new CI({ "image/png": blob })]);
      this.toast("Image copied — paste into Word, PowerPoint…");
    } catch { this.toast("Image clipboard not available here"); }
  }

  private saveFile(name: string, data: string | Blob) {
    if (this.opts.saveFile) { this.opts.saveFile(name, data); return; }
    const blob = typeof data === "string" ? new Blob([data], { type: "text/plain" }) : data;
    const a = this.root.ownerDocument.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  private importFileText(text: string, name: string) {
    let d: ChemDoc | null = null;
    try {
      const ext = name.split(".").pop() ?? "";
      if (ext.toLowerCase() === "svg") {
        const m = /<chemedit[^>]*format="([^"]+)"[^>]*>([\s\S]*?)<\/chemedit>/.exec(text);
        if (!m) { this.toast("This SVG has no embedded structure"); return; }
        const raw = m[2].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
        d = parseAny(raw);
      } else d = parseAny(text, formatForExtension(ext));
    } catch (e: any) { this.toast("Could not read file: " + (e?.message ?? e)); return; }
    if (d && !isEmpty(d)) this.insertDoc(d);
  }

  private openContextMenu(clientX: number, clientY: number, hit: Hit) {
    const rr = this.root.getBoundingClientRect();
    const x = clientX - rr.left, y = clientY - rr.top;
    this.closePop();
    let items: MenuEntry[];
    if (hit && this.sel.has(hit.id) && this.sel.size > 1) items = this.selectionMenu();
    else if (hit?.t === "atom") { this.sel.clear(); items = this.atomMenu(hit.id, clientX, clientY); }
    else if (hit?.t === "bond") { this.sel.clear(); items = this.bondMenu(hit.id); }
    else if (hit?.t === "arrow") items = this.arrowMenu(hit.id);
    else if (hit?.t === "text") items = [
      { label: "Edit text…", action: () => this.editText(hit.id) },
      "-", { label: "Delete", danger: true, action: () => this.mutate(() => this.eraseHit(hit)) }];
    else if (hit?.t === "plus") items = [{ label: "Delete", danger: true, action: () => this.mutate(() => this.eraseHit(hit)) }];
    else if (this.sel.size) items = this.selectionMenu();
    else items = this.canvasMenu();
    if (hit) { this.hover = hit; this.renderOverlay(); }
    this.menu.show(items, x, y);
  }

  private atomMenu(id: number, cx: number, cy: number): MenuEntry[] {
    const a = getAtom(this.doc, id)!;
    const setEl = (el: string) => () => this.mutate(() => { a.el = el; delete a.label; delete a.expand; delete a.hCount; delete a.isotope; });
    const els = ["C", "H", "N", "O", "S", "P", "F", "Cl", "Br", "I", "B", "Si", "Se", "Li", "Na", "K", "Mg", "Zn", "Cu", "Pd", "Pt", "Sn"];
    const iso: Record<string, number[]> = { H: [2, 3], C: [13, 14], N: [15], O: [17, 18], F: [18], S: [34], Cl: [37] };
    const entries: MenuEntry[] = [
      { label: "Element", submenu: [...els.map((e) => ({ label: e, checked: a.el === e && !a.label, action: setEl(e) })), "-", { label: "Periodic table…", action: () => this.showPeriodicTable(null, id, { x: cx, y: cy }) }] },
      { label: a.label ? `Label “${a.label}”…` : "Label / abbreviation…", action: () => this.showLabelPop(null, id) },
    ];
    if (a.label && a.expand) entries.push({ label: `Expand ${a.label}`, action: () => this.expandLabels(new Set([id])) });
    entries.push(
      { label: "Charge", submenu: [2, 1, 0, -1, -2].map((q) => ({ label: q > 0 ? `+${q}` : q < 0 ? `−${-q}` : "Neutral", checked: a.charge === q, action: () => this.mutate(() => { a.charge = q; }) })) },
      { label: "Hydrogens", submenu: [{ label: "Automatic", checked: a.hCount === undefined, action: () => this.mutate(() => { delete a.hCount; }) }, ...[0, 1, 2, 3].map((h) => ({ label: String(h), checked: a.hCount === h, action: () => this.mutate(() => { a.hCount = h; }) }))] },
      { label: "Isotope", submenu: [{ label: "Natural", checked: !a.isotope, action: () => this.mutate(() => { delete a.isotope; }) }, ...(iso[a.el] ?? []).map((m) => ({ label: `${m}${a.el}${a.el === "H" && m === 2 ? " (D)" : ""}`, checked: a.isotope === m, action: () => this.mutate(() => { a.isotope = m; }) }))] },
      { label: "Radical", checked: !!a.radical, action: () => this.mutate(() => { a.radical = a.radical ? 0 : 1; if (!a.radical) delete a.radical; }) },
      "-",
      { label: "Attach", submenu: [
        { label: "Methyl", action: () => this.attachGroup(id, "C") }, { label: "OH", action: () => this.attachGroup(id, "O") },
        { label: "NH₂", action: () => this.attachGroup(id, "N") }, { label: "=O (carbonyl)", action: () => this.attachGroup(id, "O", 2) },
        { label: "Phenyl", action: () => this.attachTemplate(id, "c1ccccc1") }, { label: "Cyclohexyl", action: () => this.attachTemplate(id, "C1CCCCC1") },
        { label: "Spiro ring (6)", action: () => { const pl = this.ringPlacement(6, { t: "atom", id }, a); if (pl) this.mutate(() => this.commitRing(pl, false)); } },
      ] },
      { label: "Select fragment", action: () => this.selectFragment(id) },
      "-",
      { label: "Delete atom", shortcut: "Del", danger: true, action: () => this.mutate(() => this.eraseHit({ t: "atom", id })) },
    );
    return entries;
  }

  private bondMenu(id: number): MenuEntry[] {
    const b = this.doc.bonds.find((x) => x.id === id)!;
    const set = (order: number, stereo: BondStereo) => () => this.mutate(() => { b.order = order; b.stereo = stereo; if (order !== 2) delete b.dbl; });
    const entries: MenuEntry[] = [
      { label: "Single", checked: b.order === 1 && !b.stereo, action: set(1, 0) },
      { label: "Double", checked: b.order === 2, action: set(2, 0) },
      { label: "Triple", checked: b.order === 3, action: set(3, 0) },
      "-",
      { label: "Wedge", checked: b.stereo === 1, action: set(1, 1) },
      { label: "Hashed wedge", checked: b.stereo === 6, action: set(1, 6) },
      { label: "Wavy", checked: b.stereo === 4, action: set(1, 4) },
    ];
    if (b.stereo) entries.push({ label: "Reverse stereo direction", action: () => this.mutate(() => { const t = b.a; b.a = b.b; b.b = t; }) });
    if (b.order === 2) entries.push({ label: "Double bond position", submenu: ([[undefined, "Automatic"], [1, "Left"], [2, "Centred"], [-1, "Right"]] as Array<[Bond["dbl"], string]>).map(([v, l]) => ({ label: l, checked: (b.dbl ?? undefined) === v, action: () => this.mutate(() => { if (v === undefined) delete b.dbl; else b.dbl = v; }) })) });
    entries.push(
      "-",
      { label: "Fuse ring", submenu: [[3, false], [4, false], [5, false], [6, false], [6, true], [7, false]].map(([n, ar]) => ({ label: ar ? "Benzene" : `${n}-membered`, action: () => { const pl = this.ringPlacement(n as number, { t: "bond", id }, this.pointer); if (pl) this.mutate(() => this.commitRing(pl, ar as boolean)); } })) },
      { label: "Select fragment", action: () => this.selectFragment(b.a) },
      "-",
      { label: "Delete bond", shortcut: "Del", danger: true, action: () => this.mutate(() => this.eraseHit({ t: "bond", id })) },
    );
    return entries;
  }

  private arrowMenu(id: number): MenuEntry[] {
    const r = this.doc.arrows.find((x) => x.id === id)!;
    const kinds: Array<[ArrowKind, string]> = [["forward", "Reaction"], ["equilibrium", "Equilibrium"], ["retro", "Retrosynthesis"], ["resonance", "Resonance"], ["dashed", "Dashed"]];
    return [
      ...kinds.map(([k, l]) => ({ label: l, checked: r.kind === k, action: () => this.mutate(() => { r.kind = k; }) })),
      "-",
      { label: "Reverse direction", action: () => this.mutate(() => { [r.x1, r.x2] = [r.x2, r.x1]; [r.y1, r.y2] = [r.y2, r.y1]; }) },
      { label: "Add conditions text", action: () => this.editText(null, { x: (r.x1 + r.x2) / 2, y: Math.min(r.y1, r.y2) - 0.55 }) },
      "-",
      { label: "Delete arrow", danger: true, action: () => this.mutate(() => this.eraseHit({ t: "arrow", id })) },
    ];
  }

  private selectionMenu(): MenuEntry[] {
    return [
      { label: "Cut", shortcut: "Ctrl+X", action: () => { this.copySelectionToClip(); this.deleteSelection(); } },
      { label: "Copy", shortcut: "Ctrl+C", action: () => this.copySelectionToClip() },
      { label: "Copy as", submenu: this.exportMenu().slice(0, 6) },
      { label: "Duplicate", action: () => { const d = this.selectionDoc(); if (d) this.insertDoc(d, 0.8); } },
      { label: "Delete", shortcut: "Del", danger: true, action: () => this.deleteSelection() },
      "-",
      { label: "Flip horizontal", action: () => this.flip(true) },
      { label: "Flip vertical", action: () => this.flip(false) },
      { label: "Rotate", submenu: [{ label: "90° clockwise", action: () => this.rotateBy(90) }, { label: "90° counter-clockwise", action: () => this.rotateBy(-90) }, { label: "180°", action: () => this.rotateBy(180) }] },
      { label: "Clean up selection", action: () => this.clean() },
      { label: "Abbreviate groups", action: () => this.abbreviate() },
      { label: "Expand abbreviations", action: () => this.expandLabels() },
      "-",
      { label: "Analysis of selection", action: () => { this.analysisOn = false; this.toggleAnalysis(); } },
      { label: "Deselect", action: () => { this.sel.clear(); this.renderOverlay(); } },
    ];
  }

  private canvasMenu(): MenuEntry[] {
    return [
      { label: "Paste", shortcut: "Ctrl+V", action: async () => { try { const t = await navigator.clipboard.readText(); const d = this.clip && t.trim() === this.clip.smiles ? JSON.parse(this.clip.native) : parseAny(t); this.insertDoc(d); } catch { this.toast("Nothing to paste"); } } },
      { label: "Select all", shortcut: "Ctrl+A", action: () => this.selectAll() },
      { label: "Undo", shortcut: "Ctrl+Z", disabled: !this.undoStack.length, action: () => this.undo() },
      { label: "Redo", shortcut: "Ctrl+Y", disabled: !this.redoStack.length, action: () => this.redo() },
      "-",
      { label: "Clean up all", action: () => this.clean() },
      { label: "Abbreviate groups", action: () => this.abbreviate() },
      { label: "Expand all abbreviations", action: () => this.expandLabels() },
      "-",
      { label: "Add from name / SMILES…", action: () => this.importInput.focus() },
      { label: "Open file…", action: () => this.fileInput.click() },
      { label: "Copy / export", submenu: this.exportMenu() },
      "-",
      { label: "Zoom to fit", shortcut: "Ctrl+0", action: () => this.fit() },
      { label: this.analysisOn ? "Hide analysis" : "Show analysis", action: () => this.toggleAnalysis() },
    ];
  }

  private copySelectionToClip() {
    const d = this.selectionDoc() ?? this.doc;
    const smiles = docToSmiles(d);
    this.clip = { native: JSON.stringify(d), smiles };
    this.copyText(smiles, "Copied (SMILES on clipboard)");
  }

  private selectFragment(atomId: number) {
    const g = this.graph();
    const comp = components(this.doc, g).find((c) => c.includes(atomId)) ?? [];
    this.sel = new Set(comp);
    for (const b of this.doc.bonds) if (this.sel.has(b.a)) this.sel.add(b.id);
    this.setTool({ k: "select" });
  }

  private attachGroup(atomId: number, el: string, order = 1) {
    this.mutate(() => {
      const id = this.growFrom(atomId, order === 2 ? "double" : "single");
      if (id !== null) { const a = getAtom(this.doc, id)!; a.el = el; }
    });
  }

  private attachTemplate(atomId: number, smi: string) {
    let frag: ChemDoc;
    try { frag = parseAny(smi); } catch { return; }
    this.mutate(() => {
      const g = this.graph();
      const a = g.atomById.get(atomId)!;
      const dir = freeDirection(this.doc, g, atomId);
      const f0 = frag.atoms[0];
      let cx = 0, cy = 0;
      for (const t of frag.atoms) { cx += t.x; cy += t.y; }
      cx /= frag.atoms.length; cy /= frag.atoms.length;
      const ang = Math.atan2(dir.y, dir.x) - Math.atan2(cy - f0.y, cx - f0.x);
      const ox = f0.x, oy = f0.y;
      for (const t of frag.atoms) {
        const rx = t.x - ox, ry = t.y - oy;
        t.x = a.x + dir.x + rx * Math.cos(ang) - ry * Math.sin(ang);
        t.y = a.y + dir.y + rx * Math.sin(ang) + ry * Math.cos(ang);
      }
      frag.arrows = []; frag.pluses = []; frag.texts = [];
      const map = mergeInto(this.doc, frag);
      addBond(this.doc, atomId, map.get(f0.id)!, 1);
      this.g = null;
    });
  }

  private placeTemplate(smi: string, hit: Hit, p: P) {
    if (hit?.t === "atom") { this.attachTemplate(hit.id, smi); return; }
    let frag: ChemDoc;
    try { frag = parseAny(smi); } catch { return; }
    const bb = docBBox(frag);
    this.mutate(() => {
      const map = mergeInto(this.doc, frag);
      translateDoc(this.doc, p.x - (bb.minX + bb.maxX) / 2, p.y - (bb.minY + bb.maxY) / 2, new Set(map.values()));
    });
  }

  private abbreviate() {
    const ids = this.selAtomIds();
    this.mutate(() => { this.doc = contractAbbreviations(this.doc, DEFAULT_CONTRACT, ids.size ? ids : undefined); });
    if (!this.doc.atoms.some((a) => a.label)) this.toast("No common groups found to abbreviate");
  }

  private expandLabels(only?: Set<number>) {
    const ids = only ?? (this.sel.size ? this.selAtomIds() : undefined);
    this.mutate(() => { this.doc = expandAbbreviations(this.doc, ids && ids.size ? ids : undefined); });
  }

  private rotateBy(deg: number) {
    const ids = this.sel.size ? this.selAllIds() : new Set([...this.doc.atoms, ...this.doc.arrows, ...this.doc.pluses, ...this.doc.texts].map((o) => o.id));
    const bb = docBBox(this.doc, ids);
    this.mutate(() => rotateDoc(this.doc, { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 }, deg * DEG, ids));
  }

  private toggleAnalysis() {
    this.analysisOn = !this.analysisOn;
    this.analysisEl.classList.toggle("ce-open", this.analysisOn);
    this.toolBtns.get("analysis")?.classList.toggle("ce-on", this.analysisOn);
    this.updateAnalysis();
  }

  private updateAnalysis() {
    if (!this.analysisOn) return;
    const ids = this.selAtomIds();
    const an = analyse(this.doc, ids.size ? ids : undefined);
    const el = this.analysisEl;
    if (!an) { el.innerHTML = `<div class="ce-an-h">Analysis</div><div class="ce-an-empty">Draw or select a structure.</div>`; return; }
    const f4 = (v: number) => v.toFixed(4);
    const rows = (pairs: Array<[string, string]>) => pairs.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
    el.innerHTML = `
      <div class="ce-an-h">Analysis <span>${ids.size ? "selection" : this.doc.arrows.length ? "all fragments" : "structure"}</span></div>
      <table class="ce-an-t">${rows([
        ["Formula", an.formulaHtml], ["MW", an.mw.toFixed(2) + " g/mol"], ["Exact mass", f4(an.exact)],
        ...(an.mz !== null ? [["m/z", f4(an.mz)] as [string, string]] : []),
        ["DBE", an.dbe === null ? "–" : String(an.dbe)], ["Heavy atoms", String(an.heavy)], ["Rings", String(an.rings)],
        ["Stereocentres", an.stereo ? `${an.stereo} (${an.stereoDefined} defined)` : "0"],
        ["H-bond donors / acceptors", `${an.hbd} / ${an.hba}`], ["Rotatable bonds", String(an.rotb)],
      ])}</table>
      ${an.adducts.length ? `<div class="ce-an-s">HRMS ions</div><table class="ce-an-t">${rows(an.adducts.map((x) => [x.ion, f4(x.mz)]))}</table>` : ""}
      <div class="ce-an-s">Elemental analysis</div>
      <table class="ce-an-t">${rows(an.ea.map((x) => [x.el, x.pct.toFixed(2) + " %"]))}</table>`;
    const cp = this.el("button", "ce-btn ce-an-copy", el);
    cp.textContent = "Copy as text";
    cp.addEventListener("click", () => {
      const lines = [`Formula: ${an.formula}`, `MW: ${an.mw.toFixed(2)}`, `Exact mass: ${f4(an.exact)}`, ...an.adducts.map((x) => `${x.ion}: ${f4(x.mz)}`),
        `Anal. calcd for ${an.formula}: ` + an.ea.filter((x) => ["C", "H", "N", "S"].includes(x.el)).map((x) => `${x.el}, ${x.pct.toFixed(2)}`).join("; ") + "."];
      this.copyText(lines.join("\n"), "Analysis copied");
    });
  }

  // ------------------------------------------------------------------ coordinates
  private toModel(clientX: number, clientY: number): P {
    const r = this.svg.getBoundingClientRect();
    return { x: (clientX - r.left - this.panX) / this.zoom / BL, y: (clientY - r.top - this.panY) / this.zoom / BL };
  }
  private toScreen(p: P): P {
    return { x: p.x * BL * this.zoom + this.panX, y: p.y * BL * this.zoom + this.panY };
  }
  private applyView() {
    this.viewG.setAttribute("transform", `translate(${this.panX},${this.panY}) scale(${this.zoom})`);
  }
  fit() {
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    if (!w || !h) return;
    if (isEmpty(this.doc)) { this.zoom = 1.2; this.panX = w / 2; this.panY = h / 2; this.applyView(); return; }
    const r = renderBody(this.doc, { bondLength: BL });
    const bw = r.maxX - r.minX + 60, bh = r.maxY - r.minY + 60;
    this.zoom = Math.min(w / bw, h / bh, 1.8);
    this.panX = w / 2 - ((r.minX + r.maxX) / 2) * this.zoom;
    this.panY = h / 2 - ((r.minY + r.maxY) / 2) * this.zoom;
    this.applyView();
    this.renderOverlay();
  }
  private zoomBy(f: number, cx?: number, cy?: number) {
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    const px = cx ?? w / 2, py = cy ?? h / 2;
    const nz = Math.max(0.15, Math.min(6, this.zoom * f));
    this.panX = px - ((px - this.panX) * nz) / this.zoom;
    this.panY = py - ((py - this.panY) * nz) / this.zoom;
    this.zoom = nz;
    this.applyView();
  }

  // ------------------------------------------------------------------ state helpers
  private graph(): Graph { return (this.g ??= buildGraph(this.doc)); }
  private snapshot(): string { return JSON.stringify(this.doc); }
  private pushUndo(snap = this.snapshot()) {
    this.undoStack.push(snap);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  private mutate(fn: () => void) {
    const before = this.snapshot();
    fn();
    this.g = null;
    if (this.snapshot() !== before) { this.pushUndo(before); this.changed(); }
    else this.render();
  }
  private changed(emit = true) {
    this.g = null;
    // drop selection ids that disappeared
    const ids = new Set<number>([...this.doc.atoms, ...this.doc.bonds, ...this.doc.arrows, ...this.doc.pluses, ...this.doc.texts].map((o) => o.id));
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
    if (this.hover && !ids.has(this.hover.id)) this.hover = null;
    this.render();
    if (emit) this.opts.onChange?.(this.doc);
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.doc = JSON.parse(s);
    this.changed();
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.doc = JSON.parse(s);
    this.changed();
  }

  // ------------------------------------------------------------------ rendering
  render() {
    if (this.destroyed) return;
    const r = renderBody(this.doc, { bondLength: BL, colorAtoms: this.opts.colorAtoms !== false, showValenceErrors: true });
    this.contentG.innerHTML = r.body;
    this.applyView();
    this.renderOverlay();
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
    this.scheduleStatus();
  }

  private scheduleStatus() {
    if (this.statusTimer) window.clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => this.updateStatus(), 120);
  }
  private updateStatus() {
    this.updateAnalysis();
    this.statusEl.innerHTML = "";
    if (!this.doc.atoms.length) { this.statusEl.textContent = "Draw a structure — click to add bonds, drag to set direction, hover + keys for quick edits. Press ? for help."; return; }
    let props = null, smi = "";
    try { props = computeProperties(this.doc, this.doc.arrows.length ? "products" : "all"); } catch { /* ignore */ }
    try { smi = this.getSmiles(); } catch (e: any) { smi = "⚠ " + (e?.message ?? e); }
    const add = (label: string, val: string) => { const s = this.el("span", "", this.statusEl); s.innerHTML = `${label} <b>${val}</b>`; };
    if (props) {
      add(this.doc.arrows.length ? "Product" : "Formula", props.formulaHtml);
      add("MW", props.mw.toFixed(2));
      add("Exact", props.exactMass.toFixed(4));
    }
    const sm = this.el("span", "ce-smiles", this.statusEl);
    sm.textContent = smi;
    sm.title = "Click to copy SMILES";
    sm.addEventListener("click", () => this.copyText(smi, "SMILES copied"));
  }

  private renderOverlay() {
    if (this.destroyed) return;
    const o: string[] = [];
    const acc = "var(--ce-accent)";
    const z = this.zoom;
    const g = this.graph();
    const hl = (h: Hit, color: string, op: number) => {
      if (!h) return;
      if (h.t === "atom") { const a = g.atomById.get(h.id); if (a) o.push(`<circle cx="${a.x * BL}" cy="${a.y * BL}" r="${8}" fill="${color}" opacity="${op}"/>`); }
      if (h.t === "bond") {
        const b = this.doc.bonds.find((x) => x.id === h.id);
        if (b) { const A = g.atomById.get(b.a)!, B = g.atomById.get(b.b)!; o.push(`<line x1="${A.x * BL}" y1="${A.y * BL}" x2="${B.x * BL}" y2="${B.y * BL}" stroke="${color}" stroke-width="9" stroke-linecap="round" opacity="${op}"/>`); }
      }
      if (h.t === "arrow") {
        const r = this.doc.arrows.find((x) => x.id === h.id);
        if (r) {
          o.push(`<line x1="${r.x1 * BL}" y1="${r.y1 * BL}" x2="${r.x2 * BL}" y2="${r.y2 * BL}" stroke="${color}" stroke-width="10" stroke-linecap="round" opacity="${op}"/>`);
          if (h.end) { const ex = h.end === 1 ? r.x1 : r.x2, ey = h.end === 1 ? r.y1 : r.y2; o.push(`<circle cx="${ex * BL}" cy="${ey * BL}" r="6" fill="${color}" opacity="${Math.min(1, op + 0.3)}"/>`); }
        }
      }
      if (h.t === "plus") { const p = this.doc.pluses.find((x) => x.id === h.id); if (p) o.push(`<circle cx="${p.x * BL}" cy="${p.y * BL}" r="9" fill="${color}" opacity="${op}"/>`); }
      if (h.t === "text") {
        const t = this.doc.texts.find((x) => x.id === h.id);
        if (t) { const bb = this.textBox(t); o.push(`<rect x="${bb.x0 * BL}" y="${bb.y0 * BL}" width="${(bb.x1 - bb.x0) * BL}" height="${(bb.y1 - bb.y0) * BL}" rx="3" fill="${color}" opacity="${op}"/>`); }
      }
    };
    // selection
    for (const id of this.sel) {
      const t = this.kindOf(id);
      if (t) hl({ t, id }, acc, 0.3);
    }
    if (this.sel.size > 1 || (this.sel.size === 1 && this.selAtomIds().size > 1)) {
      const bb = this.selBBox();
      if (bb) {
        const cx = (bb.minX + bb.maxX) / 2;
        const hy = bb.minY - 0.9;
        o.push(`<rect x="${(bb.minX - 0.4) * BL}" y="${(bb.minY - 0.4) * BL}" width="${(bb.w + 0.8) * BL}" height="${(bb.h + 0.8) * BL}" fill="none" stroke="${acc}" stroke-width="${1 / z}" stroke-dasharray="${4 / z} ${3 / z}"/>`);
        o.push(`<line x1="${cx * BL}" y1="${(bb.minY - 0.4) * BL}" x2="${cx * BL}" y2="${hy * BL}" stroke="${acc}" stroke-width="${1 / z}"/>`);
        o.push(`<circle class="ce-rot" cx="${cx * BL}" cy="${hy * BL}" r="${6 / z}" fill="var(--ce-bg)" stroke="${acc}" stroke-width="${1.5 / z}"/>`);
      }
    }
    if (this.hover && !this.drag) hl(this.hover, acc, 0.18);
    // previews
    const d = this.drag;
    const ghost = (pts: P[], closed: boolean, extra = "") =>
      o.push(`<poly${closed ? "gon" : "line"} points="${pts.map((p) => `${p.x * BL},${p.y * BL}`).join(" ")}" fill="none" stroke="${acc}" stroke-width="${1.6}" stroke-linejoin="round" stroke-linecap="round" opacity="0.75" ${extra}/>`);
    if (d?.k === "rubber") {
      const x = Math.min(d.start.x, d.cur.x) * BL, y = Math.min(d.start.y, d.cur.y) * BL;
      o.push(`<rect x="${x}" y="${y}" width="${Math.abs(d.cur.x - d.start.x) * BL}" height="${Math.abs(d.cur.y - d.start.y) * BL}" fill="${acc}" fill-opacity="0.08" stroke="${acc}" stroke-width="${1 / z}" stroke-dasharray="${4 / z} ${3 / z}"/>`);
    }
    if ((d?.k === "bond" || d?.k === "atomdrag") && d.moved) {
      const from = d.k === "bond" ? (d.atom !== null ? g.atomById.get(d.atom)! : d.p) : g.atomById.get(d.atom)!;
      const end = this.bondEnd(from, d.cur, d.k === "bond" ? d.atom : d.atom);
      ghost([from, end.p], false);
    }
    if (d?.k === "chain" && d.moved) {
      const pts = this.chainPoints(d);
      ghost(pts, false);
      const last = pts[pts.length - 1];
      o.push(`<text x="${last.x * BL + 8}" y="${last.y * BL - 8}" font-size="${12 / z}" fill="${acc}" font-family="sans-serif">${pts.length - 1}</text>`);
    }
    if (d?.k === "arrow" && d.moved) {
      const e = this.arrowEnd(d.start, d.cur);
      ghost([d.start, e], false);
    }
    if (!d && this.tool.k === "ring" && this.hoverPointValid) {
      const pl = this.ringPlacement(this.tool.n, this.hover, this.pointer);
      if (pl) ghost(pl.pts, true);
    }
    this.overlayG.innerHTML = o.join("");
  }
  private hoverPointValid = false;

  private kindOf(id: number): "atom" | "bond" | "arrow" | "plus" | "text" | null {
    if (this.graph().atomById.has(id)) return "atom";
    if (this.doc.bonds.some((b) => b.id === id)) return "bond";
    if (this.doc.arrows.some((b) => b.id === id)) return "arrow";
    if (this.doc.pluses.some((b) => b.id === id)) return "plus";
    if (this.doc.texts.some((b) => b.id === id)) return "text";
    return null;
  }

  private textBox(t: ChemDoc["texts"][number]) {
    const lines = t.text.split("\n");
    const w = Math.max(...lines.map((l) => l.length)) * 0.36 + 0.3;
    const h = lines.length * 0.85 + 0.15;
    return { x0: t.x - w / 2, x1: t.x + w / 2, y0: t.y - h / 2, y1: t.y + h / 2 };
  }

  // ------------------------------------------------------------------ hit testing
  private hitTest(p: P, opts: { exclude?: Set<number> } = {}): Hit {
    const g = this.graph();
    const tol = Math.max(0.22, (this.lastPointerType === "touch" ? 18 : 9) / (BL * this.zoom));
    let best: Hit = null, bd = tol + 0.08;
    for (const a of this.doc.atoms) {
      if (opts.exclude?.has(a.id)) continue;
      const d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d < bd) { bd = d; best = { t: "atom", id: a.id }; }
    }
    if (best) return best;
    bd = tol * 0.8;
    for (const b of this.doc.bonds) {
      if (opts.exclude?.has(b.a) || opts.exclude?.has(b.b)) continue;
      const A = g.atomById.get(b.a), B = g.atomById.get(b.b);
      if (!A || !B) continue;
      const d = segDist(p, A, B);
      if (d < bd) { bd = d; best = { t: "bond", id: b.id }; }
    }
    if (best) return best;
    for (const t of this.doc.texts) {
      const bb = this.textBox(t);
      if (p.x >= bb.x0 && p.x <= bb.x1 && p.y >= bb.y0 && p.y <= bb.y1) return { t: "text", id: t.id };
    }
    for (const pl of this.doc.pluses) if (Math.hypot(pl.x - p.x, pl.y - p.y) < 0.35) return { t: "plus", id: pl.id };
    for (const r of this.doc.arrows) {
      const A = { x: r.x1, y: r.y1 }, B = { x: r.x2, y: r.y2 };
      if (segDist(p, A, B) < 0.25) {
        const end = Math.hypot(p.x - r.x1, p.y - r.y1) < 0.35 ? 1 : Math.hypot(p.x - r.x2, p.y - r.y2) < 0.35 ? 2 : undefined;
        return { t: "arrow", id: r.id, end };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ pointer events
  private onDown(e: PointerEvent) {
    e.preventDefault(); // keep focus handling under our control
    this.closePop();
    this.menu.close();
    if (this.textEditor) this.textEditor.blur();
    this.focus();
    this.lastPointerType = e.pointerType;
    const p = this.toModel(e.clientX, e.clientY);
    this.pointer = p;
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        // second finger: cancel whatever started and begin pinch/pan
        this.cancelLongPress();
        this.abortDrag();
        const [t1, t2] = [...this.touches.values()];
        const r = this.svg.getBoundingClientRect();
        this.pinch = { d0: Math.hypot(t1.x - t2.x, t1.y - t2.y) || 1, z0: this.zoom, mx: (t1.x + t2.x) / 2 - r.left, my: (t1.y + t2.y) / 2 - r.top, px: this.panX, py: this.panY };
        return;
      }
      if (this.touches.size > 2) return;
      const hit0 = this.hitTest(p);
      this.cancelLongPress();
      this.longPress = window.setTimeout(() => {
        this.longPress = null;
        this.abortDrag();
        this.suppressUp = true;
        this.openContextMenu(e.clientX, e.clientY, hit0);
      }, 520);
    }
    if (e.button === 2) {
      this.drag = { k: "pan", sx: e.clientX, sy: e.clientY, px: this.panX, py: this.panY, ctx: true, moved: false, hit: this.hitTest(p) };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 1 || this.spaceDown) {
      this.drag = { k: "pan", sx: e.clientX, sy: e.clientY, px: this.panX, py: this.panY };
      this.svg.classList.add("ce-panning");
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    this.svg.setPointerCapture(e.pointerId);
    const now = performance.now();
    const dbl = now - this.lastClick.t < 350 && Math.hypot(e.clientX - this.lastClick.x, e.clientY - this.lastClick.y) < 6;
    this.lastClick = { t: now, x: e.clientX, y: e.clientY };
    const hit = this.hitTest(p);
    const t = this.tool;

    // rotation handle (any tool when a multi-selection exists)
    if (this.sel.size && (e.target as Element)?.classList?.contains("ce-rot")) {
      const bb = this.selBBox()!;
      const c = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
      this.drag = { k: "rotate", c, a0: Math.atan2(p.y - c.y, p.x - c.x), ids: this.selAllIds(), orig: this.snapshot(), snap: this.snapshot(), moved: false };
      return;
    }
    if (dbl && hit && (t.k === "select" || t.k === "text") && hit.t === "text") { this.editText(hit.id); return; }
    if (dbl && hit?.t === "atom" && t.k === "select") { this.showLabelPop(null, hit.id); return; }

    switch (t.k) {
      case "select": {
        if (hit) {
          if (hit.t === "arrow" && hit.end && !e.shiftKey) {
            this.drag = { k: "arrowEnd", id: hit.id, end: hit.end, snap: this.snapshot(), moved: false };
            return;
          }
          if (e.shiftKey) { this.sel.has(hit.id) ? this.sel.delete(hit.id) : this.sel.add(hit.id); this.renderOverlay(); return; }
          if (!this.sel.has(hit.id)) { this.sel.clear(); this.sel.add(hit.id); }
          this.drag = { k: "move", start: p, last: p, ids: this.selAllIds(), moved: false, snap: this.snapshot() };
        } else {
          if (!e.shiftKey) this.sel.clear();
          this.drag = { k: "rubber", start: p, cur: p, add: e.shiftKey };
        }
        this.renderOverlay();
        return;
      }
      case "erase": {
        this.drag = { k: "erase", snap: this.snapshot(), changed: false };
        if (hit) { this.eraseHit(hit); (this.drag as any).changed = true; this.g = null; this.render(); }
        return;
      }
      case "bond": {
        if (hit?.t === "bond") { this.clickBond(hit.id, t.t); return; }
        this.drag = { k: "bond", atom: hit?.t === "atom" ? hit.id : null, p, cur: p, moved: false };
        return;
      }
      case "chain": {
        if (hit?.t === "bond") { this.clickBond(hit.id, "single"); return; }
        this.drag = { k: "chain", atom: hit?.t === "atom" ? hit.id : null, p, cur: p, moved: false };
        return;
      }
      case "ring": {
        const pl = this.ringPlacement(t.n, hit, p);
        if (pl) this.mutate(() => this.commitRing(pl, t.arom));
        return;
      }
      case "atom": {
        if (hit?.t === "atom") { this.drag = { k: "atomdrag", atom: hit.id, cur: p, moved: false }; return; }
        if (!hit) this.mutate(() => { const a = addAtom(this.doc, "C", p.x, p.y); this.applyAtomTool(a); });
        return;
      }
      case "charge": {
        if (hit?.t === "atom") this.mutate(() => { const a = getAtom(this.doc, hit.id)!; a.charge += t.d; });
        return;
      }
      case "arrow": {
        if (hit?.t === "arrow") { this.mutate(() => { const r = this.doc.arrows.find((x) => x.id === hit.id)!; r.kind = this.arrowKind; }); return; }
        this.drag = { k: "arrow", start: p, cur: p, moved: false };
        return;
      }
      case "plus": {
        if (hit?.t === "plus") return;
        this.mutate(() => this.doc.pluses.push({ id: newId(this.doc), x: p.x, y: p.y }));
        return;
      }
      case "text": {
        if (hit?.t === "text") this.editText(hit.id);
        else this.editText(null, p);
        return;
      }
      case "template": {
        this.placeTemplate(t.smi, hit, p);
        return;
      }
    }
  }

  private cancelLongPress() { if (this.longPress) { window.clearTimeout(this.longPress); this.longPress = null; } }

  /** Undo the effect of an in-progress drag (used when a gesture turns into pinch / long-press). */
  private abortDrag() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if ((d.k === "move" && d.moved) || (d.k === "rotate" && d.moved) || (d.k === "arrowEnd" && d.moved)) { this.doc = JSON.parse(d.snap); this.g = null; }
    if (d.k === "erase" && d.changed) { this.doc = JSON.parse(d.snap); this.g = null; }
    this.render();
  }

  private onMove(e: PointerEvent) {
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      const t0 = this.touches.get(e.pointerId)!;
      if (this.longPress && Math.hypot(e.clientX - t0.x, e.clientY - t0.y) > 9) this.cancelLongPress();
      if (this.pinch) {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const [t1, t2] = [...this.touches.values()];
        const r = this.svg.getBoundingClientRect();
        const d = Math.hypot(t1.x - t2.x, t1.y - t2.y) || 1;
        const mx = (t1.x + t2.x) / 2 - r.left, my = (t1.y + t2.y) / 2 - r.top;
        const nz = Math.max(0.15, Math.min(6, (this.pinch.z0 * d) / this.pinch.d0));
        this.panX = mx - ((this.pinch.mx - this.pinch.px) * nz) / this.pinch.z0;
        this.panY = my - ((this.pinch.my - this.pinch.py) * nz) / this.pinch.z0;
        this.zoom = nz;
        this.applyView();
        return;
      }
    }
    const p = this.toModel(e.clientX, e.clientY);
    this.pointer = p;
    this.hoverPointValid = true;
    const d = this.drag;
    if (!d) {
      const h = this.hitTest(p);
      const same = (h?.t === this.hover?.t && h?.id === this.hover?.id && h?.end === this.hover?.end);
      this.hover = h;
      if (!same || this.tool.k === "ring") this.renderOverlay();
      return;
    }
    switch (d.k) {
      case "pan":
        if (d.ctx && !d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return;
        d.moved = true;
        this.svg.classList.add("ce-panning");
        this.panX = d.px + (e.clientX - d.sx);
        this.panY = d.py + (e.clientY - d.sy);
        this.applyView();
        return;
      case "move": {
        const dx = p.x - d.last.x, dy = p.y - d.last.y;
        if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < 0.08) return;
        d.moved = true;
        translateDoc(this.doc, dx, dy, d.ids);
        d.last = p;
        this.g = null;
        this.render();
        return;
      }
      case "rotate": {
        const a = Math.atan2(p.y - d.c.y, p.x - d.c.x);
        let da = a - d.a0;
        if (!e.shiftKey) da = Math.round(da / (15 * DEG)) * 15 * DEG;
        const orig = JSON.parse(d.orig) as ChemDoc;
        this.doc = orig;
        rotateDoc(this.doc, d.c, da, d.ids);
        d.moved = true;
        this.g = null;
        this.render();
        return;
      }
      case "rubber": d.cur = p; this.renderOverlay(); return;
      case "bond": case "chain": case "arrow":
        d.cur = p;
        if (!d.moved && Math.hypot(p.x - (d.k === "arrow" ? d.start.x : d.p.x), p.y - (d.k === "arrow" ? d.start.y : d.p.y)) > 0.3) d.moved = true;
        this.renderOverlay();
        return;
      case "atomdrag": {
        d.cur = p;
        const a = this.graph().atomById.get(d.atom)!;
        if (!d.moved && Math.hypot(p.x - a.x, p.y - a.y) > 0.35) d.moved = true;
        this.renderOverlay();
        return;
      }
      case "arrowEnd": {
        const r = this.doc.arrows.find((x) => x.id === d.id);
        if (!r) return;
        const fixed = d.end === 1 ? { x: r.x2, y: r.y2 } : { x: r.x1, y: r.y1 };
        const q = this.arrowEnd(fixed, p, false);
        if (d.end === 1) { r.x1 = q.x; r.y1 = q.y; } else { r.x2 = q.x; r.y2 = q.y; }
        d.moved = true;
        this.render();
        return;
      }
      case "erase": {
        const h = this.hitTest(p);
        if (h) { this.eraseHit(h); d.changed = true; this.g = null; this.render(); }
        return;
      }
    }
  }

  private onUp(e: PointerEvent) {
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      this.cancelLongPress();
      if (this.pinch) { if (this.touches.size < 2) this.pinch = null; this.drag = null; return; }
    }
    if (this.suppressUp) { this.suppressUp = false; this.drag = null; return; }
    const d = this.drag;
    this.drag = null;
    try { this.svg.releasePointerCapture(e.pointerId); } catch { /* */ }
    this.svg.classList.remove("ce-panning");
    if (!d) return;
    const g = this.graph();
    switch (d.k) {
      case "move":
        if (d.moved) {
          this.mergeMoved(d.ids);
          this.pushUndo(d.snap);
          this.changed();
        }
        return;
      case "rotate":
        if (d.moved) { this.pushUndo(d.snap); this.changed(); }
        return;
      case "rubber": {
        const x0 = Math.min(d.start.x, d.cur.x), x1 = Math.max(d.start.x, d.cur.x), y0 = Math.min(d.start.y, d.cur.y), y1 = Math.max(d.start.y, d.cur.y);
        const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
        for (const a of this.doc.atoms) if (inside(a.x, a.y)) this.sel.add(a.id);
        for (const b of this.doc.bonds) if (this.sel.has(b.a) && this.sel.has(b.b)) this.sel.add(b.id);
        for (const r of this.doc.arrows) if (inside(r.x1, r.y1) && inside(r.x2, r.y2)) this.sel.add(r.id);
        for (const pl of this.doc.pluses) if (inside(pl.x, pl.y)) this.sel.add(pl.id);
        for (const t of this.doc.texts) if (inside(t.x, t.y)) this.sel.add(t.id);
        this.renderOverlay();
        return;
      }
      case "bond": {
        const t = this.tool.k === "bond" ? this.tool.t : "single";
        if (!d.moved) {
          if (d.atom !== null) this.mutate(() => this.growFrom(d.atom!, t));
          else this.mutate(() => {
            const a = addAtom(this.doc, "C", d.p.x, d.p.y);
            const b = addAtom(this.doc, "C", d.p.x + Math.cos(-30 * DEG), d.p.y + Math.sin(-30 * DEG));
            this.makeBond(a.id, b.id, t);
          });
          return;
        }
        const from = d.atom !== null ? g.atomById.get(d.atom)! : d.p;
        const end = this.bondEnd(from, d.cur, d.atom);
        this.mutate(() => {
          const a = d.atom ?? addAtom(this.doc, "C", d.p.x, d.p.y).id;
          const b = end.atom ?? addAtom(this.doc, "C", end.p.x, end.p.y).id;
          if (a === b) return;
          const ex = findBond(this.doc, a, b);
          if (ex) { this.g = null; this.clickBondInPlace(ex, t); return; }
          this.makeBond(a, b, t);
        });
        return;
      }
      case "chain": {
        if (!d.moved) {
          if (d.atom !== null) this.mutate(() => this.growFrom(d.atom!, "single"));
          else this.mutate(() => {
            const a = addAtom(this.doc, "C", d.p.x, d.p.y);
            const b = addAtom(this.doc, "C", d.p.x + Math.cos(-30 * DEG), d.p.y + Math.sin(-30 * DEG));
            addBond(this.doc, a.id, b.id, 1);
          });
          return;
        }
        const pts = this.chainPoints(d);
        this.mutate(() => {
          let prev = d.atom ?? addAtom(this.doc, "C", pts[0].x, pts[0].y).id;
          const created: number[] = [];
          for (let i = 1; i < pts.length; i++) {
            const a = addAtom(this.doc, "C", pts[i].x, pts[i].y);
            created.push(a.id);
            addBond(this.doc, prev, a.id, 1);
            prev = a.id;
          }
          this.mergeNew(created);
        });
        return;
      }
      case "atomdrag": {
        const tool = this.tool;
        if (tool.k !== "atom") return;
        if (!d.moved) {
          this.mutate(() => { const a = getAtom(this.doc, d.atom)!; this.applyAtomTool(a); });
          return;
        }
        const from = g.atomById.get(d.atom)!;
        const end = this.bondEnd(from, d.cur, d.atom);
        this.mutate(() => {
          const b = end.atom ?? addAtom(this.doc, "C", end.p.x, end.p.y).id;
          addBond(this.doc, d.atom, b, 1);
          if (end.atom === null) this.applyAtomTool(getAtom(this.doc, b)!);
        });
        return;
      }
      case "arrow": {
        this.mutate(() => {
          if (!d.moved) this.doc.arrows.push({ id: newId(this.doc), x1: d.start.x - 1.25, y1: d.start.y, x2: d.start.x + 1.25, y2: d.start.y, kind: this.arrowKind });
          else { const e2 = this.arrowEnd(d.start, d.cur); this.doc.arrows.push({ id: newId(this.doc), x1: d.start.x, y1: d.start.y, x2: e2.x, y2: e2.y, kind: this.arrowKind }); }
        });
        return;
      }
      case "arrowEnd":
        if (d.moved) { this.pushUndo(d.snap); this.changed(); }
        return;
      case "erase":
        if (d.changed) { this.pushUndo(d.snap); this.changed(); }
        return;
      case "pan":
        if (d.ctx && !d.moved) this.openContextMenu(e.clientX, e.clientY, d.hit ?? null);
        return;
    }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const r = this.svg.getBoundingClientRect();
    const isMouseWheel = e.deltaMode === 1 || (Math.abs(e.deltaY) >= 50 && e.deltaX === 0);
    if (e.ctrlKey || e.metaKey || isMouseWheel) {
      const f = Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1));
      this.zoomBy(f, e.clientX - r.left, e.clientY - r.top);
    } else {
      this.panX -= e.deltaX;
      this.panY -= e.deltaY;
      this.applyView();
    }
    this.renderOverlay();
  }

  // ------------------------------------------------------------------ keyboard
  private onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod) {
      const kl = k.toLowerCase();
      if (kl === "z" && !e.shiftKey) { stop(); this.undo(); return; }
      if ((kl === "z" && e.shiftKey) || kl === "y") { stop(); this.redo(); return; }
      if (kl === "a") { stop(); this.selectAll(); return; }
      if (k === "0") { stop(); this.fit(); return; }
      if (k === "Enter") { stop(); this.opts.onSubmit?.(); return; }
      if (kl === "c" || kl === "x" || kl === "v") { e.stopPropagation(); return; } // native copy/cut/paste events
      return;
    }
    if (k === " ") { this.spaceDown = true; this.svg.classList.add("ce-panning"); stop(); return; }
    if (k === "Escape") {
      if (this.handleEscape()) { stop(); return; }
      if (this.tool.k !== "select") { stop(); this.setTool({ k: "select" }); }
      return;
    }
    if (k === "Delete" || k === "Backspace") {
      stop();
      if (this.sel.size) this.deleteSelection();
      else if (this.hover) this.mutate(() => this.eraseHit(this.hover!));
      return;
    }
    if (k.startsWith("Arrow") && this.sel.size) {
      stop();
      const s = e.shiftKey ? 0.5 : 0.05;
      const dx = k === "ArrowLeft" ? -s : k === "ArrowRight" ? s : 0, dy = k === "ArrowUp" ? -s : k === "ArrowDown" ? s : 0;
      this.mutate(() => translateDoc(this.doc, dx, dy, this.selAllIds()));
      return;
    }
    if (k === "?") { stop(); this.showHelp(null); return; }
    const h = this.hover;
    const lower = k.toLowerCase();
    if (h?.t === "atom") {
      const atom = getAtom(this.doc, h.id);
      if (!atom) return;
      if (ELEMENT_KEYS[lower] && !e.altKey) {
        stop();
        let el = ELEMENT_KEYS[lower];
        if (e.shiftKey && lower === "c") el = "Cl";
        if (e.shiftKey && lower === "b") el = "Br";
        this.mutate(() => { atom.el = el; delete atom.label; delete atom.expand; delete atom.hCount; });
        return;
      }
      if (k === "+" || k === "=") { stop(); this.mutate(() => { atom.charge += 1; }); return; }
      if (k === "-" || k === "_") { stop(); this.mutate(() => { atom.charge -= 1; }); return; }
      if (k === "1" || k === "2" || k === "3") {
        stop();
        let created: number | null = null;
        this.mutate(() => { created = this.growFrom(atom.id, k === "1" ? "single" : k === "2" ? "double" : "triple"); });
        if (created !== null) { this.hover = { t: "atom", id: created }; this.renderOverlay(); }
        return;
      }
      if (/^[4-8]$/.test(k) || lower === "a") {
        stop();
        const pl = this.ringPlacement(lower === "a" ? 6 : +k, h, { x: atom.x, y: atom.y });
        if (pl) this.mutate(() => this.commitRing(pl, lower === "a"));
        return;
      }
      if (lower === "x" || lower === "q") { stop(); this.showLabelPop(null, atom.id); return; }
    }
    if (h?.t === "bond") {
      const b = this.doc.bonds.find((x) => x.id === h.id);
      if (!b) return;
      const set = (fn: () => void) => { stop(); this.mutate(fn); };
      if (k === "1") return set(() => { b.order = 1; b.stereo = 0; });
      if (k === "2") return set(() => { b.order = 2; b.stereo = 0; });
      if (k === "3") return set(() => { b.order = 3; b.stereo = 0; });
      if (lower === "w") return set(() => { if (b.stereo === 1) { const t = b.a; b.a = b.b; b.b = t; } b.order = 1; b.stereo = 1; });
      if (lower === "h") return set(() => { if (b.stereo === 6) { const t = b.a; b.a = b.b; b.b = t; } b.order = 1; b.stereo = 6; });
      if (lower === "y") return set(() => { b.order = 1; b.stereo = 4; });
      if (lower === "f") return set(() => { if (b.stereo) { const t = b.a; b.a = b.b; b.b = t; } else if (b.order === 2) b.dbl = b.dbl === 1 ? -1 : b.dbl === -1 ? 2 : 1; });
      if (/^[4-8]$/.test(k) || lower === "a") {
        stop();
        const pl = this.ringPlacement(lower === "a" ? 6 : +k, h, this.pointer);
        if (pl) this.mutate(() => this.commitRing(pl, lower === "a"));
        return;
      }
    }
    if (h?.t === "arrow" && /^[1-5]$/.test(k)) {
      const kinds: ArrowKind[] = ["forward", "equilibrium", "retro", "resonance", "dashed"];
      stop();
      this.mutate(() => { const r = this.doc.arrows.find((x) => x.id === h.id); if (r) r.kind = kinds[+k - 1]; });
      return;
    }
    // tool shortcuts (no hover target)
    const toolKeys: Record<string, Tool> = {
      v: { k: "select" }, e: { k: "erase" }, "1": { k: "bond", t: "single" }, "2": { k: "bond", t: "double" }, "3": { k: "bond", t: "triple" },
      w: { k: "bond", t: "wedge" }, h: { k: "bond", t: "hash" }, c: { k: "chain" }, t: { k: "text" }, a: { k: "ring", n: 6, arom: true },
      "4": { k: "ring", n: 4, arom: false }, "5": { k: "ring", n: 5, arom: false }, "6": { k: "ring", n: 6, arom: false },
      "7": { k: "ring", n: 7, arom: false }, "8": { k: "ring", n: 8, arom: false }, "+": { k: "charge", d: 1 }, "-": { k: "charge", d: -1 },
      r: { k: "arrow", kind: "forward" },
    };
    const tk = toolKeys[lower];
    if (tk) { stop(); this.setTool(tk); }
  }

  private selectAll() {
    this.sel = new Set([...this.doc.atoms, ...this.doc.bonds, ...this.doc.arrows, ...this.doc.pluses, ...this.doc.texts].map((o) => o.id));
    this.setTool({ k: "select" });
  }

  // ------------------------------------------------------------------ clipboard
  private selectionDoc(): ChemDoc | null {
    if (!this.sel.size) return null;
    const ids = this.selAllIds();
    const d = emptyDoc();
    const sub: ChemDoc = {
      atoms: this.doc.atoms.filter((a) => ids.has(a.id)),
      bonds: this.doc.bonds.filter((b) => ids.has(b.a) && ids.has(b.b)),
      arrows: this.doc.arrows.filter((r) => ids.has(r.id)),
      pluses: this.doc.pluses.filter((p) => ids.has(p.id)),
      texts: this.doc.texts.filter((t) => ids.has(t.id)),
      nextId: 0,
    };
    mergeInto(d, sub);
    return d;
  }
  private onCopy(e: ClipboardEvent, cut: boolean) {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    e.preventDefault();
    const d = this.selectionDoc() ?? this.doc;
    const smiles = docToSmiles(d);
    this.clip = { native: JSON.stringify(d), smiles };
    e.clipboardData?.setData("text/plain", smiles);
    this.toast(cut ? "Cut" : "Copied (SMILES on clipboard)");
    if (cut && this.sel.size) this.deleteSelection();
  }
  private onPaste(e: ClipboardEvent) {
    if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    e.preventDefault();
    let d: ChemDoc | null = null;
    if (this.clip && text.trim() === this.clip.smiles) d = JSON.parse(this.clip.native);
    else {
      try { d = parseAny(text); } catch (err: any) { this.toast("Clipboard is not a structure"); return; }
    }
    if (d) this.insertDoc(d, this.clip && text.trim() === this.clip.smiles ? 0.6 : null);
  }

  /** Add a document to the canvas; offset: shift from original position, or null = place to the right/at pointer. */
  insertDoc(src: ChemDoc, offset: number | null = null) {
    this.mutate(() => {
      const bbS = docBBox(src);
      let dx: number, dy: number;
      if (offset !== null) { dx = offset; dy = offset; }
      else if (isEmpty(this.doc)) { dx = -(bbS.minX + bbS.maxX) / 2; dy = -(bbS.minY + bbS.maxY) / 2; }
      else { const bb = docBBox(this.doc); dx = bb.maxX + 2 - bbS.minX; dy = (bb.minY + bb.maxY) / 2 - (bbS.minY + bbS.maxY) / 2; }
      const map = mergeInto(this.doc, src);
      const ids = new Set(map.values());
      translateDoc(this.doc, dx, dy, ids);
      this.sel = ids;
    });
    requestAnimationFrame(() => this.fit());
  }

  private async importText(text: string) {
    const t = text.trim();
    if (!t) return;
    let d: ChemDoc | null = null;
    try { d = parseAny(t); if (!d.atoms.length) d = null; } catch { d = null; }
    if (!d && this.opts.resolveName) {
      this.toast("Looking up name…");
      try {
        const smi = await this.opts.resolveName(t);
        if (smi) d = parseAny(smi);
      } catch { /* */ }
    }
    if (!d) { this.toast("Could not interpret input"); return; }
    this.insertDoc(d);
    this.importInput.value = "";
    this.focus();
  }

  private async copyText(text: string, msg: string) {
    try { await navigator.clipboard.writeText(text); this.toast(msg); }
    catch { this.toast("Clipboard unavailable"); }
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add("ce-show");
    window.setTimeout(() => this.toastEl.classList.remove("ce-show"), 1600);
  }

  // ------------------------------------------------------------------ editing ops
  private selAtomIds(): Set<number> {
    const s = new Set<number>();
    for (const id of this.sel) {
      if (this.graph().atomById.has(id)) s.add(id);
      const b = this.doc.bonds.find((x) => x.id === id);
      if (b) { s.add(b.a); s.add(b.b); }
    }
    return s;
  }
  private selAllIds(): Set<number> {
    const s = this.selAtomIds();
    for (const id of this.sel) if (this.doc.arrows.some((r) => r.id === id) || this.doc.pluses.some((p) => p.id === id) || this.doc.texts.some((t) => t.id === id)) s.add(id);
    return s;
  }
  private selBBox() {
    const ids = this.selAllIds();
    if (!ids.size) return null;
    return docBBox(this.doc, ids);
  }

  private deleteSelection() {
    this.mutate(() => {
      for (const id of this.sel) {
        if (this.graph().atomById.has(id)) removeAtom(this.doc, id);
        else {
          removeBond(this.doc, id);
          this.doc.arrows = this.doc.arrows.filter((r) => r.id !== id);
          this.doc.pluses = this.doc.pluses.filter((p) => p.id !== id);
          this.doc.texts = this.doc.texts.filter((t) => t.id !== id);
        }
        this.g = null;
      }
      this.sel.clear();
    });
  }

  private eraseHit(h: NonNullable<Hit>) {
    if (h.t === "atom") removeAtom(this.doc, h.id);
    else if (h.t === "bond") {
      const b = this.doc.bonds.find((x) => x.id === h.id);
      removeBond(this.doc, h.id);
      if (b) {
        this.g = null;
        const g = this.graph();
        for (const id of [b.a, b.b]) {
          const a = g.atomById.get(id);
          if (a && a.el === "C" && !a.label && !a.charge && g.adj.get(id)!.length === 0) removeAtom(this.doc, id);
        }
      }
    } else if (h.t === "arrow") this.doc.arrows = this.doc.arrows.filter((r) => r.id !== h.id);
    else if (h.t === "plus") this.doc.pluses = this.doc.pluses.filter((p) => p.id !== h.id);
    else if (h.t === "text") this.doc.texts = this.doc.texts.filter((t) => t.id !== h.id);
    this.sel.delete(h.id);
    this.g = null;
    if (this.hover?.id === h.id) this.hover = null;
  }

  private makeBond(a: number, b: number, t: BondType) {
    const order = t === "double" ? 2 : t === "triple" ? 3 : 1;
    const stereo: BondStereo = t === "wedge" ? 1 : t === "hash" ? 6 : t === "wavy" ? 4 : 0;
    addBond(this.doc, a, b, order, stereo);
  }

  /** Add a new bond from atom in the best free direction; returns new atom id. */
  private growFrom(atomId: number, t: BondType): number | null {
    const g = this.graph();
    const a = g.atomById.get(atomId);
    if (!a) return null;
    const dir = freeDirection(this.doc, g, atomId);
    let p = { x: a.x + dir.x, y: a.y + dir.y };
    // reuse an existing atom sitting exactly there
    const near = this.doc.atoms.find((x) => x.id !== atomId && Math.hypot(x.x - p.x, x.y - p.y) < 0.2);
    let id: number;
    if (near) id = near.id;
    else { id = addAtom(this.doc, "C", p.x, p.y).id; }
    if (findBond(this.doc, atomId, id)) return id;
    this.makeBond(atomId, id, t);
    this.g = null;
    return id;
  }

  private clickBond(id: number, t: BondType) {
    this.mutate(() => { const b = this.doc.bonds.find((x) => x.id === id); if (b) this.clickBondInPlace(b, t); });
  }

  private clickBondInPlace(b: Bond, t: BondType) {
    const flip = () => { const x = b.a; b.a = b.b; b.b = x; };
    switch (t) {
      case "single":
        if (b.stereo) { b.stereo = 0; b.order = 1; }
        else b.order = b.order === 1 ? 2 : b.order === 2 ? 3 : 1;
        break;
      case "double":
        if (b.order === 2 && !b.stereo) {
          const cyc: Array<Bond["dbl"]> = [undefined, 2, 1, -1];
          b.dbl = cyc[(cyc.indexOf(b.dbl === 0 ? undefined : b.dbl) + 1) % cyc.length];
          if (b.dbl === undefined) delete b.dbl;
        } else { b.order = 2; b.stereo = 0; }
        break;
      case "triple": b.order = 3; b.stereo = 0; break;
      case "wedge": if (b.stereo === 1) flip(); else { b.order = 1; b.stereo = 1; } break;
      case "hash": if (b.stereo === 6) flip(); else { b.order = 1; b.stereo = 6; } break;
      case "wavy": b.order = 1; b.stereo = b.stereo === 4 ? 0 : 4; break;
    }
  }

  private applyAtomTool(a: Atom) {
    const t = this.tool;
    if (t.k !== "atom") return;
    if (t.label) { a.el = "*"; a.label = t.label; if (t.expand) a.expand = t.expand; else delete a.expand; delete a.hCount; return; }
    if (a.el === t.el && !a.label && t.el !== "C") { /* clicking same element toggles to carbon? keep */ }
    a.el = t.el; delete a.label; delete a.expand; delete a.hCount;
  }

  private bondEnd(from: P, cur: P, fromAtom: number | null): { p: P; atom: number | null } {
    const h = this.hitTest(cur, { exclude: fromAtom !== null ? new Set([fromAtom]) : undefined });
    if (h?.t === "atom") { const a = this.graph().atomById.get(h.id)!; return { p: a, atom: a.id }; }
    let ang = Math.atan2(cur.y - from.y, cur.x - from.x);
    ang = Math.round(ang / (15 * DEG)) * 15 * DEG;
    return { p: { x: from.x + Math.cos(ang), y: from.y + Math.sin(ang) }, atom: null };
  }

  private arrowEnd(start: P, cur: P, snap = true): P {
    let ang = Math.atan2(cur.y - start.y, cur.x - start.x);
    if (snap) ang = Math.round(ang / (15 * DEG)) * 15 * DEG;
    const L = Math.max(0.8, Math.hypot(cur.x - start.x, cur.y - start.y));
    return { x: start.x + Math.cos(ang) * L, y: start.y + Math.sin(ang) * L };
  }

  private chainPoints(d: { atom: number | null; p: P; cur: P }): P[] {
    const g = this.graph();
    const start = d.atom !== null ? g.atomById.get(d.atom)! : d.p;
    const dx = d.cur.x - start.x, dy = d.cur.y - start.y;
    const dist = Math.hypot(dx, dy);
    const n = Math.max(1, Math.round(dist / Math.cos(30 * DEG)));
    let th = Math.atan2(dy, dx);
    th = Math.round(th / (15 * DEG)) * 15 * DEG;
    let s = -1;
    if (d.atom !== null) {
      const nbAng = g.adj.get(d.atom)!.map(({ nb }) => { const q = g.atomById.get(nb)!; return Math.atan2(q.y - start.y, q.x - start.x); });
      const score = (sg: number) => Math.min(...nbAng.map((a) => Math.abs(Math.atan2(Math.sin(th + sg * 30 * DEG - a), Math.cos(th + sg * 30 * DEG - a)))), 10);
      if (nbAng.length) s = score(-1) >= score(1) ? -1 : 1;
    }
    const pts: P[] = [{ x: start.x, y: start.y }];
    for (let i = 1; i <= n; i++) {
      const a = th + (i % 2 === 1 ? s : -s) * 30 * DEG;
      const prev = pts[i - 1];
      pts.push({ x: prev.x + Math.cos(a), y: prev.y + Math.sin(a) });
    }
    return pts;
  }

  /** Geometry of a ring to place on an atom, a bond or empty space. */
  private ringPlacement(n: number, hit: Hit, p: P): { pts: P[]; existing: Array<number | null> } | null {
    const g = this.graph();
    const R = polyRadius(n);
    if (hit?.t === "atom") {
      const a = g.atomById.get(hit.id)!;
      const dir = freeDirection(this.doc, g, a.id);
      const c = { x: a.x + dir.x * R, y: a.y + dir.y * R };
      const a0 = Math.atan2(a.y - c.y, a.x - c.x);
      const pts = Array.from({ length: n }, (_, k) => ({ x: c.x + R * Math.cos(a0 + (2 * Math.PI * k) / n), y: c.y + R * Math.sin(a0 + (2 * Math.PI * k) / n) }));
      return { pts, existing: pts.map((_, k) => (k === 0 ? a.id : null)) };
    }
    if (hit?.t === "bond") {
      const b = this.doc.bonds.find((x) => x.id === hit.id)!;
      const A = g.atomById.get(b.a)!, B = g.atomById.get(b.b)!;
      const M = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      const L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
      let nx = -(B.y - A.y) / L, ny = (B.x - A.x) / L;
      // side: fewer neighbouring atoms; tie -> pointer side
      let s1 = 0, s2 = 0;
      for (const at of this.doc.atoms) {
        if (at.id === A.id || at.id === B.id) continue;
        const dd = Math.hypot(at.x - M.x, at.y - M.y);
        if (dd > 2.2) continue;
        const side = (at.x - M.x) * nx + (at.y - M.y) * ny;
        if (side > 0.05) s1++; else if (side < -0.05) s2++;
      }
      const ps = (p.x - M.x) * nx + (p.y - M.y) * ny;
      let sign = s1 < s2 ? 1 : s2 < s1 ? -1 : ps >= 0 ? 1 : -1;
      nx *= sign; ny *= sign;
      const ap = 1 / (2 * Math.tan(Math.PI / n));
      const c = { x: M.x + nx * ap * L, y: M.y + ny * ap * L };
      const aA = Math.atan2(A.y - c.y, A.x - c.x), aB = Math.atan2(B.y - c.y, B.x - c.x);
      const step = Math.atan2(Math.sin(aB - aA), Math.cos(aB - aA));
      const r = R * L;
      const pts = Array.from({ length: n }, (_, k) => ({ x: c.x + r * Math.cos(aA + step * k), y: c.y + r * Math.sin(aA + step * k) }));
      return { pts, existing: pts.map((_, k) => (k === 0 ? A.id : k === 1 ? B.id : null)) };
    }
    if (hit) return null;
    const off = n === 4 || n === 8 ? -90 + 180 / n : -90;
    const pts = Array.from({ length: n }, (_, k) => ({ x: p.x + R * Math.cos((off + (360 * k) / n) * DEG), y: p.y + R * Math.sin((off + (360 * k) / n) * DEG) }));
    return { pts, existing: pts.map(() => null) };
  }

  private commitRing(pl: { pts: P[]; existing: Array<number | null> }, arom: boolean) {
    const n = pl.pts.length;
    const ids: number[] = [];
    pl.pts.forEach((p, k) => {
      let id = pl.existing[k];
      if (id === null) {
        const near = this.doc.atoms.find((a) => Math.hypot(a.x - p.x, a.y - p.y) < 0.2);
        id = near ? near.id : addAtom(this.doc, "C", p.x, p.y).id;
      }
      ids.push(id);
    });
    const ringBonds: Bond[] = [];
    for (let k = 0; k < n; k++) {
      const a = ids[k], b = ids[(k + 1) % n];
      const b0 = findBond(this.doc, a, b) ?? addBond(this.doc, a, b, 1)!;
      ringBonds.push(b0);
    }
    this.g = null;
    if (!arom) return;
    const g = this.graph();
    const hasDouble = (id: number, except: Set<number>) => g.adj.get(id)!.some(({ bond }) => bond.order >= 2 && !except.has(bond.id));
    const ringIds = new Set(ringBonds.map((b) => b.id));
    let best: Bond[] = [];
    for (const start of [0, 1]) {
      const pick: Bond[] = [];
      const used = new Set<number>();
      for (let k = 0; k < n; k++) {
        const b = ringBonds[(start + k) % n];
        if ((k % 2) !== 0) continue;
        if (b.order >= 2) { used.add(b.a); used.add(b.b); pick.push(b); continue; }
        if (used.has(b.a) || used.has(b.b) || hasDouble(b.a, ringIds) || hasDouble(b.b, ringIds)) continue;
        // also respect existing ring doubles adjacent
        if (ringBonds.some((o) => o !== b && o.order >= 2 && (o.a === b.a || o.b === b.a || o.a === b.b || o.b === b.b))) continue;
        used.add(b.a); used.add(b.b);
        pick.push(b);
      }
      if (pick.length > best.length) best = pick;
    }
    for (const b of best) b.order = 2;
  }

  private mergeNew(ids: number[]) {
    this.g = null;
    for (const id of ids) {
      const a = getAtom(this.doc, id);
      if (!a) continue;
      const other = this.doc.atoms.find((x) => x.id !== id && !ids.includes(x.id) && Math.hypot(x.x - a.x, x.y - a.y) < 0.2);
      if (other) this.mergeAtoms(other.id, id);
    }
  }

  private mergeMoved(moved: Set<number>) {
    this.g = null;
    for (const id of [...moved]) {
      const a = getAtom(this.doc, id);
      if (!a) continue;
      const other = this.doc.atoms.find((x) => !moved.has(x.id) && Math.hypot(x.x - a.x, x.y - a.y) < 0.22);
      if (other) { this.mergeAtoms(other.id, id); moved.delete(id); }
    }
  }

  private mergeAtoms(keep: number, remove: number) {
    for (const b of this.doc.bonds) {
      if (b.a === remove) b.a = keep;
      if (b.b === remove) b.b = keep;
    }
    const seen = new Set<string>();
    this.doc.bonds = this.doc.bonds.filter((b) => {
      if (b.a === b.b) return false;
      const k = b.a < b.b ? `${b.a}-${b.b}` : `${b.b}-${b.a}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const ra = getAtom(this.doc, remove), ka = getAtom(this.doc, keep);
    if (ra && ka && ka.el === "C" && !ka.label && (ra.el !== "C" || ra.label)) { ka.el = ra.el; if (ra.label) { ka.label = ra.label; ka.expand = ra.expand; } }
    removeAtom(this.doc, remove);
    this.sel.delete(remove);
    this.g = null;
  }

  private clean() {
    if (!this.doc.atoms.length) return;
    const ids = this.selAtomIds();
    this.mutate(() => cleanComponents(this.doc, ids.size ? ids : null));
    if (!ids.size) requestAnimationFrame(() => this.fit());
  }

  private flip(horizontal: boolean) {
    const ids = this.sel.size ? this.selAllIds() : null;
    const bb = docBBox(this.doc, ids ?? undefined);
    const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    this.mutate(() => {
      const fx = (x: number) => (horizontal ? 2 * cx - x : x), fy = (y: number) => (horizontal ? y : 2 * cy - y);
      for (const a of this.doc.atoms) if (!ids || ids.has(a.id)) { a.x = fx(a.x); a.y = fy(a.y); }
      for (const r of this.doc.arrows) if (!ids || ids.has(r.id)) { r.x1 = fx(r.x1); r.y1 = fy(r.y1); r.x2 = fx(r.x2); r.y2 = fy(r.y2); }
      for (const p of this.doc.pluses) if (!ids || ids.has(p.id)) { p.x = fx(p.x); p.y = fy(p.y); }
      for (const t of this.doc.texts) if (!ids || ids.has(t.id)) { t.x = fx(t.x); t.y = fy(t.y); }
    });
  }

  // ------------------------------------------------------------------ popovers
  private closePop() { this.pop?.remove(); this.pop = null; }

  private openPop(anchor: HTMLElement | null, build: (p: HTMLDivElement) => void, at?: P) {
    this.closePop();
    const p = this.el("div", "ce-pop", this.root);
    build(p);
    this.pop = p;
    const rr = this.root.getBoundingClientRect();
    let x = 60, y = 60;
    if (anchor) {
      const ar = anchor.getBoundingClientRect();
      x = ar.left - rr.left; y = ar.bottom - rr.top + 4;
    } else if (at) { x = at.x; y = at.y; }
    // keep inside
    requestAnimationFrame(() => {
      const pw = p.offsetWidth, ph = p.offsetHeight;
      x = Math.max(4, Math.min(x, rr.width - pw - 4));
      y = Math.max(4, Math.min(y, rr.height - ph - 4));
      p.style.left = x + "px"; p.style.top = y + "px";
    });
    p.style.left = x + "px"; p.style.top = y + "px";
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
  }

  private showPeriodicTable(anchor: HTMLElement | null, atomId?: number, at?: P) {
    let pos: P | undefined;
    if (at) { const rr = this.root.getBoundingClientRect(); pos = { x: at.x - rr.left, y: at.y - rr.top }; }
    this.openPop(anchor, (p) => {
      const grid = this.el("div", "ce-ptable", p);
      for (const [sym, r, c] of periodicLayout()) {
        const b = this.el("button", "", grid);
        b.textContent = sym;
        b.style.gridRow = String(r);
        b.style.gridColumn = String(c);
        b.addEventListener("click", () => {
          if (atomId !== undefined) this.mutate(() => { const a = getAtom(this.doc, atomId); if (a) { a.el = sym; delete a.label; delete a.expand; delete a.hCount; } });
          else this.setTool({ k: "atom", el: sym });
          this.closePop(); this.focus();
        });
      }
    }, pos);
  }

  private showLabelPop(anchor: HTMLElement | null, atomId?: number) {
    let at: P | undefined;
    if (atomId !== undefined) {
      const a = getAtom(this.doc, atomId);
      if (a) { const s = this.toScreen(a); const wr = this.wrap.getBoundingClientRect(), rr = this.root.getBoundingClientRect(); at = { x: s.x + wr.left - rr.left + 10, y: s.y + wr.top - rr.top + 10 }; }
    }
    this.openPop(anchor, (p) => {
      p.classList.add("ce-label-pop");
      const inp = this.el("input", "", p);
      inp.placeholder = "Element or label (OMe, Boc, Ph…)";
      const a = atomId !== undefined ? getAtom(this.doc, atomId) : undefined;
      if (a) inp.value = a.label ?? a.el;
      const chips = this.el("div", "ce-chips", p);
      const apply = (txt: string) => {
        const v = txt.trim();
        if (!v) return;
        const tool = interpretLabel(v);
        if (atomId !== undefined) {
          this.mutate(() => {
            const at2 = getAtom(this.doc, atomId);
            if (!at2) return;
            if (tool.label) { at2.el = "*"; at2.label = tool.label; if (tool.expand) at2.expand = tool.expand; else delete at2.expand; }
            else { at2.el = tool.el; delete at2.label; delete at2.expand; }
            delete at2.hCount;
          });
        } else this.setTool(tool);
        this.closePop();
        this.focus();
      };
      for (const q of QUICK_LABELS) {
        const b = this.el("button", "", chips);
        b.textContent = q;
        b.addEventListener("click", () => apply(q));
      }
      inp.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") apply(inp.value);
        if (e.key === "Escape") { this.closePop(); this.focus(); }
      });
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    }, at);
  }

  private showHelp(e: MouseEvent | null) {
    this.openPop(e ? (e.currentTarget as HTMLElement) : null, (p) => {
      p.classList.add("ce-help");
      p.innerHTML = `
<h4>Menus</h4>
<b>Right-click</b> (long-press on touch) an atom, bond, arrow, text, a selection or empty canvas for context options: element, charge, hydrogens, isotope, bond type, double-bond position, fuse ring, abbreviate/expand, rotate, copy as…
<h4>Drawing</h4>
Click empty canvas: new bond · Click atom: grow bond · Drag from atom: bond in chosen direction (15° snap) · Click bond: cycle order / flip wedge · Drag onto an atom to connect.
<h4>Hover an atom and press</h4>
<kbd>C</kbd> <kbd>N</kbd> <kbd>O</kbd> <kbd>S</kbd> <kbd>P</kbd> <kbd>F</kbd> <kbd>H</kbd> <kbd>I</kbd> <kbd>L</kbd>=Cl <kbd>B</kbd>=Br element ·
<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> add bond (hotspot moves on) · <kbd>+</kbd>/<kbd>−</kbd> charge · <kbd>4</kbd>–<kbd>8</kbd> / <kbd>A</kbd> attach ring · <kbd>X</kbd> label · <kbd>Del</kbd> delete
<h4>Hover a bond and press</h4>
<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> order · <kbd>W</kbd> wedge · <kbd>H</kbd> hash · <kbd>Y</kbd> wavy · <kbd>F</kbd> flip · <kbd>4</kbd>–<kbd>8</kbd>/<kbd>A</kbd> fuse ring
<h4>Tools (nothing hovered)</h4>
<kbd>V</kbd>/<kbd>Esc</kbd> select · <kbd>E</kbd> erase · <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> bonds · <kbd>W</kbd>/<kbd>H</kbd> wedge/hash · <kbd>C</kbd> chain · <kbd>4</kbd>–<kbd>8</kbd> rings · <kbd>A</kbd> benzene · <kbd>R</kbd> arrow · <kbd>T</kbd> text · <kbd>+</kbd>/<kbd>−</kbd> charges
<h4>General</h4>
<kbd>Ctrl</kbd>+<kbd>Z</kbd>/<kbd>Shift</kbd>+<kbd>Z</kbd> undo/redo · <kbd>Ctrl</kbd>+<kbd>A</kbd> select all · <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>X</kbd>/<kbd>V</kbd> copy/cut/paste (SMILES or Molfile text pastes as a structure) · arrows nudge selection ·
wheel / pinch zoom · two-finger, middle or right drag, or <kbd>Space</kbd>+drag to pan · <kbd>Ctrl</kbd>+<kbd>0</kbd> fit · drag the round handle to rotate a selection · double-click an atom to relabel.`;
    });
  }

  private editText(id: number | null, at?: P) {
    const t = id !== null ? this.doc.texts.find((x) => x.id === id) : null;
    const pos = t ? { x: t.x, y: t.y } : at!;
    const s = this.toScreen(pos);
    const ta = this.el("textarea", "ce-textedit", this.wrap);
    ta.value = t?.text ?? "";
    ta.rows = Math.max(1, ta.value.split("\n").length);
    ta.style.left = Math.max(0, s.x - 60) + "px";
    ta.style.top = Math.max(0, s.y - 12) + "px";
    ta.style.width = "140px";
    this.textEditor = ta;
    let done = false;
    const commit = (save: boolean) => {
      if (done) return;
      done = true;
      const v = ta.value.trim();
      ta.remove();
      this.textEditor = null;
      if (!save) { this.focus(); return; }
      this.mutate(() => {
        if (t) { if (v) t.text = v; else this.doc.texts = this.doc.texts.filter((x) => x !== t); }
        else if (v) this.doc.texts.push({ id: newId(this.doc), x: pos.x, y: pos.y, text: v });
      });
      this.focus();
    };
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(true); }
      if (e.key === "Escape") { e.preventDefault(); commit(false); }
      ta.rows = Math.max(1, ta.value.split("\n").length);
    });
    ta.addEventListener("blur", () => commit(true));
    ta.focus();
  }
}

// ------------------------------------------------------------------ helpers
function segDist(p: P, a: P, b: P) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy || 1;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function rotateDoc(d: ChemDoc, c: P, ang: number, ids: Set<number>) {
  const cs = Math.cos(ang), sn = Math.sin(ang);
  const r = (x: number, y: number) => ({ x: c.x + (x - c.x) * cs - (y - c.y) * sn, y: c.y + (x - c.x) * sn + (y - c.y) * cs });
  for (const a of d.atoms) if (ids.has(a.id)) { const q = r(a.x, a.y); a.x = q.x; a.y = q.y; }
  for (const ar of d.arrows) if (ids.has(ar.id)) { const p1 = r(ar.x1, ar.y1), p2 = r(ar.x2, ar.y2); ar.x1 = p1.x; ar.y1 = p1.y; ar.x2 = p2.x; ar.y2 = p2.y; }
  for (const p of d.pluses) if (ids.has(p.id)) { const q = r(p.x, p.y); p.x = q.x; p.y = q.y; }
  for (const t of d.texts) if (ids.has(t.id)) { const q = r(t.x, t.y); t.x = q.x; t.y = q.y; }
}

function interpretLabel(v: string): Extract<Tool, { k: "atom" }> {
  const cap = v.length <= 2 ? v[0].toUpperCase() + v.slice(1).toLowerCase() : v;
  if (isElement(v)) return { k: "atom", el: v };
  if (v.length <= 2 && isElement(cap) && !lookupAbbreviation(v)) return { k: "atom", el: cap };
  const ex = lookupAbbreviation(v);
  if (ex) {
    const key = Object.keys(ABBREVIATIONS).find((k) => k.toLowerCase() === v.toLowerCase()) ?? v;
    return { k: "atom", el: "*", label: key, expand: ex };
  }
  return { k: "atom", el: "*", label: v };
}

export { components };
