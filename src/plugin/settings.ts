import { App, PluginSettingTab, Setting } from "obsidian";
import type ChemEditPlugin from "./main";

export type BlockFormat = "smiles" | "mol" | "chemedit" | "svg";

export interface ChemEditSettings {
  bondLength: number;
  colorAtoms: boolean;
  maxWidth: number;
  maxHeight: number;
  inlineHeight: number;
  inlineSmilesPrefix: string;
  newBlockFormat: BlockFormat;
  showFormula: boolean;
  svgFolder: string;
  svgInk: "black" | "currentColor";
  nameLookup: boolean;
  enableCanvasBridge: boolean;
  enableExcalidrawBridge: boolean;
  enableFileView: boolean;
  abbreviateInNotes: boolean;
  elnFolder: string;
  elnPrefix: string;
  elnSections: string;
  elnMediaFolder: string;
  photoMaxPx: number;
  elnTemplate: "classic" | "electro" | "legacy";
  userName: string;
  labFolders: Record<string, string>;
  charMetrics: string;
  pngScale: number;
  lastSystem?: { phase: string; a: string; b: string; ratio: string; additive: string };
}

export const DEFAULT_SETTINGS: ChemEditSettings = {
  bondLength: 22,
  colorAtoms: true,
  maxWidth: 640,
  maxHeight: 420,
  inlineHeight: 70,
  inlineSmilesPrefix: "$smiles=",
  newBlockFormat: "smiles",
  showFormula: false,
  svgFolder: "Assets/Chemistry",
  svgInk: "black",
  nameLookup: true,
  enableCanvasBridge: true,
  enableExcalidrawBridge: true,
  enableFileView: true,
  abbreviateInNotes: false,
  elnFolder: "ELN",
  elnPrefix: "EXP",
  elnSections: "1H NMR, 13C NMR, HRMS, IR",
  elnMediaFolder: "Assets/ELN",
  photoMaxPx: 1600,
  elnTemplate: "classic",
  userName: "",
  labFolders: {},
  charMetrics: "hnmr, cnmr, hrms, ir, mp",
  pngScale: 4,
};

export class ChemEditSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ChemEditPlugin) { super(app, plugin); }

  display(): void {
    const el = this.containerEl;
    el.empty();
    const s = this.plugin.settings;
    const save = async () => { await this.plugin.saveSettings(); this.plugin.refreshAll(); };
    const p = el.createEl("p", { cls: "setting-item-description" });
    p.setText("Draw with the hexagon ribbon icon or the 'Insert chemical structure' command. Double-click any rendered structure to edit it. Code blocks: smiles, mol, chemedit, eln, eln-list.");

    new Setting(el).setName("Insert new structures as").setDesc("SMILES is portable and readable; 'ChemEdit drawing' keeps your exact layout, arrows and text; SVG saves an image file with editable data inside.")
      .addDropdown((d) => d.addOptions({ smiles: "SMILES code block", chemedit: "ChemEdit drawing block (exact layout)", mol: "Molfile code block", svg: "SVG image file" }).setValue(s.newBlockFormat).onChange(async (v) => { s.newBlockFormat = v as BlockFormat; await save(); }));
    new Setting(el).setName("Bond length (px)").setDesc("Drawing scale in notes (ACS 1996 proportions).")
      .addSlider((sl) => sl.setLimits(12, 40, 1).setValue(s.bondLength).onChange(async (v) => { s.bondLength = v; await save(); }));
    new Setting(el).setName("Colour heteroatoms").addToggle((t) => t.setValue(s.colorAtoms).onChange(async (v) => { s.colorAtoms = v; await save(); }));
    new Setting(el).setName("Abbreviate common groups in notes").setDesc("Display OAc, CO₂Me, Boc, TBS, NO₂, CF₃… as labels (the stored structure is unchanged).")
      .addToggle((t) => t.setValue(s.abbreviateInNotes).onChange(async (v) => { s.abbreviateInNotes = v; await save(); }));
    new Setting(el).setName("Show formula & MW under structures").addToggle((t) => t.setValue(s.showFormula).onChange(async (v) => { s.showFormula = v; await save(); }));
    new Setting(el).setName("Maximum size (px)").setDesc("Width × height limit for rendered blocks.")
      .addText((t) => t.setValue(String(s.maxWidth)).onChange(async (v) => { s.maxWidth = parseInt(v) || 640; await save(); }))
      .addText((t) => t.setValue(String(s.maxHeight)).onChange(async (v) => { s.maxHeight = parseInt(v) || 420; await save(); }));
    new Setting(el).setName("Inline SMILES prefix").setDesc("Text like $smiles=CCO renders inline in reading view.")
      .addText((t) => t.setValue(s.inlineSmilesPrefix).onChange(async (v) => { s.inlineSmilesPrefix = v || "$smiles="; await save(); }))
      .addText((t) => t.setPlaceholder("height").setValue(String(s.inlineHeight)).onChange(async (v) => { s.inlineHeight = parseInt(v) || 70; await save(); }));
    new Setting(el).setName("SVG folder").setDesc("Where SVG structure files are created.")
      .addText((t) => t.setValue(s.svgFolder).onChange(async (v) => { s.svgFolder = v; await save(); }));
    new Setting(el).setName("SVG ink colour").setDesc("'black' for publication-style files; 'currentColor' follows the theme when embedded inline.")
      .addDropdown((d) => d.addOptions({ black: "Black", currentColor: "Theme (currentColor)" }).setValue(s.svgInk).onChange(async (v) => { s.svgInk = v as any; await save(); }));
    new Setting(el).setName("PNG export resolution").setDesc("Copy image / Save as PNG from the editor and spectra. 4× ≈ 300 dpi at journal size; 8× for posters.")
      .addDropdown((d) => d.addOptions({ "2": "2× (screen)", "4": "4× (≈300 dpi, default)", "6": "6× (≈450 dpi)", "8": "8× (≈600 dpi, posters)" }).setValue(String(s.pngScale ?? 4)).onChange(async (v) => { s.pngScale = +v; await save(); }));
    new Setting(el).setName("Online name lookup").setDesc("Resolve names (e.g. 'aspirin') via OPSIN / PubChem when typed into the editor's import box.")
      .addToggle((t) => t.setValue(s.nameLookup).onChange(async (v) => { s.nameLookup = v; await save(); }));
    new Setting(el).setName("ELN").setHeading();
    new Setting(el).setName("Experiments folder").addText((t) => t.setValue(s.elnFolder).onChange(async (v) => { s.elnFolder = v.replace(/\/$/, ""); await save(); }));
    new Setting(el).setName("Experiment code prefix").setDesc("New experiments are numbered EXP-001, EXP-002…").addText((t) => t.setValue(s.elnPrefix).onChange(async (v) => { s.elnPrefix = v || "EXP"; await save(); }));
    new Setting(el).setName("Characterization sections").setDesc("Used when the product has no structure yet.").addText((t) => t.setValue(s.elnSections).onChange(async (v) => { s.elnSections = v; await save(); }));
    new Setting(el).setName("Photo & TLC folder").setDesc("Where lab-book photos and annotated TLC images are saved.").addText((t) => t.setValue(s.elnMediaFolder).onChange(async (v) => { s.elnMediaFolder = v.replace(/\/$/, ""); await save(); }));
    new Setting(el).setName("Photo size (px)").setDesc("Photos are downscaled to this longest side (JPEG) to keep the vault small.").addText((t) => t.setValue(String(s.photoMaxPx)).onChange(async (v) => { s.photoMaxPx = parseInt(v) || 1600; await save(); }));
    new Setting(el).setName("New experiment template").setDesc("MBook lab-book layout (General Remarks → Conclusion), its electrochemistry variant, or the 1.x layout.")
      .addDropdown((d) => d.addOptions({ classic: "Lab book (MBook)", electro: "Lab book — electrochemistry", legacy: "Simple (1.x)" }).setValue(s.elnTemplate).onChange(async (v) => { s.elnTemplate = v as any; await save(); }));
    new Setting(el).setName("Lab workspace").setHeading();
    new Setting(el).setName("Your name").setDesc("Used for bookings, check-outs, order requests and protocol reviews.").addText((t) => t.setValue(s.userName).onChange(async (v) => { s.userName = v.trim(); await save(); }));
    for (const [id, label, def] of [["compounds", "Compounds folder", "Library"], ["inventory", "Inventory folder", "Inventory"], ["orders", "Orders folder", "Orders"], ["equipment", "Equipment folder", "Equipment"], ["protocols", "Protocols folder", "Protocols"], ["analytics", "Characterisation folder", "Characterization"]] as const)
      new Setting(el).setName(label).setDesc("Notes here (or with the matching tag) appear in the Lab workspace.").addText((t) => t.setPlaceholder(def).setValue(s.labFolders[id] ?? "").onChange(async (v) => { if (v.trim()) s.labFolders[id] = v.trim().replace(/\/$/, ""); else delete s.labFolders[id]; await save(); }));
    new Setting(el).setName("Tracked analyses").setDesc("Front-matter keys shown as columns on the Analytics page.").addText((t) => t.setValue(s.charMetrics).onChange(async (v) => { s.charMetrics = v; await save(); }));
    new Setting(el).setName("Integrations (restart Obsidian to apply)").setHeading();
    new Setting(el).setName("Canvas toolbar").addToggle((t) => t.setValue(s.enableCanvasBridge).onChange(async (v) => { s.enableCanvasBridge = v; await save(); }));
    new Setting(el).setName("Excalidraw toolbar").addToggle((t) => t.setValue(s.enableExcalidrawBridge).onChange(async (v) => { s.enableExcalidrawBridge = v; await save(); }));
    new Setting(el).setName("Open .mol / .chemedit files in the editor").addToggle((t) => t.setValue(s.enableFileView).onChange(async (v) => { s.enableFileView = v; await save(); }));
  }
}
