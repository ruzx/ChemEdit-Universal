// Lab pages embedded in notes:
//   ```chem-gallery   path: Chem/To_prepare        → structure gallery of a folder
//   ```eln-gallery    path: ELN/Project-X          → experiment cards (scheme, status, yield)
//   ```chem-db        type: inventory  folder: …   → inventory / compounds / orders / equipment / protocols table
// Options can go in the block body or on the fence line.

import { MarkdownPostProcessorContext, MarkdownRenderChild } from "obsidian";
import type ChemEditPlugin from "./main";
import { LabCore, PageId, MODULES } from "./lab";
import { blockOptions, cleanFolder } from "./blockopts";

const KEYS = ["path", "folder", "type", "view", "status", "filter", "search", "limit", "title", "kind"];
const TYPES: Record<string, PageId> = {
  inventory: "inventory", chemicals: "inventory", reagents: "inventory", compounds: "compounds", library: "compounds",
  orders: "orders", equipment: "equipment", instruments: "equipment", protocols: "protocols", sops: "protocols", sop: "protocols",
  analytics: "analytics", characterization: "analytics", characterisation: "analytics", experiments: "experiments", eln: "experiments", gallery: "gallery",
};

export class LabEmbedBlock extends MarkdownRenderChild {
  constructor(private plugin: ChemEditPlugin, el: HTMLElement, private src: string, private ctx: MarkdownPostProcessorContext, private kind: "chem-gallery" | "eln-gallery" | "chem-db") { super(el); }

  onload() {
    const { opts } = blockOptions(this.src, this.containerEl, this.ctx, KEYS);
    const folderRaw = opts.path ?? opts.folder;
    let page: PageId = this.kind === "chem-gallery" ? "gallery" : this.kind === "eln-gallery" ? "experiments" : "inventory";
    if (this.kind === "chem-db") {
      const t = (opts.type ?? "inventory").toLowerCase().trim();
      const p = TYPES[t];
      if (!p) {
        const e = this.containerEl.createDiv({ cls: "ce-nmr-err" });
        e.setText(`chem-db: unknown type “${t}”. Use one of: ${[...MODULES.map((m) => m.id), "experiments", "gallery"].join(", ")}.`);
        return;
      }
      page = p;
    }
    const view = (opts.view ?? "").toLowerCase();
    const core = new LabCore(this.plugin, {
      page,
      folder: folderRaw !== undefined ? cleanFolder(folderRaw) : undefined,
      mode: view === "table" || view === "list" ? "table" : view === "cards" || view === "grid" ? "cards" : this.kind === "chem-db" && page !== "gallery" && page !== "experiments" ? "table" : undefined,
      filter: opts.status ?? opts.filter ?? opts.kind,
      query: opts.search,
      limit: parseInt(opts.limit ?? "") || (page === "gallery" ? 36 : undefined),
      title: opts.title,
    });
    this.addChild(core);
    core.mount(this.containerEl.createDiv());
  }
}
