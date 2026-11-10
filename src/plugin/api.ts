// Public API (window.ChemEditAPI / plugin.api), backward compatible with the Ketcher-based ChemEdit.
import type ChemEditPlugin from "./main";
import * as chem from "../chem/index";
import { ChemDoc } from "../chem/model";

export type SaveCallback = (data: string, isFile: boolean, format?: string) => void | Promise<void>;

/** Ketcher-like headless shim so older modules calling setMolecule()/getSmiles() keep working. */
export class HeadlessShim {
  private doc: ChemDoc = chem.emptyDoc();
  constructor(private plugin: ChemEditPlugin) {}
  async setMolecule(data: string) { this.doc = chem.parseAny(data); }
  async getSmiles() { return chem.docToSmiles(this.doc); }
  async getMolfile() { return chem.docToMolfile(this.doc); }
  async getKet() { return chem.docToNative(this.doc); }
  async getRxn() { return chem.docToMolfile(this.doc); }
  async generateImage(_data?: string, _o?: unknown) { return this.plugin.svgFor(this.doc, { forFile: true }); }
  async layout() { chem.cleanComponents(this.doc, null); }
}

export interface ChemEditAPI {
  version: string;
  openEditor: (initialData: string, format: string, onSave: SaveCallback) => void;
  renderStructure: (data: string, width: number, height: number) => Promise<HTMLElement | null>;
  ketcher: {
    openEditor: (initialData: string, format: string, onSave: SaveCallback) => void;
    getHeadless: () => Promise<HeadlessShim>;
    convertFormat: (data: string, outputFormat: string) => Promise<string>;
  };
  data: {
    getProperties: (smilesOrMol: string) => { mw: number; formula: string; exactMass: number } | null;
    isSubstructureMatch: (targetSmiles: string, querySmarts: string) => boolean;
    molToSmiles: (mol: string) => string;
  };
  chem: typeof chem;
}

export function buildChemEditAPI(plugin: ChemEditPlugin): ChemEditAPI {
  const headless = new HeadlessShim(plugin);
  const convert = async (data: string, out: string): Promise<string> => {
    const doc = chem.parseAny(data);
    const f = out.toLowerCase();
    if (f === "svg") return plugin.svgFor(doc, { forFile: true, withMeta: true });
    if (f === "smiles" || f === "smi" || f === "smarts") return chem.docToSmiles(doc);
    if (f === "ket" || f === "chemedit" || f === "json") return chem.docToNative(doc);
    return chem.docToMolfile(doc);
  };
  const open = (data: string, format: string, onSave: SaveCallback) => plugin.openKetcherModal(data, format, onSave);
  return {
    version: plugin.manifest.version,
    openEditor: open,
    renderStructure: async (data, w, h) => plugin.renderMoleculeToPreview(data, "auto", false, w, h),
    ketcher: { openEditor: open, getHeadless: async () => headless, convertFormat: convert },
    data: {
      getProperties: (s) => {
        const p = chem.propertiesOf(s);
        return p ? { mw: p.mw, formula: p.formula, exactMass: p.exactMass } : null;
      },
      isSubstructureMatch: (t, q) => chem.isSubstructure(t, q),
      molToSmiles: (m) => { try { return chem.docToSmiles(chem.parseAny(m, "mol")); } catch { return ""; } },
    },
    chem,
  };
}
