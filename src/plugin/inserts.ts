// "Insert ChemEdit block…" picker — one place to discover every embeddable block.

import { App, Editor, FuzzySuggestModal } from "obsidian";
import type ChemEditPlugin from "./main";
import { nmrBlock } from "./nmrview";
import { SYNTH_PLAN_EXAMPLE } from "./synthplan";

interface BlockItem { name: string; desc: string; make: (p: ChemEditPlugin) => string | Promise<string | null> }

export const BLOCK_ITEMS: BlockItem[] = [
  { name: "Predicted NMR (¹H / ¹³C)", desc: "chem-nmr — spectrum, peak table and ACS text from a structure", make: (p) => new Promise((res) => p.openEditor(null, (r) => res(nmrBlock(r.smiles)), { title: "Structure for NMR prediction", saveLabel: "Predict" })) },
  { name: "Synthesis plan (mind map)", desc: "synthesis-plan — [[EXP-001]] -> [[EXP-002]], SMILES and labels", make: (p) => SYNTH_PLAN_EXAMPLE.replace("path: ELN", "path: " + p.settings.elnFolder) },
  { name: "Synthesis map (from experiments)", desc: "synthesis-map — automatic route map of the ELN", make: () => "```synthesis-map\nview: sequences\nheight: 520\n```\n" },
  { name: "Structure gallery of a folder", desc: "chem-gallery — every .mol/.sdf/.cdxml/… and smiles block in a folder", make: () => "```chem-gallery\npath: Chem\n```\n" },
  { name: "Experiment gallery", desc: "eln-gallery — experiment cards with scheme, status and yield", make: (p) => "```eln-gallery\npath: " + p.settings.elnFolder + "\n```\n" },
  { name: "Inventory table", desc: "chem-db type: inventory — stock, location, check-out, CSV import", make: (p) => "```chem-db\ntype: inventory\nfolder: " + (p.settings.labFolders?.inventory ?? "Inventory") + "\n```\n" },
  { name: "Compound library", desc: "chem-db type: compounds", make: (p) => "```chem-db\ntype: compounds\nfolder: " + (p.settings.labFolders?.compounds ?? "Library") + "\n```\n" },
  { name: "Orders", desc: "chem-db type: orders", make: (p) => "```chem-db\ntype: orders\nfolder: " + (p.settings.labFolders?.orders ?? "Orders") + "\n```\n" },
  { name: "Equipment & bookings", desc: "chem-db type: equipment", make: (p) => "```chem-db\ntype: equipment\nfolder: " + (p.settings.labFolders?.equipment ?? "Equipment") + "\n```\n" },
  { name: "Protocols / SOPs", desc: "chem-db type: protocols", make: (p) => "```chem-db\ntype: protocols\nfolder: " + (p.settings.labFolders?.protocols ?? "Protocols") + "\n```\n" },
  { name: "Experiments index (list)", desc: "eln-list — compact list of experiments", make: (p) => "```eln-list\nfolder: " + p.settings.elnFolder + "\n```\n" },
];

export class BlockPicker extends FuzzySuggestModal<BlockItem> {
  constructor(app: App, private plugin: ChemEditPlugin, private editor: Editor) { super(app); this.setPlaceholder("Insert a ChemEdit block…"); }
  getItems() { return BLOCK_ITEMS; }
  getItemText(i: BlockItem) { return i.name + " — " + i.desc; }
  onChooseItem(i: BlockItem) {
    void Promise.resolve(i.make(this.plugin)).then((t) => { if (t) this.editor.replaceSelection(t); });
  }
}
