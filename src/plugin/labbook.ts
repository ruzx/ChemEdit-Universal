// Lab-book helpers following the MBook template (Lundberg Lab, v1.0):
// General Remarks → Chemicals & Equipment → Experimental → Work-up/Purification → Analytical Data → Conclusion.
// Everything inserts plain Markdown into the right section of the experiment note, so it also works on mobile.

import { App, Modal, Notice, TFile, normalizePath } from "obsidian";
import type ChemEditPlugin from "./main";
import { ElnData, ElnCalc, CalcRow, fmtMass, fmtMmol, fmtVol, fmtEq } from "../chem/eln";
import { parseAny } from "../chem/index";

export type SectionKey = "remarks" | "equipment" | "experimental" | "workup" | "analytical" | "conclusion";
export const SECTIONS: Record<SectionKey, { title: string; re: RegExp }> = {
  remarks: { title: "General Remarks", re: /^(#{1,6})\s*(General Remarks|Aim)\b/i },
  equipment: { title: "Chemicals & Equipment", re: /^(#{1,6})\s*Chemicals\s*(&|and)\s*Equipment/i },
  experimental: { title: "Experimental", re: /^(#{1,6})\s*(Experimental|Procedure)\b/i },
  workup: { title: "Work-up/Purification", re: /^(#{1,6})\s*(Work-?up|Purification|TLC\s*\/\s*Work-up)/i },
  analytical: { title: "Analytical Data", re: /^(#{1,6})\s*(Analytical Data|Characteri[sz]ation)/i },
  conclusion: { title: "Conclusion", re: /^(#{1,6})\s*Conclusion/i },
};
const SECTION_LABEL: Record<SectionKey, string> = { remarks: "Remarks", equipment: "Equipment", experimental: "Experimental", workup: "Work-up", analytical: "Analytical", conclusion: "Conclusion" };

export interface ElnCtx { plugin: ChemEditPlugin; file: TFile; data: ElnData; calc: ElnCalc }

const m = () => (window as any).moment?.();
export const nowHM = () => m()?.format("HH:mm") ?? new Date().toTimeString().slice(0, 5);
export const dateStamp = () => m()?.format("DD.MM.YYYY (ddd)") ?? new Date().toLocaleDateString();
export const fileStamp = () => m()?.format("YYYYMMDD_HHmmss") ?? String(Date.now());

/** Insert text at the end of a section (creating it if missing). Numbered steps continue the section's numbering. */
export function insertInSection(text: string, key: SectionKey, opts: { numbered?: boolean; date?: boolean } = {}) {
  return (data: string): string => {
    const lines = data.split("\n");
    let start = lines.findIndex((l) => SECTIONS[key].re.test(l));
    if (start < 0) {
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push("", `## ${SECTIONS[key].title}`, "");
      start = lines.length - 2;
    }
    const level = (SECTIONS[key].re.exec(lines[start])?.[1] ?? "##").length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const h = /^(#{1,6})\s/.exec(lines[i]);
      if (h && h[1].length <= level) { end = i; break; }
    }
    // trim trailing blanks and empty placeholders ("1. ") inside the section
    let last = end - 1;
    while (last > start && (lines[last].trim() === "" || /^\d+\.\s*$/.test(lines[last].trim()))) last--;
    const body = lines.slice(start + 1, last + 1);
    const out: string[] = [];
    if (opts.date) {
      const dates = body.filter((l) => /^\*{0,2}\d{2}\.\d{2}\.\d{4}/.test(l.trim()));
      const today = dateStamp();
      if (!dates.length || !dates[dates.length - 1].includes(today.slice(0, 10))) out.push("", `**${today}**`, "");
    }
    let t = text;
    if (opts.numbered) {
      let n = 0;
      for (const l of body) { const mm = /^(\d+)\.\s/.exec(l); if (mm) n = Math.max(n, +mm[1]); }
      const [first, ...rest] = t.split("\n");
      t = [`${n + 1}. ${first}`, ...rest.map((r) => (r.trim() ? "   " + r : r))].join("\n");
    }
    out.push(...t.split("\n"));
    const before = lines.slice(0, last + 1), after = lines.slice(end);
    return [...before, ...out, "", ...after].join("\n").replace(/\n{4,}/g, "\n\n\n");
  };
}

export async function insertIntoNote(app: App, file: TFile, text: string, key: SectionKey, opts: { numbered?: boolean; date?: boolean } = {}) {
  await app.vault.process(file, insertInSection(text, key, opts));
  new Notice(`Added to ${SECTIONS[key].title}`);
}

// ------------------------------------------------------------------ phrases

const g3 = (mg: number) => (mg >= 1000 ? (mg / 1000).toFixed(3) + " g" : mg >= 10 ? mg.toFixed(1) + " mg" : mg.toFixed(2) + " mg");
const mm = (x: number) => (x >= 1 ? +x.toFixed(2) + " mmol" : +(x * 1000).toFixed(1) + " µmol");

/** "triphenylphosphine oxide (2.783 g, 10 mmol, 1.0 eq.)" in the template's style. */
export function reagentPhrase(r: CalcRow): string {
  const name = r.src.name || r.formula || "compound";
  if (r.role === "solvent") return `${r.volume ? +r.volume.toFixed(1) + " mL " : ""}${name}`;
  const parts: string[] = [];
  if (r.src.molarity) parts.push(`${r.src.molarity} M`);
  if (r.volume !== null && (r.src.molarity || r.src.density)) parts.push(fmtVol(r.volume));
  if (r.mass !== null && !r.src.molarity) parts.unshift(g3(r.mass));
  if (r.mmol !== null) parts.push(mm(r.mmol));
  if (r.eq !== null) parts.push(r.role === "catalyst" && r.eq < 1 ? `${+(r.eq * 100).toFixed(1)} mol%` : `${r.eq.toFixed(1)} eq.`);
  return `${name}${r.src.molarity ? " solution" : ""} (${parts.join(", ")})`;
}

export const PHRASES: Record<SectionKey, string[]> = {
  remarks: ["Purpose: ", "Synthesis of starting material for ", "Screening of ", "Scale-up of ", "Based on the procedure of: ", "Adapted from: ", "Risks: ", "Quench: "],
  equipment: [
    "Dried glassware required: 24 h oven at 150 °C + heat gun treatment under N₂ atmosphere.",
    "Inert gas: N₂.", "Inert gas: Ar.", "Schlenk line.", "Glovebox.",
    "Anhydrous solvents required: THF was freshly distilled from sodium using benzophenone as an indicator.",
    "Anhydrous solvent from the solvent purification system (SPS).", "Dried over activated 3 Å molecular sieves.", "Dried over activated 4 Å molecular sieves.",
    "Glassware: ", "round-bottom flask", "two-necked round-bottom flask", "Schlenk flask", "reflux condenser", "stir bar", "rubber septum", "glass stopper", "dropping funnel",
    "Remove any flammable chemicals from the area while handling organolithium compounds.",
  ],
  experimental: [
    "Under nitrogen atmosphere", "Under argon atmosphere", "was dissolved in ", "was suspended in ", "was charged with ", "was added", "was added dropwise", "was added portionwise",
    "with a syringe", "at 0 °C (ice bath)", "at −78 °C (dry ice/acetone)", "at room temperature", "The resulting solution was cooled to 0 °C (ice bath).",
    "The resulting mixture was heated under reflux for  h.", "The reaction mixture was stirred at room temperature for  h.", "The mixture was allowed to warm to room temperature.",
    "The reaction was monitored by TLC.", "Full conversion of the starting material (TLC).", "mL of water were added to the reaction mixture.", "The reaction was quenched with sat. aq. NH₄Cl.",
  ],
  workup: [
    "The solvent was removed under reduced pressure.", "The aqueous layer was extracted three times with 10 mL of ethyl acetate.",
    "The combined organic layers were washed once with 10 mL of brine and dried over sodium sulphate.", "dried over MgSO₄", "The mixture was filtered through a pad of Celite.",
    "The solid was collected by filtration and washed with ", "For a better phase separation during the extraction.", "m(crude) = ", "The crude product was purified by column chromatography.",
  ],
  analytical: ["Product confirmed by ¹H NMR.", "qNMR (internal standard: 1,3,5-trimethoxybenzene): ", "HPLC retention time: ", "GC retention time: ", "Spectra attached: "],
  conclusion: [
    "TLC analysis showed full conversion.", "TLC analysis showed no product formation and no conversion.", "The product was isolated in sufficient amount for the next step.",
    "The synthesis will be repeated using ", "Improvement: ", "The reaction mixture was quenched and discarded.",
  ],
};

export const SOLVENTS = ["Cy", "PE", "Hex", "Pent", "EA", "Et₂O", "DCM", "CHCl₃", "MeOH", "EtOH", "Tol", "Acetone", "MeCN", "THF", "H₂O"];
export const RATIOS = ["1:0", "50:1", "20:1", "10:1", "9:1", "5:1", "4:1", "3:1", "2:1", "1:1", "1:2", "1:5", "0:1"];
export const PHASES = ["SiO₂", "Al₂O₃", "RP-C18", "RP-SiO₂"];
export const ADDITIVES = ["", "1% NEt₃", "1% AcOH", "0.1% HCOOH", "1% NH₃ (aq.)"];
export const STAINS = ["UV 254 nm", "UV 366 nm", "KMnO₄", "CAM", "anisaldehyde", "vanillin", "ninhydrin", "PMA", "I₂", "Dragendorff", "FeCl₃", "bromocresol green"];

export interface SolventSystem { phase: string; a: string; b: string; ratio: string; additive: string }
export const DEFAULT_SYSTEM: SolventSystem = { phase: "SiO₂", a: "Cy", b: "EA", ratio: "5:1", additive: "" };

export function percentB(ratio: string): number | null {
  const mm2 = /^\s*([\d.]+)\s*:\s*([\d.]+)\s*$/.exec(ratio);
  if (!mm2) return null;
  const a = +mm2[1], b = +mm2[2];
  return a + b > 0 ? (100 * b) / (a + b) : null;
}

/** "Cy:EA 5:1 or 17% EA" — template style */
export function systemText(s: SolventSystem, withPhase = true): string {
  let eluent: string;
  if (!s.b || s.ratio === "1:0") eluent = s.a;
  else if (s.ratio === "0:1") eluent = s.b;
  else {
    const p = percentB(s.ratio);
    eluent = `${s.a}:${s.b} ${s.ratio}${p !== null ? ` or ${+p.toFixed(0)}% ${s.b}` : ""}`;
  }
  if (s.additive) eluent += ` + ${s.additive}`;
  return withPhase ? `${s.phase}, ${eluent}` : eluent;
}

// ------------------------------------------------------------------ UI helpers

export function chips(parent: HTMLElement, items: string[], onPick: (v: string, el: HTMLElement) => void, opts: { selected?: string | string[]; cls?: string } = {}) {
  const row = parent.createDiv({ cls: "ce-lb-chips" + (opts.cls ? " " + opts.cls : "") });
  const sel = Array.isArray(opts.selected) ? opts.selected : opts.selected !== undefined ? [opts.selected] : [];
  for (const it of items) {
    const b = row.createEl("button", { cls: "ce-lb-chip" + (sel.includes(it) ? " is-on" : ""), text: it || "none" });
    b.onclick = (e) => { e.preventDefault(); onPick(it, b); };
  }
  return row;
}

export function label(parent: HTMLElement, text: string) { return parent.createDiv({ cls: "ce-lb-label", text }); }

/** Solvent system picker (phase, solvent A, B, ratio, additive). Calls onChange with the new system. */
export function solventPicker(parent: HTMLElement, sys: SolventSystem, onChange: (s: SolventSystem) => void, opts: { phase?: boolean } = {}) {
  const box = parent.createDiv({ cls: "ce-lb-solvent" });
  const draw = () => {
    box.empty();
    if (opts.phase !== false) { label(box, "Stationary phase"); chips(box, PHASES, (v) => { sys.phase = v; changed(); }, { selected: sys.phase }); }
    label(box, "Solvent A"); chips(box, SOLVENTS, (v) => { sys.a = v; changed(); }, { selected: sys.a });
    label(box, "Solvent B"); chips(box, ["", ...SOLVENTS], (v) => { sys.b = v; changed(); }, { selected: sys.b });
    if (sys.b) {
      label(box, "Ratio A:B");
      const r = chips(box, RATIOS, (v) => { sys.ratio = v; changed(); }, { selected: sys.ratio });
      const custom = r.createEl("input", { type: "text", placeholder: "custom e.g. 7:3", value: RATIOS.includes(sys.ratio) ? "" : sys.ratio, cls: "ce-lb-small" });
      custom.onchange = () => { if (custom.value.trim()) { sys.ratio = custom.value.trim(); changed(); } };
    }
    label(box, "Additive"); chips(box, ADDITIVES, (v) => { sys.additive = v; changed(); }, { selected: sys.additive });
    box.createDiv({ cls: "ce-lb-preview-line", text: systemText(sys, opts.phase !== false) });
  };
  const changed = () => { onChange(sys); draw(); };
  draw();
  return box;
}

/** Base modal: big touch targets, preview textarea, insert buttons. */
export abstract class BuilderModal extends Modal {
  protected preview!: HTMLTextAreaElement;
  protected section: SectionKey;
  protected numbered = true;
  constructor(protected ctx: ElnCtx, section: SectionKey, private heading: string) {
    super(ctx.plugin.app);
    this.section = section;
  }
  abstract build(body: HTMLElement): void;
  /** text to insert, from the current form state */
  compose(): string { return this.preview.value; }
  onOpen() {
    this.modalEl.addClass("ce-lb-modal");
    this.titleEl.setText(this.heading);
    const body = this.contentEl.createDiv({ cls: "ce-lb-body" });
    this.build(body);
    const foot = this.contentEl.createDiv({ cls: "ce-lb-foot" });
    label(foot, "Text to insert");
    this.preview = foot.createEl("textarea", { cls: "ce-lb-text" });
    this.preview.rows = 3;
    this.refresh();
    const secRow = foot.createDiv({ cls: "ce-lb-row" });
    secRow.createSpan({ cls: "ce-lb-label", text: "Into:" });
    chips(secRow, Object.keys(SECTIONS).map((k) => SECTION_LABEL[k as SectionKey]), (v) => {
      this.section = (Object.keys(SECTION_LABEL) as SectionKey[]).find((k) => SECTION_LABEL[k] === v)!;
      this.onOpenSection();
    }, { selected: SECTION_LABEL[this.section], cls: "ce-lb-sec" });
    const nb = foot.createEl("label", { cls: "ce-lb-check" });
    const cb = nb.createEl("input", { type: "checkbox" });
    cb.checked = this.numbered;
    cb.onchange = () => { this.numbered = cb.checked; };
    nb.appendText(" numbered step");
    const btns = foot.createDiv({ cls: "ce-lb-buttons" });
    const again = btns.createEl("button", { text: "Insert & add another" });
    const ok = btns.createEl("button", { text: "Insert", cls: "mod-cta" });
    const go = async (close: boolean) => {
      const t = this.preview.value.trim();
      if (!t) { new Notice("Nothing to insert"); return; }
      await insertIntoNote(this.app, this.ctx.file, t, this.section, { numbered: this.numbered, date: this.section === "experimental" || this.section === "workup" });
      if (close) this.close(); else { this.preview.value = ""; this.reset(); }
    };
    ok.onclick = () => go(true);
    again.onclick = () => go(false);
  }
  protected onOpenSection() { this.contentEl.empty(); this.onOpen(); }
  protected reset() { /* subclasses */ }
  /** recompute preview from form state (subclasses override; default keeps user text) */
  refresh() { /* */ }
  protected insertAtCursor(s: string) {
    const ta = this.preview;
    const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
    const before = ta.value.slice(0, a), after = ta.value.slice(b);
    const sep = before && !/\s$/.test(before) && !/^[,.;)]/.test(s) ? " " : "";
    ta.value = before + sep + s + after;
    const pos = (before + sep + s).length;
    ta.focus(); ta.setSelectionRange(pos, pos);
  }
  onClose() { this.contentEl.empty(); }
}

// ------------------------------------------------------------------ step builder

export class StepModal extends BuilderModal {
  constructor(ctx: ElnCtx, section: SectionKey = "experimental", private observation = false) {
    super(ctx, section, observation ? "Observation" : "Add to lab book");
    this.numbered = !observation && (section === "experimental" || section === "workup");
  }
  build(body: HTMLElement) {
    const rows = this.ctx.calc.rows, prods = this.ctx.calc.products;
    if (this.section === "experimental" && (rows.length || prods.length)) {
      label(body, "Reagents (theoretical amounts from the table)");
      chips(body, rows.map((r) => r.src.name || r.formula || "?"), (_v, el) => {
        const i = [...el.parentElement!.children].indexOf(el);
        this.insertAtCursor(reagentPhrase(rows[i]));
      });
      label(body, "Experimental value (shown in blue)");
      const er = body.createDiv({ cls: "ce-lb-row" });
      const inp = er.createEl("input", { type: "text", placeholder: "e.g. 2.790 g", cls: "ce-lb-small" });
      inp.inputMode = "decimal";
      const b = er.createEl("button", { text: "Insert exp. value" });
      b.onclick = () => { if (inp.value.trim()) { this.insertAtCursor(`<span class="ce-exp">${inp.value.trim()}</span>`); inp.value = ""; } };
    }
    label(body, this.observation ? "Observations" : "Phrases");
    const obs = ["The solution turned yellow.", "The solution turned dark red.", "A white precipitate formed.", "Solids had formed, yellowish solution.", "Gas evolution was observed.", "Exothermic reaction.", "The mixture became homogeneous.", "No change."];
    chips(body, this.observation ? obs : PHRASES[this.section], (v) => this.insertAtCursor(v));
    label(body, "Time stamps");
    chips(body, [`(Start: ${nowHM()})`, `(End: ${nowHM()})`, `${nowHM()}`, `(${dateStamp()})`], (v) => this.insertAtCursor(v));
    if (this.observation) this.numbered = false;
  }
}

// ------------------------------------------------------------------ column chromatography

export class ColumnModal extends BuilderModal {
  private sys: SolventSystem;
  private grad: string[] = [];
  private mode: "manual" | "automated" = "manual";
  private f = { length: "", radius: "", silica: "", cartridge: "", flow: "", wl: "" };
  private fractions: Array<{ range: string; mass: string; compound: string }> = [];
  constructor(ctx: ElnCtx) {
    super(ctx, "workup", "Column chromatography");
    this.sys = { ...(ctx.plugin.settings.lastSystem ?? DEFAULT_SYSTEM) };
  }
  build(body: HTMLElement) {
    chips(body, ["manual", "automated"], (v) => { this.mode = v as any; this.onOpenSection(); }, { selected: this.mode });
    const grid = body.createDiv({ cls: "ce-lb-grid" });
    const field = (k: keyof typeof this.f, ph: string) => {
      const i = grid.createEl("input", { type: "text", placeholder: ph, value: this.f[k] });
      i.oninput = () => { this.f[k] = i.value; this.refresh(); };
    };
    if (this.mode === "manual") { field("length", "length (cm)"); field("radius", "radius (cm)"); field("silica", "SiO₂ (g)"); }
    else { field("cartridge", "cartridge (e.g. 12 g SiO₂)"); field("flow", "flow (mL/min)"); field("wl", "λ (nm)"); }
    solventPicker(body, this.sys, () => this.refresh());
    label(body, "Gradient: tap ratios in order (isocratic = one)");
    const gr = chips(body, RATIOS.filter((r) => r !== "1:0" || true), (v) => { this.grad.push(v); this.refresh(); });
    const clr = gr.createEl("button", { cls: "ce-lb-chip", text: "⟲ clear" });
    clr.onclick = () => { this.grad = []; this.refresh(); };
    label(body, "Fractions (mass balance)");
    const ft = body.createDiv({ cls: "ce-lb-fractions" });
    const drawF = () => {
      ft.empty();
      this.fractions.forEach((fr, i) => {
        const r = ft.createDiv({ cls: "ce-lb-grid" });
        for (const k of ["range", "mass", "compound"] as const) {
          const inp = r.createEl("input", { type: "text", placeholder: k === "range" ? "9 - 14" : k === "mass" ? "450 mg" : "compound", value: fr[k] });
          inp.oninput = () => { this.fractions[i][k] = inp.value; this.refresh(); };
        }
      });
      const add = ft.createEl("button", { text: "+ fraction group" });
      add.onclick = () => { this.fractions.push({ range: "", mass: "", compound: "" }); drawF(); };
    };
    drawF();
  }
  refresh() {
    if (!this.preview) return;
    this.ctx.plugin.settings.lastSystem = { ...this.sys };
    const pct = (r: string) => { const p = percentB(r); return p !== null && this.sys.b ? `(${+p.toFixed(0)}%)` : ""; };
    const g = this.grad.length ? this.grad.map((r) => `${r}${pct(r)}`).join("→") : this.sys.ratio + pct(this.sys.ratio);
    const elu = this.sys.b ? `${g} ${this.sys.a}:${this.sys.b}` : this.sys.a;
    let head: string;
    if (this.mode === "manual") {
      const dims = [this.f.length && `length: ${this.f.length} cm`, this.f.radius && `radius: ${this.f.radius} cm`, this.f.silica && `${this.f.silica} g SiO₂`].filter(Boolean).join(", ");
      head = `Column${dims ? ` (${dims})` : ""}: (${this.sys.phase}, ${elu}${this.sys.additive ? " + " + this.sys.additive : ""})`;
    } else {
      const p = this.grad.length >= 2 ? `${pct(this.grad[0]).replace(/[()]/g, "")} → ${pct(this.grad[this.grad.length - 1]).replace(/[()]/g, "")} ${this.sys.b}` : elu;
      head = `Automated column (${[this.f.cartridge, this.f.flow && `${this.f.flow} mL/min`, this.f.wl && `λ = ${this.f.wl} nm`].filter(Boolean).join(", ")}): ${this.sys.phase}, ${p} in ${this.sys.a}`;
    }
    let t = head;
    const fr = this.fractions.filter((x) => x.range || x.mass || x.compound);
    if (fr.length) {
      t += "\n\n| Fraction | " + fr.map((x) => x.range).join(" | ") + " |\n|---|" + fr.map(() => "---").join("|") + "|\n| Mass | " + fr.map((x) => x.mass).join(" | ") + " |\n| Compound | " + fr.map((x) => x.compound).join(" | ") + " |";
    }
    this.preview.value = t;
  }
}

// ------------------------------------------------------------------ recrystallisation

export class RecrystModal extends BuilderModal {
  private s = { solvents: [] as string[], ratio: "", hot: false, cool: "6 °C (fridge)", wash: "", washVol: "", dry: "under reduced pressure for 30 min" };
  constructor(ctx: ElnCtx) { super(ctx, "workup", "Recrystallisation"); }
  build(body: HTMLElement) {
    label(body, "Solvent(s) — tap in order");
    chips(body, ["n-pentane", "n-hexane", "Cy", "EtOH", "MeOH", "iPrOH", "EA", "Tol", "DCM", "Et₂O", "H₂O", "MeCN", "acetone"], (v) => { this.s.solvents.push(v); this.refresh(); });
    const r = body.createDiv({ cls: "ce-lb-row" });
    const ratio = r.createEl("input", { type: "text", placeholder: "ratio e.g. 9:1", cls: "ce-lb-small" });
    ratio.oninput = () => { this.s.ratio = ratio.value; this.refresh(); };
    const clr = r.createEl("button", { text: "⟲ solvents" });
    clr.onclick = () => { this.s.solvents = []; this.refresh(); };
    const hot = body.createEl("label", { cls: "ce-lb-check" });
    const cb = hot.createEl("input", { type: "checkbox" });
    cb.onchange = () => { this.s.hot = cb.checked; this.refresh(); };
    hot.appendText(" hot filtration of undissolved solids");
    label(body, "Crystallisation completed at");
    chips(body, ["room temperature", "6 °C (fridge)", "−20 °C (freezer)", "0 °C (ice bath)"], (v) => { this.s.cool = v; this.refresh(); }, { selected: this.s.cool });
    label(body, "Washing");
    const w = body.createDiv({ cls: "ce-lb-grid" });
    const ws = w.createEl("input", { type: "text", placeholder: "solvent (cold n-pentane)" });
    ws.oninput = () => { this.s.wash = ws.value; this.refresh(); };
    const wv = w.createEl("input", { type: "text", placeholder: "volume (mL)" });
    wv.oninput = () => { this.s.washVol = wv.value; this.refresh(); };
    label(body, "Drying");
    chips(body, ["under reduced pressure for 30 min", "under high vacuum overnight", "in a desiccator", "at 60 °C in a vacuum oven"], (v) => { this.s.dry = v; this.refresh(); }, { selected: this.s.dry });
  }
  refresh() {
    if (!this.preview) return;
    const sol = this.s.solvents.join(":") || "…";
    let t = `Recrystallisation from ${sol}${this.s.ratio ? ` (${this.s.ratio})` : ""}.`;
    if (this.s.hot) t += " Undissolved solids were removed by hot filtration.";
    t += ` The crystallisation was completed at ${this.s.cool}.`;
    if (this.s.wash) t += ` The crystals were washed with ${this.s.washVol ? this.s.washVol + " mL of " : ""}${this.s.wash}.`;
    t += ` The solids were dried ${this.s.dry}.`;
    this.preview.value = t;
  }
}

// ------------------------------------------------------------------ analytical data table

const ANALYSES = ["¹H NMR", "¹³C NMR", "¹⁹F NMR", "³¹P NMR", "TLC (SiO₂)", "HPLC (RP-C18)", "GC", "HRMS", "IR", "m.p."];

export class AnalyticsModal extends BuilderModal {
  private state = new Map<string, { s: "done" | "na" | ""; note: string }>();
  constructor(ctx: ElnCtx) {
    super(ctx, "analytical", "Analytical data table");
    this.numbered = false;
    for (const a of ANALYSES.slice(0, 6)) this.state.set(a, { s: "", note: "" });
  }
  build(body: HTMLElement) {
    label(body, "Add analyses");
    chips(body, ANALYSES, (v) => { if (!this.state.has(v)) this.state.set(v, { s: "", note: "" }); else this.state.delete(v); this.onOpenSection(); }, { selected: [...this.state.keys()] });
    for (const [k, v] of this.state) {
      const r = body.createDiv({ cls: "ce-lb-anrow" });
      r.createSpan({ cls: "ce-lb-anname", text: k });
      chips(r, ["✓ done", "✗ n/a", "—"], (c) => { v.s = c.startsWith("✓") ? "done" : c.startsWith("✗") ? "na" : ""; this.onOpenSection(); }, { selected: v.s === "done" ? "✓ done" : v.s === "na" ? "✗ n/a" : "—" });
      const inp = r.createEl("input", { type: "text", placeholder: k.startsWith("TLC") ? "Rf = 0.45 (Cy:EA 5:1)" : "note (Product confirmed…)", value: v.note });
      inp.oninput = () => { v.note = inp.value; this.refresh(); };
    }
    const p = this.ctx.calc.products.find((x) => x.src.smiles);
    if (p) {
      const b = body.createEl("button", { text: "+ calculated HRMS / EA lines for the product" });
      b.onclick = async () => {
        const { characterizationTemplate } = await import("../chem/eln");
        this.preview.value += "\n\n" + characterizationTemplate(String(p.src.smiles));
      };
    }
  }
  refresh() {
    if (!this.preview) return;
    const keys = [...this.state.keys()];
    const cell = (k: string) => { const v = this.state.get(k)!; return [v.s === "done" ? "✓" : v.s === "na" ? "✗" : "", v.note].filter(Boolean).join(" "); };
    this.preview.value = `| ${keys.join(" | ")} |\n|${keys.map(() => "---").join("|")}|\n| ${keys.map(cell).join(" | ")} |\n\n✓ = analysis done; ✗ = analysis not applicable.`;
  }
}

// ------------------------------------------------------------------ risks (hazard suggestions)

interface Hazard { id: string; test: (name: string, smi: string) => boolean; text: string }
const HAZARDS: Hazard[] = [
  { id: "organolithium", test: (n, s) => /\b(n|s|t)?-?BuLi\b|PhLi|MeLi|LDA|LiHMDS|lithium/i.test(n) || /\[Li\]C|C\[Li\]|\[Li\]c|c\[Li\]/.test(s), text: "Organolithium reagent: pyrophoric, air- and moisture-sensitive. Handle under inert gas with dry syringes; remove flammables from the hood. Quench excess slowly with iPrOH at 0 °C, then MeOH, then water." },
  { id: "hydride", test: (n, s) => /LiAlH4|LAH|\bNaH\b|DIBAL|BH3|borane|NaBH4|L-?selectride|KH\b/i.test(n) || /\[AlH4-\]|\[BH4-\]|\[H-\]/.test(s), text: "Metal hydride: reacts violently with water (H₂ evolution). Add portionwise; quench at 0 °C (Fieser work-up for LiAlH₄: x mL H₂O, x mL 15% NaOH, 3x mL H₂O per x g)." },
  { id: "grignard", test: (n, s) => /MgBr|MgCl|MgI|Grignard/i.test(n) || /\[Mg\]/.test(s), text: "Grignard reagent: moisture-sensitive, exothermic quench. Quench with sat. aq. NH₄Cl at 0 °C." },
  { id: "alkali", test: (n, s) => /sodium metal|\bNa\b(?! ?[A-Z])|potassium metal|Na\/K|lithium metal/i.test(n) || /^\[(Na|K|Li)\]$/.test(s), text: "Alkali metal: water-reactive, fire hazard. Destroy residues with iPrOH/EtOH before water." },
  { id: "oxidizer", test: (n, s) => /H2O2|hydrogen peroxide|KMnO4|mCPBA|Oxone|NaOCl|bleach|CrO3|PCC|PDC|Dess|DMP|NaIO4|OsO4|HNO3/i.test(n) || /OO/.test(s), text: "Strong oxidizer: keep away from organics/reductants; test for and quench residual peroxide/oxidant (sat. Na₂S₂O₃ or Na₂SO₃) before work-up." },
  { id: "azide", test: (n, s) => /azide|NaN3|TMSN3|DPPA/i.test(n) || /N=\[N\+\]=\[N-\]|\[N-\]=\[N\+\]=N/.test(s), text: "Azide: potentially explosive, toxic (HN₃). No metal spatulas, no halogenated solvents (CH₂N₄ formation), keep small scale; quench with NaNO₂/acid." },
  { id: "acylhalide", test: (n, s) => /SOCl2|thionyl|oxalyl chloride|POCl3|PCl5|acid chloride|acyl chloride/i.test(n) || /C\(=O\)Cl|ClC\(=O\)|S\(=O\)\(Cl\)|ClS\(Cl\)=O/.test(s), text: "Acid chloride / chlorinating agent: corrosive, releases HCl/SO₂ — use a gas trap; quench slowly into ice/sat. NaHCO₃." },
  { id: "strongacid", test: (n) => /H2SO4|sulfuric|TfOH|triflic|\bHF\b|HCl conc|oleum|TFA/i.test(n), text: "Strong acid: corrosive; add acid to water, neutralise carefully with NaHCO₃." },
  { id: "cyanide", test: (n, s) => /cyanide|NaCN|KCN|TMSCN|HCN/i.test(n) || /\[C-\]#N|C#\[N\]/.test(s), text: "Cyanide: highly toxic, HCN release with acid. Keep basic; quench with bleach (NaOCl) at pH > 10; antidote kit available." },
  { id: "peroxideformer", test: (n) => /\bTHF\b|Et2O|Et₂O|diethyl ether|dioxane|DME\b|diisopropyl ether/i.test(n), text: "Peroxide-forming solvent: test for peroxides before distillation/concentration." },
  { id: "flammable", test: (n) => /Et2O|Et₂O|ether|pentane|hexane|CS2/i.test(n), text: "Highly flammable solvent: no ignition sources; use in fume hood." },
  { id: "heavy", test: (n, s) => /Hg|thallium|Tl\(|OsO4|lead|Pb\(/i.test(n) || /\[(Hg|Tl|Os|Pb|Cd)\]/.test(s), text: "Toxic heavy metal: dedicated waste; avoid skin contact." },
  { id: "carcinogen", test: (n) => /benzene\b|CHCl3|chloroform|CCl4|HMPA|dimethyl sulfate|MeI|methyl iodide|hydrazine/i.test(n), text: "Toxic/carcinogenic reagent: minimise exposure, double gloves, fume hood." },
];

export function suggestHazards(d: ElnData): Hazard[] {
  const all = [...(d.reactants ?? []), ...(d.products ?? [])];
  const txt = [d.solvent ?? "", d.conditions ?? ""].join(" ");
  return HAZARDS.filter((h) => all.some((c) => h.test(String(c.name ?? ""), String(c.smiles ?? ""))) || h.test(txt, ""));
}

export class RisksModal extends BuilderModal {
  private picked = new Set<string>();
  constructor(ctx: ElnCtx) {
    super(ctx, "remarks", "Risks & quenching");
    this.numbered = false;
    for (const h of suggestHazards(ctx.data)) this.picked.add(h.id);
  }
  build(body: HTMLElement) {
    const sug = suggestHazards(this.ctx.data);
    body.createDiv({ cls: "ce-lb-hint", text: sug.length ? `Suggested from your reagents: ${sug.length}. Tap to toggle; review before use — this is a reminder, not a risk assessment.` : "No specific hazards recognised from the reagent names/structures. Add any that apply:" });
    for (const h of HAZARDS) {
      const row = body.createEl("label", { cls: "ce-lb-hazard" + (sug.includes(h) ? " is-suggested" : "") });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = this.picked.has(h.id);
      cb.onchange = () => { if (cb.checked) this.picked.add(h.id); else this.picked.delete(h.id); this.refresh(); };
      row.appendText(" " + h.text);
    }
  }
  refresh() {
    if (!this.preview) return;
    const hs = HAZARDS.filter((h) => this.picked.has(h.id));
    this.preview.value = hs.length ? "**Risks & quenching:**\n" + hs.map((h) => "- " + h.text).join("\n") : "**Risks:** none beyond standard laboratory practice.";
  }
}

// ------------------------------------------------------------------ equipment

export class EquipmentModal extends BuilderModal {
  constructor(ctx: ElnCtx) { super(ctx, "equipment", "Chemicals & equipment"); this.numbered = false; }
  build(body: HTMLElement) {
    label(body, "Set-up phrases");
    chips(body, PHRASES.equipment, (v) => this.insertAtCursor(v.endsWith(".") || v.endsWith(": ") ? v : v + ","));
    label(body, "Reagents (supplier / lot / purity)");
    for (const r of this.ctx.calc.rows) {
      const b = body.createEl("button", { cls: "ce-lb-chip", text: `${r.src.name || r.formula}` });
      b.onclick = () => this.insertAtCursor(`\n- ${r.src.name || r.formula}: ${[r.src.supplier, r.src.lot && `lot ${r.src.lot}`, r.src.purity && `${r.src.purity}%`, r.src.cas && `CAS ${r.src.cas}`].filter(Boolean).join(", ") || "supplier, lot, purity"}`);
    }
  }
}

// ------------------------------------------------------------------ electrochemistry

const FARADAY = 96485.332;
export function electroCalc(mmol: number | null, F: number | null, mA: number | null, area: number | null) {
  const Q = mmol !== null && F ? F * (mmol / 1000) * FARADAY : null;
  const t = Q !== null && mA ? Q / (mA / 1000) : null; // s
  const j = mA && area ? mA / area : null;
  return { Q, t, j };
}
export const fmtDuration = (s: number | null) => (s === null ? "–" : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

export class ElectroModal extends BuilderModal {
  private s: { F: string; mA: string; area: string; anode: string; cathode: string; electrolyte: string; conc: string; rpm: string; vStart: string; vEnd: string; temp: string };
  constructor(ctx: ElnCtx) {
    super(ctx, "experimental", "Electrolysis");
    const d = ctx.data;
    this.s = { F: String(d.charge_F ?? "2.0"), mA: String(d.current_mA ?? ""), area: String(d.area_cm2 ?? ""), anode: d.anode ?? "graphite", cathode: d.cathode ?? "graphite", electrolyte: d.electrolyte ?? "nBu₄NBF₄", conc: String(d.electrolyte_M ?? "0.05"), rpm: "300", vStart: "", vEnd: "", temp: d.temperature ?? "room temperature" };
  }
  build(body: HTMLElement) {
    const grid = body.createDiv({ cls: "ce-lb-grid" });
    const f = (k: keyof typeof this.s, ph: string, numeric = true) => {
      const wrap = grid.createDiv();
      wrap.createDiv({ cls: "ce-lb-label", text: ph });
      const i = wrap.createEl("input", { type: "text", value: this.s[k] });
      if (numeric) i.inputMode = "decimal";
      i.oninput = () => { this.s[k] = i.value; this.refresh(); };
    };
    f("F", "charge (F/mol)"); f("mA", "current (mA)"); f("area", "electrode area (cm²)"); f("conc", "electrolyte (M)"); f("rpm", "stirring (rpm)"); f("vStart", "terminal V (start)"); f("vEnd", "terminal V (end)");
    label(body, "Anode"); chips(body, ["graphite", "RVC", "glassy carbon", "Pt", "Ni", "Zn", "Mg", "Fe", "BDD"], (v) => { this.s.anode = v; this.onOpenSection(); }, { selected: this.s.anode });
    label(body, "Cathode"); chips(body, ["graphite", "RVC", "glassy carbon", "Pt", "Ni", "Zn", "Mg", "Fe", "Pb", "BDD"], (v) => { this.s.cathode = v; this.onOpenSection(); }, { selected: this.s.cathode });
    label(body, "Supporting electrolyte"); chips(body, ["nBu₄NBF₄", "nBu₄NPF₆", "Et₄NBF₄", "LiClO₄", "LiBF₄", "nBu₄NClO₄"], (v) => { this.s.electrolyte = v; this.onOpenSection(); }, { selected: this.s.electrolyte });
    label(body, "Temperature"); chips(body, ["room temperature", "0 °C (ice bath)", "40 °C", "60 °C"], (v) => { this.s.temp = v; this.onOpenSection(); }, { selected: this.s.temp });
    const c = electroCalc(this.ctx.calc.refMmol, +this.s.F || null, +this.s.mA || null, +this.s.area || null);
    body.createDiv({ cls: "ce-lb-preview-line", text: `Scale ${this.ctx.calc.refMmol !== null ? fmtMmol(this.ctx.calc.refMmol) : "?"} · Q = ${c.Q !== null ? c.Q.toFixed(1) + " C" : "?"} · t = ${fmtDuration(c.t)} · j = ${c.j !== null ? c.j.toFixed(1) + " mA cm⁻²" : "?"}` });
  }
  refresh() {
    if (!this.preview) return;
    const c = electroCalc(this.ctx.calc.refMmol, +this.s.F || null, +this.s.mA || null, +this.s.area || null);
    const lines = [
      `Anode: ${this.s.anode}; Cathode: ${this.s.cathode}; ${this.s.temp}, ${this.s.rpm} rpm; ${this.s.conc} M ${this.s.electrolyte}.`,
      `${this.s.F} F of electricity was passed${c.Q !== null ? ` (${c.Q.toFixed(1)} C)` : ""}${this.s.mA ? ` at ${this.s.mA} mA` : ""}${c.j !== null ? ` (j = ${c.j.toFixed(1)} mA cm⁻²)` : ""}${c.t !== null ? `, ${fmtDuration(c.t)}` : ""} (Start: ${nowHM()})`,
      this.s.vStart ? `Terminal voltage (start): ${this.s.vStart} V` : "",
      this.s.vEnd ? `Terminal voltage (end): ${this.s.vEnd} V` : "",
    ].filter(Boolean);
    this.preview.value = lines.join("\n");
  }
}

// ------------------------------------------------------------------ conclusion

export class ConclusionModal extends BuilderModal {
  constructor(ctx: ElnCtx) { super(ctx, "conclusion", "Conclusion"); this.numbered = false; }
  build(body: HTMLElement) {
    const p = this.ctx.calc.products[0];
    if (p && p.yieldPct !== null && isFinite(p.yieldPct)) {
      const s = `${p.src.name || "The product"} was isolated in ${p.yieldPct.toFixed(0)}% yield (${p.isoMass !== null ? fmtMass(p.isoMass) : "?"}, ${p.isoMmol !== null ? fmtMmol(p.isoMmol) : "?"}).`;
      chips(body, [s], (v) => this.insertAtCursor(v));
    }
    label(body, "Phrases");
    chips(body, PHRASES.conclusion, (v) => this.insertAtCursor(v));
  }
}

// ------------------------------------------------------------------ photos

/** Pick/take a photo; returns a (downscaled) JPEG blob. */
export function pickImage(capture: boolean): Promise<File | null> {
  return new Promise((res) => {
    const inp = createEl("input");
    inp.type = "file";
    inp.accept = "image/*";
    if (capture) inp.setAttribute("capture", "environment");
    inp.onchange = () => res(inp.files?.[0] ?? null);
    inp.click();
  });
}

export async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise<void>((ok, err) => { img.onload = () => ok(); img.onerror = () => err(new Error("Cannot read image")); img.src = url; });
  return img;
}

export async function compressImage(file: Blob, maxPx: number, quality = 0.85): Promise<Blob> {
  const img = await loadImage(file);
  const s = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
  const c = createEl("canvas");
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((ok, err) => c.toBlob((b) => (b ? ok(b) : err(new Error("encode failed"))), "image/jpeg", quality));
}

export async function saveBinary(app: App, folder: string, name: string, blob: Blob): Promise<TFile> {
  const dir = normalizePath(folder || "/");
  if (dir !== "/" && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
  let path = normalizePath(`${dir === "/" ? "" : dir + "/"}${name}`);
  let n = 1;
  while (app.vault.getAbstractFileByPath(path)) path = path.replace(/(_\d+)?(\.\w+)$/, `_${n++}$2`);
  return app.vault.createBinary(path, await blob.arrayBuffer());
}

export class PhotoModal extends Modal {
  private blob: Blob | null = null;
  private caption = "";
  private section: SectionKey = "experimental";
  constructor(private ctx: ElnCtx) { super(ctx.plugin.app); }
  onOpen() {
    this.modalEl.addClass("ce-lb-modal");
    this.titleEl.setText("Photo");
    const c = this.contentEl;
    const prev = c.createDiv({ cls: "ce-lb-photo" });
    const row = c.createDiv({ cls: "ce-lb-buttons" });
    const take = async (cap: boolean) => {
      const f = await pickImage(cap);
      if (!f) return;
      this.blob = await compressImage(f, this.ctx.plugin.settings.photoMaxPx || 1600);
      prev.empty();
      const im = prev.createEl("img");
      im.src = URL.createObjectURL(this.blob);
    };
    row.createEl("button", { text: "📷 Take photo", cls: "mod-cta" }).onclick = () => take(true);
    row.createEl("button", { text: "🖼 Choose image" }).onclick = () => take(false);
    label(c, "Caption");
    const cap = c.createEl("input", { type: "text", placeholder: "e.g. reaction mixture after 2 h", cls: "ce-lb-wide" });
    cap.oninput = () => { this.caption = cap.value; };
    chips(c, ["reaction set-up", "reaction mixture", "colour change", "precipitate", "crude product", "after work-up", "column fractions", "pure product", "crystals"], (v) => { cap.value = cap.value ? cap.value + ", " + v : v; this.caption = cap.value; });
    label(c, "Into section");
    chips(c, (Object.keys(SECTIONS) as SectionKey[]).map((k) => SECTION_LABEL[k]), (v) => { this.section = (Object.keys(SECTION_LABEL) as SectionKey[]).find((k) => SECTION_LABEL[k] === v)!; this.contentEl.empty(); this.onOpen(); }, { selected: SECTION_LABEL[this.section] });
    const go = c.createDiv({ cls: "ce-lb-buttons" }).createEl("button", { text: "Insert photo", cls: "mod-cta" });
    go.onclick = async () => {
      if (!this.blob) { new Notice("Take or choose a photo first"); return; }
      const code = (this.ctx.data.code || this.ctx.file.basename).replace(/[\\/:*?"<>|\s]/g, "_");
      const f = await saveBinary(this.app, this.ctx.plugin.settings.elnMediaFolder, `Photo_${code}_${fileStamp()}.jpg`, this.blob);
      await insertIntoNote(this.app, this.ctx.file, `![[${f.name}|320]]\n*${nowHM()}${this.caption ? " — " + this.caption : ""}*`, this.section, { date: this.section === "experimental" });
      this.close();
    };
  }
  onClose() { this.contentEl.empty(); }
}

/** Extract ELN data from the note's first ```eln block (for commands run from the editor). */
export async function elnCtxForFile(plugin: ChemEditPlugin, file: TFile): Promise<ElnCtx> {
  const { parseElnYaml } = await import("./eln");
  const { calculateEln } = await import("../chem/eln");
  const txt = await plugin.app.vault.read(file);
  const mm2 = /```eln\s*\n([\s\S]*?)\n```/.exec(txt);
  let data: ElnData = { reactants: [], products: [] };
  if (mm2) { try { data = parseElnYaml(mm2[1]); } catch { /* */ } }
  return { plugin, file, data, calc: calculateEln(data) };
}

export { fmtEq, parseAny };
