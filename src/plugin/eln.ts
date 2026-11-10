// Basic ELN: ```eln reaction blocks (stoichiometry, scheme, yields), ```eln-list index, experiment notes.
import { App, setIcon, MarkdownPostProcessorContext, Menu, Modal, Notice, TFile, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import type ChemEditPlugin from "./main";
import { ChemDoc, buildGraph, components, newId } from "../chem/model";
import { parseAny, docToSmiles, reactionRoles } from "../chem/index";
import { ElnData, ElnCompound, Role, calculateEln, fmtMass, fmtVol, fmtMmol, fmtEq, characterizationTemplate, CalcRow, ElnCalc } from "../chem/eln";

import { insertInSection, ElnCtx, StepModal, PhotoModal, ColumnModal, RecrystModal, AnalyticsModal, RisksModal, EquipmentModal, ElectroModal, ConclusionModal, insertIntoNote, nowHM, dateStamp, suggestHazards } from "./labbook";
import { TlcModal } from "./tlc";
import { CompoundPicker } from "./lab";
import { CalcPicker } from "./calcview";
import { nmrBlock } from "./nmrview";
import { setSvg, setRich, setSvgChildren, serializeEl } from "../render/dom";
const STATUSES = ["Planned", "Running", "Work-up", "Purification", "Completed", "Failed", "On hold"];

/** Quote unquoted SMILES values (they may contain '#', ':' or '[') before YAML parsing — same trick as ChemEdit 1.x. */
export function parseElnYaml(source: string): ElnData {
  const safe = source.replace(/^(\s*-?\s*smiles:\s*)(.*)$/gm, (m, pre, v) => {
    let s = String(v).trim();
    if (!s) return m;
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return m;
    s = s.replace(/\s+#.*$/, "");
    return `${pre}'${s.replace(/'/g, "''")}'`;
  });
  const d = (parseYaml(safe) ?? {}) as ElnData;
  if (typeof d !== "object") throw new Error("ELN block must be YAML key: value pairs");
  d.reactants ??= [];
  d.products ??= [];
  return d;
}

function clean(d: ElnData): ElnData {
  // drop empty / computed keys before writing
  const strip = (c: ElnCompound) => {
    const o: ElnCompound = {};
    for (const [k, v] of Object.entries(c)) {
      if (v === undefined || v === null || v === "") continue;
      if (["theory_mass", "theory_mmol"].includes(k)) continue;
      o[k] = v;
    }
    return o;
  };
  return { ...d, reactants: (d.reactants ?? []).map(strip), products: (d.products ?? []).map(strip) };
}

export function elnYaml(d: ElnData): string { return stringifyYaml(clean(d)); }

/** Reaction scheme document from ELN data (structures + conditions text on the arrow). */
export function schemeDoc(d: ElnData): ChemDoc | null {
  const R = (d.reactants ?? []).filter((r) => (r.role ?? "reactant") === "reactant" && r.smiles);
  const P = (d.products ?? []).filter((p) => p.smiles);
  if (!R.length && !P.length) return null;
  let doc: ChemDoc;
  try { doc = parseAny(`${R.map((r) => r.smiles).join(".")}>>${P.map((p) => p.smiles).join(".")}`); } catch { return null; }
  const ar = doc.arrows[0];
  if (!ar) return doc;
  const above = (d.reactants ?? []).filter((r) => r.role === "reagent" || r.role === "catalyst").map((r) => r.name || r.smiles || "").filter(Boolean).join(", ");
  const solv = [d.solvent, ...(d.reactants ?? []).filter((r) => r.role === "solvent").map((r) => r.name)].filter(Boolean).join(", ");
  const below = [solv, d.temperature, d.duration, d.atmosphere, d.conditions].filter(Boolean).join(", ");
  const need = Math.max(above.length, below.length) * 0.34 + 0.8;
  const len = ar.x2 - ar.x1;
  if (need > len) {
    const delta = need - len;
    for (const a of doc.atoms) if (a.x > ar.x2) a.x += delta;
    for (const p of doc.pluses) if (p.x > ar.x2) p.x += delta;
    ar.x2 += delta;
  }
  const mx = (ar.x1 + ar.x2) / 2;
  if (above) doc.texts.push({ id: newId(doc), x: mx, y: ar.y1 - 0.5, text: above });
  if (below) doc.texts.push({ id: newId(doc), x: mx, y: ar.y1 + 0.55, text: below });
  return doc;
}

/** Update reactant/product SMILES from a reaction drawn in the editor. */
export function applySchemeToData(d: ElnData, doc: ChemDoc) {
  const g = buildGraph(doc);
  const comps = components(doc, g).sort((a, b) => cxOf(g, a) - cxOf(g, b));
  const roles = reactionRoles(doc, comps);
  const sub = (ids: number[]) => {
    const s = new Set(ids);
    return docToSmiles({ atoms: doc.atoms.filter((a) => s.has(a.id)), bonds: doc.bonds.filter((b) => s.has(b.a) && s.has(b.b)), arrows: [], pluses: [], texts: [], nextId: 0 });
  };
  const rs = comps.filter((_, i) => !roles || roles[i] === "r").map(sub);
  const ps = roles ? comps.filter((_, i) => roles[i] === "p").map(sub) : [];
  const ags = roles ? comps.filter((_, i) => roles[i] === "a").map(sub) : [];
  const reactants = d.reactants ?? [];
  const mainIdx = reactants.map((r, i) => ((r.role ?? "reactant") === "reactant" ? i : -1)).filter((i) => i >= 0);
  rs.forEach((smi, k) => {
    if (k < mainIdx.length) { const r = reactants[mainIdx[k]]; if (r.smiles !== smi) { r.smiles = smi; delete r.mw; } }
    else reactants.push({ name: "", smiles: smi, eq: 1 });
  });
  // remove reactants whose structure disappeared (only those that had a structure)
  for (let k = mainIdx.length - 1; k >= rs.length; k--) if (reactants[mainIdx[k]].smiles) reactants.splice(mainIdx[k], 1);
  for (const smi of ags) if (!reactants.some((r) => r.smiles === smi)) reactants.push({ name: "", smiles: smi, eq: 1, role: "reagent" });
  const products = d.products ?? [];
  ps.forEach((smi, k) => {
    if (k < products.length) { if (products[k].smiles !== smi) { products[k].smiles = smi; delete products[k].mw; } }
    else products.push({ name: "", smiles: smi, eq: 1 });
  });
  if (ps.length < products.length) products.splice(ps.length);
  d.reactants = reactants; d.products = products;
}
function cxOf(g: ReturnType<typeof buildGraph>, c: number[]) { let s = 0; for (const id of c) s += g.atomById.get(id)!.x; return s / c.length; }

export class PromptModal extends Modal {
  constructor(app: App, private title: string, private placeholder: string, private initial: string, private onOk: (v: string) => void) { super(app); }
  onOpen() {
    this.titleEl.setText(this.title);
    const inp = this.contentEl.createEl("input", { type: "text", placeholder: this.placeholder, value: this.initial });
    inp.addClass("ce-full-width");
    const row = this.contentEl.createDiv({ cls: "chemedit-modal-buttons ce-modal-row-end" });
    const ok = row.createEl("button", { text: "OK", cls: "mod-cta" });
    const go = () => { const v = inp.value.trim(); this.close(); if (v) this.onOk(v); };
    ok.onclick = go;
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    window.setTimeout(() => { inp.focus(); inp.select(); }, 20);
  }
  onClose() { this.contentEl.empty(); }
}

export class ElnRenderer {
  constructor(private plugin: ChemEditPlugin) {}

  private async save(el: HTMLElement, ctx: MarkdownPostProcessorContext, d: ElnData) {
    const info = ctx.getSectionInfo(el);
    const file = this.plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!info || !(file instanceof TFile)) { new Notice("Couldn't locate the ELN block in the note."); return; }
    const yaml = elnYaml(d).replace(/\n$/, "");
    await this.plugin.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const m = /^(\s*(?:>\s*)*)(`{3,}|~{3,})/.exec(lines[info.lineStart] ?? "");
      const prefix = m?.[1] ?? "";
      lines.splice(info.lineStart + 1, info.lineEnd - info.lineStart - 1, ...yaml.split("\n").map((l) => prefix + l));
      return lines.join("\n");
    });
  }

  render(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    let d: ElnData;
    try { d = parseElnYaml(source); }
    catch (e: any) { el.createDiv({ cls: "chemedit-error", text: `ELN: ${e?.message ?? e}` }); return; }
    const calc = calculateEln(d);
    const save = (mut: (d: ElnData) => void) => { mut(d); this.save(el, ctx, d); };
    const box = el.createDiv({ cls: "ce-eln" });

    // header
    const head = box.createDiv({ cls: "ce-eln-head" });
    const title = head.createDiv({ cls: "ce-eln-title" });
    title.createSpan({ cls: "ce-eln-code", text: d.code || ctx.sourcePath.split("/").pop()!.replace(/\.md$/, "") });
    if (d.title) title.createSpan({ cls: "ce-eln-sub", text: d.title });
    const status = head.createEl("button", { cls: `ce-eln-status ce-st-${(d.status ?? "Planned").toLowerCase().replace(/\s/g, "")}`, text: d.status ?? "Planned" });
    status.onclick = (e) => {
      const m = new Menu();
      for (const s of STATUSES) m.addItem((i) => i.setTitle(s).onClick(() => save((x) => { x.status = s; })));
      m.showAtMouseEvent(e);
    };
    const meta = box.createDiv({ cls: "ce-eln-meta" });
    for (const [k, v] of [["Project", d.project], ["Date", d.date]] as const) if (v) meta.createSpan({ text: `${k}: ${v}` });

    // scheme
    const sch = schemeDoc(d);
    const schemeEl = box.createDiv({ cls: "ce-eln-scheme" });
    if (sch) setSvg(schemeEl, this.plugin.svgFor(sch, { maxHeight: 220 }));
    else schemeEl.createDiv({ cls: "ce-eln-empty", text: "No structures yet — double-click to draw the reaction" });
    schemeEl.title = "Double-click to edit the reaction scheme";
    const editScheme = () => this.plugin.openEditor(sch ?? null, (r) => save((x) => applySchemeToData(x, r.doc)), { title: "Edit reaction scheme", saveLabel: "Update experiment" });
    schemeEl.addEventListener("dblclick", (e) => { e.preventDefault(); editScheme(); });

    // conditions line (editable)
    const cond = box.createDiv({ cls: "ce-eln-cond" });
    for (const [k, label] of [["solvent", "Solvent"], ["temperature", "Temp"], ["duration", "Time"], ["atmosphere", "Atm."]] as const) {
      const c = cond.createSpan({ cls: "ce-eln-chip" });
      c.createSpan({ cls: "ce-eln-chip-k", text: label });
      this.editable(c.createSpan({ cls: "ce-eln-chip-v", text: d[k] ?? "–" }), String(d[k] ?? ""), "text", (v) => save((x) => { if (v) x[k] = v; else delete x[k]; }));
    }
    if (calc.refMmol !== null) cond.createSpan({ cls: "ce-eln-chip ce-eln-calc", text: `Scale ${fmtMmol(calc.refMmol)}` });
    if (calc.concentration !== null) cond.createSpan({ cls: "ce-eln-chip ce-eln-calc", text: `c = ${calc.concentration.toFixed(calc.concentration < 0.1 ? 3 : 2)} M` });
    if (calc.atomEconomy !== null) cond.createSpan({ cls: "ce-eln-chip ce-eln-calc", text: `Atom economy ${calc.atomEconomy.toFixed(0)}%` });

    // stoichiometry table
    const wrap = box.createDiv({ cls: "ce-eln-tablewrap" });
    const t = wrap.createEl("table", { cls: "ce-eln-table" });
    const hr = t.createEl("thead").createEl("tr");
    for (const h of ["", "Compound", "MW", "eq", "n", "m (mg)", "V (mL)", "ρ / c", ""]) hr.createEl("th", { text: h });
    const tb = t.createEl("tbody");
    calc.rows.forEach((r) => this.reagentRow(tb, r, d, save));
    if (!calc.rows.length) tb.createEl("tr").createEl("td", { attr: { colspan: 9 }, cls: "ce-eln-empty", text: "No reagents yet" });

    // products
    const pt = wrap.createEl("table", { cls: "ce-eln-table ce-eln-prod" });
    const phr = pt.createEl("thead").createEl("tr");
    for (const h of ["", "Product", "MW", "Theory n", "Theory m", "Isolated (mg)", "Yield", ""]) phr.createEl("th", { text: h });
    const ptb = pt.createEl("tbody");
    for (const p of calc.products) {
      const tr = ptb.createEl("tr");
      this.thumbCell(tr, p.src.smiles, () => this.plugin.openEditor(p.src.smiles ?? null, (r) => save((x) => { x.products![p.index].smiles = r.smiles; delete x.products![p.index].mw; }), { title: "Edit product" }));
      const nameTd = tr.createEl("td");
      this.editable(nameTd.createDiv({ cls: "ce-eln-name", text: p.src.name || "(unnamed)" }), p.src.name ?? "", "text", (v) => save((x) => { x.products![p.index].name = v; }));
      if (p.formula) nameTd.createDiv({ cls: "ce-eln-formula", text: p.formula });
      tr.createEl("td", { text: p.mw ? p.mw.toFixed(2) : "–" });
      tr.createEl("td", { text: fmtMmol(p.theoryMmol) });
      tr.createEl("td", { text: fmtMass(p.theoryMass) });
      this.editable(tr.createEl("td", { cls: "ce-eln-input", text: p.src.mass_isolated !== undefined ? String(p.src.mass_isolated) : "—" }), String(p.src.mass_isolated ?? ""), "number", (v) => save((x) => { const pp = x.products![p.index]; if (v === "") delete pp.mass_isolated; else pp.mass_isolated = +v; delete pp.yield; }));
      const y = tr.createEl("td", { cls: "ce-eln-yield" });
      if (p.yieldPct !== null && isFinite(p.yieldPct)) {
        y.setText(p.yieldPct.toFixed(0) + "%");
        y.addClass(p.yieldPct >= 70 ? "ce-good" : p.yieldPct >= 30 ? "ce-mid" : "ce-bad");
      } else y.setText("–");
      const act = tr.createEl("td", { cls: "ce-eln-act" });
      const mb = act.createEl("button", { cls: "clickable-icon", text: "⋯" });
      mb.onclick = (e) => {
        const m = new Menu();
        m.addItem((i) => i.setTitle("Edit structure").setIcon("pencil").onClick(() => this.plugin.openEditor(p.src.smiles ?? null, (r) => save((x) => { x.products![p.index].smiles = r.smiles; delete x.products![p.index].mw; }))));
        if (p.src.smiles) m.addItem((i) => i.setTitle("Copy characterization template").setIcon("clipboard").onClick(async () => { await navigator.clipboard.writeText(characterizationTemplate(String(p.src.smiles))); new Notice("Characterization template copied (HRMS calcd, EA…)"); }));
        if (p.src.smiles) m.addItem((i) => i.setTitle("Predict NMR → Analytical Data").setIcon("activity").onClick(async () => {
          const f = this.plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
          if (f instanceof TFile) await insertIntoNote(this.plugin.app, f, nmrBlock(String(p.src.smiles), "both", p.src.name ? `name: ${p.src.name}\n` : "").trimEnd(), "analytical");
        }));
        m.addItem((i) => i.setTitle("Remove product").setIcon("trash").onClick(() => save((x) => { x.products!.splice(p.index, 1); })));
        m.showAtMouseEvent(e);
      };
    }
    if (!calc.products.length) ptb.createEl("tr").createEl("td", { attr: { colspan: 8 }, cls: "ce-eln-empty", text: "No product yet" });

    for (const w of calc.warnings) box.createDiv({ cls: "ce-eln-warn", text: "⚠ " + w });

    // actions
    const bar = box.createDiv({ cls: "ce-eln-bar" });
    const btn = (label: string, fn: (e: MouseEvent) => void) => { const b = bar.createEl("button", { text: label }); b.onclick = fn; return b; };
    btn("+ Reagent", (e) => {
      const m = new Menu();
      const add = (role: Role) => (c: ElnCompound) => save((x) => { x.reactants!.push({ ...c, role: role === "reactant" ? undefined : role, eq: role === "solvent" ? undefined : c.eq ?? 1 }); });
      m.addItem((i) => i.setTitle("Draw structure…").setIcon("hexagon").onClick(() => this.plugin.openEditor(null, (r) => add("reactant")({ name: "", smiles: r.smiles }), { title: "New reagent", saveLabel: "Add" })));
      m.addItem((i) => i.setTitle("From name or SMILES…").setIcon("search").onClick(() => this.addByName((c) => add("reactant")(c))));
      m.addItem((i) => i.setTitle("From library / inventory…").setIcon("library").onClick(() => new CompoundPicker(this.plugin, (c) => add("reactant")({ name: c.name, ...(c.smiles ? { smiles: c.smiles } : {}), ...(c.cas ? { cas: c.cas } : {}), ...(c.lot ? { lot: c.lot } : {}) })).open()));
      m.addItem((i) => i.setTitle("Reagent / catalyst (above arrow)…").setIcon("flask-conical").onClick(() => this.addByName((c) => add("reagent")(c))));
      m.addItem((i) => i.setTitle("Solvent…").setIcon("droplet").onClick(() => new PromptModal(this.plugin.app, "Solvent", "e.g. THF, 5 mL → name then edit volume", "", (v) => add("solvent")({ name: v })).open()));
      m.showAtMouseEvent(e);
    });
    btn("+ Product", () => this.plugin.openEditor(null, (r) => save((x) => { x.products!.push({ name: "", smiles: r.smiles, eq: 1 }); }), { title: "New product", saveLabel: "Add" }));
    btn("Edit scheme", () => editScheme());
    this.labBookBar(box, el, ctx, d, calc);
    btn("Copy table", async () => {
      const lines = ["Role\tCompound\tSMILES\tMW\teq\tmmol\tmass (mg)\tvolume (mL)"];
      for (const r of calc.rows) lines.push([r.role, r.src.name ?? "", r.src.smiles ?? "", r.mw?.toFixed(2) ?? "", r.eq ?? "", r.mmol?.toFixed(3) ?? "", r.mass?.toFixed(2) ?? "", r.volume?.toFixed(3) ?? ""].join("\t"));
      for (const p of calc.products) lines.push(["product", p.src.name ?? "", p.src.smiles ?? "", p.mw?.toFixed(2) ?? "", "", p.theoryMmol?.toFixed(3) ?? "", p.isoMass?.toFixed(2) ?? "", p.yieldPct !== null ? p.yieldPct.toFixed(1) + "%" : ""].join("\t"));
      await navigator.clipboard.writeText(lines.join("\n"));
      new Notice("Table copied (paste into Excel)");
    });
  }

  private labBookBar(box: HTMLElement, el: HTMLElement, ctx: MarkdownPostProcessorContext, d: ElnData, calc: ElnCalc) {
    const file = this.plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile)) return;
    const lc: ElnCtx = { plugin: this.plugin, file, data: d, calc };
    const bar = box.createDiv({ cls: "ce-eln-bar ce-eln-lb" });
    const b = (icon: string, text: string, fn: () => void, title?: string) => {
      const x = bar.createEl("button", { cls: "ce-eln-lbbtn", attr: { "aria-label": title ?? text } });
      setIcon(x.createSpan(), icon);
      x.createSpan({ text });
      x.onclick = (e) => { e.preventDefault(); fn(); };
    };
    b("list-plus", "Step", () => new StepModal(lc, "experimental").open(), "Add numbered step (reagent phrases, time stamps)");
    b("eye", "Observe", () => new StepModal(lc, "experimental", true).open(), "Observation");
    b("clock", "Time", () => insertIntoNote(this.plugin.app, file, `(${/start/i.test(d.status ?? "") || d.status === "Running" ? "End" : "Start"}: ${nowHM()})`, "experimental", { date: true }), "Insert Start/End time stamp");
    b("scan-line", "TLC", () => new TlcModal(lc).open(), "TLC photo → Rf");
    b("camera", "Photo", () => new PhotoModal(lc).open());
    b("filter", "Work-up", () => new StepModal(lc, "workup").open());
    b("columns-3", "Column", () => new ColumnModal(lc).open());
    b("snowflake", "Recryst.", () => new RecrystModal(lc).open());
    b("table", "Analytics", () => new AnalyticsModal(lc).open());
    b("alert-triangle", "Risks", () => new RisksModal(lc).open());
    b("wrench", "Equipment", () => new EquipmentModal(lc).open());
    if (d.type === "electrochemistry" || d.charge_F !== undefined) b("zap", "Electrolysis", () => new ElectroModal(lc).open());
    b("flag", "Conclusion", () => new ConclusionModal(lc).open());
    b("calculator", "Calculator", () => new CalcPicker(this.plugin.app, async (block) => { await this.plugin.app.vault.process(file, insertInSection(block.trimEnd(), "experimental")); }).open(), "Insert a lab calculator into this note");
    b("git-fork", "Map", () => this.plugin.openLab("synthesis", file.path), "Show this experiment in the synthesis map");
    b("arrow-right-circle", "Next step", () => this.nextStep(file, d, calc), "New experiment using this product as starting material");
    const st = bar.createEl("select", { cls: "dropdown ce-eln-stsel" });
    for (const v of STATUSES) st.createEl("option", { value: v, text: v });
    st.value = d.status ?? "Planned";
    st.onchange = () => { d.status = st.value; if (st.value === "Running" && !d.started) d.started = new Date().toISOString().slice(0, 16).replace("T", " "); this.save(el, ctx, d); };
  }

  private nextStep(file: TFile, d: ElnData, calc: ElnCalc) {
    const p = calc.products.find((x) => x.src.smiles || x.src.name);
    if (!p) { new Notice("Add a product first"); return; }
    this.plugin.newExperiment(undefined, {
      project: d.project, previous: `[[${file.basename}]]`,
      reactants: [{ name: p.src.name ?? "starting material", ...(p.src.smiles ? { smiles: p.src.smiles } : {}), eq: 1, is_limiting: true, ...(p.isoMmol ? { mmol: +p.isoMmol.toFixed(3) } : {}) }],
      products: [],
    } as ElnData);
  }

  private addByName(onOk: (c: ElnCompound) => void) {
    new PromptModal(this.plugin.app, "Add compound", "Name (e.g. benzaldehyde) or SMILES", "", async (v) => {
      let smi: string | null = null;
      try { parseAny(v, "smiles"); smi = v; } catch { /* not SMILES */ }
      if (!smi && this.plugin.settings.nameLookup) { new Notice("Looking up " + v + "…"); smi = await this.plugin.resolveName(v); }
      if (!smi) { new Notice(`Could not resolve “${v}” — added by name only`); onOk({ name: v }); return; }
      onOk({ name: smi === v ? "" : v, smiles: smi });
    }).open();
  }

  private thumbCell(tr: HTMLElement, smiles: string | undefined, onEdit: () => void) {
    const td = tr.createEl("td", { cls: "ce-eln-thumb" });
    if (smiles) {
      try { setSvg(td, this.plugin.svgFor(parseAny(String(smiles)), { maxHeight: 44, padding: 2 })); } catch { td.setText("?"); }
    } else td.setText("+");
    td.title = "Double-click to draw / edit";
    td.addEventListener("dblclick", (e) => { e.preventDefault(); onEdit(); });
  }

  private reagentRow(tb: HTMLElement, r: CalcRow, d: ElnData, save: (m: (d: ElnData) => void) => void) {
    const tr = tb.createEl("tr", { cls: `ce-role-${r.role}` + (r.limiting ? " ce-limiting" : "") });
    const at = (x: ElnData) => x.reactants![r.index];
    this.thumbCell(tr, r.src.smiles, () => this.plugin.openEditor(r.src.smiles ?? null, (res) => save((x) => { at(x).smiles = res.smiles; delete at(x).mw; }), { title: "Edit structure" }));
    const nameTd = tr.createEl("td");
    const nm = nameTd.createDiv({ cls: "ce-eln-name", text: r.src.name || r.formula || "(unnamed)" });
    this.editable(nm, r.src.name ?? "", "text", (v) => save((x) => { at(x).name = v; }));
    const tags = nameTd.createDiv({ cls: "ce-eln-formula" });
    tags.setText([r.limiting ? "limiting" : r.role !== "reactant" ? r.role : "", r.src.name && r.formula ? r.formula : ""].filter(Boolean).join(" · "));
    tr.createEl("td", { text: r.mw ? r.mw.toFixed(2) : "–" });
    const numEdit = (cell: HTMLElement, key: keyof ElnCompound, shown: string, raw: any) => {
      cell.setText(shown);
      this.editable(cell, raw === undefined || raw === null ? "" : String(raw), "number", (v) => save((x) => {
        const c = at(x);
        if (v === "") delete c[key as string]; else c[key as string] = +v;
        // a measured amount on the limiting reagent defines the scale; clear conflicting inputs
        if (["mass", "volume", "mmol"].includes(key as string) && v !== "") {
          for (const o of ["mass", "volume", "mmol"]) if (o !== key) delete c[o];
          if (!r.limiting) { for (const rr of x.reactants!) delete rr.is_limiting; c.is_limiting = true; }
        }
      }));
      cell.addClass("ce-eln-input");
    };
    if (r.role === "solvent") {
      tr.createEl("td", { text: "" }); tr.createEl("td", { text: "" }); tr.createEl("td", { text: "" });
      const v = tr.createEl("td"); numEdit(v, "volume", r.volume !== null ? fmtVol(r.volume) : "—", r.src.volume);
      tr.createEl("td", { text: "" });
    } else {
      const eqTd = tr.createEl("td"); numEdit(eqTd, "eq", fmtEq(r), r.src.eq ?? 1);
      tr.createEl("td", { text: fmtMmol(r.mmol) });
      const mTd = tr.createEl("td"); numEdit(mTd, "mass", fmtMass(r.mass), r.src.mass ?? (r.mass !== null ? +r.mass.toFixed(2) : ""));
      const vTd = tr.createEl("td"); numEdit(vTd, "volume", r.volume !== null ? fmtVol(r.volume) : "–", r.src.volume ?? (r.volume !== null ? +r.volume.toFixed(3) : ""));
      const dc = tr.createEl("td");
      dc.setText(r.src.molarity ? `${r.src.molarity} M` : r.src.density ? `${r.src.density} g/mL` : "–");
      dc.addClass("ce-eln-input");
      dc.title = "Double-click: density (g/mL) — or type e.g. '2.5 M' for a solution";
      this.editable(dc, r.src.molarity ? `${r.src.molarity} M` : String(r.src.density ?? ""), "text", (v) => save((x) => {
        const c = at(x);
        delete c.molarity; delete c.density;
        const m = /^([\d.,]+)\s*(m|mol\/l)?$/i.exec(v.trim());
        if (!m) return;
        const val = parseFloat(m[1].replace(",", "."));
        if (m[2]) c.molarity = val; else c.density = val;
      }));
    }
    const act = tr.createEl("td", { cls: "ce-eln-act" });
    const mb = act.createEl("button", { cls: "clickable-icon", text: "⋯" });
    mb.onclick = (e) => {
      const m = new Menu();
      if (r.role !== "solvent") m.addItem((i) => i.setTitle("Set as limiting reagent").setIcon("target").onClick(() => save((x) => { for (const rr of x.reactants!) delete rr.is_limiting; at(x).is_limiting = true; })));
      for (const role of ["reactant", "reagent", "catalyst", "solvent"] as Role[]) {
        if (role !== r.role) m.addItem((i) => i.setTitle(`Mark as ${role}`).onClick(() => save((x) => { if (role === "reactant") delete at(x).role; else at(x).role = role; })));
      }
      m.addItem((i) => i.setTitle("Purity (%)…").onClick(() => new PromptModal(this.plugin.app, "Purity (%)", "e.g. 97", String(r.src.purity ?? ""), (v) => save((x) => { at(x).purity = parseFloat(v); })).open()));
      m.addItem((i) => i.setTitle("Edit structure").setIcon("pencil").onClick(() => this.plugin.openEditor(r.src.smiles ?? null, (res) => save((x) => { at(x).smiles = res.smiles; delete at(x).mw; }))));
      m.addItem((i) => i.setTitle("Remove").setIcon("trash").onClick(() => save((x) => { x.reactants!.splice(r.index, 1); })));
      m.showAtMouseEvent(e);
    };
  }

  /** Double-click (or tap on mobile) to edit a value in place. */
  private editable(cell: HTMLElement, raw: string, type: "text" | "number", commit: (v: string) => void) {
    cell.addClass("ce-eln-editable");
    const start = (e: Event) => {
      e.preventDefault(); e.stopPropagation();
      if (cell.querySelector("input")) return;
      const old = Array.from(cell.childNodes);
      cell.empty();
      const inp = cell.createEl("input", { type: "text", value: raw });
      inp.inputMode = type === "number" ? "decimal" : "text";
      inp.className = "ce-eln-cellinput";
      inp.focus(); inp.select();
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return; done = true;
        const v = inp.value.trim().replace(",", ".");
        if (!ok || v === raw) { cell.empty(); cell.append(...old); return; }
        if (type === "number" && v !== "" && !isFinite(+v)) { cell.empty(); cell.append(...old); new Notice("Please enter a number"); return; }
        commit(v);
      };
      inp.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") finish(true); if (ev.key === "Escape") finish(false); });
      inp.addEventListener("blur", () => finish(true));
    };
    cell.addEventListener("dblclick", start);
    cell.addEventListener("click", (e) => { if ((document.body.classList.contains("is-mobile"))) start(e); });
  }

  // ------------------------------------------------------------------ index block
  async renderList(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    let cfg: any = {};
    try { cfg = parseYaml(source) ?? {}; } catch { /* */ }
    const folder: string = (cfg.folder ?? cfg.path ?? this.plugin.settings.elnFolder ?? "").replace(/\/$/, "");
    const statusFilter: string | undefined = cfg.status;
    const files = this.plugin.app.vault.getMarkdownFiles().filter((f) => !folder || f.path.startsWith(folder + "/"));
    const rows: Array<{ f: TFile; d: ElnData; calc: ReturnType<typeof calculateEln> }> = [];
    for (const f of files) {
      const txt = await this.plugin.app.vault.cachedRead(f);
      const m = /```eln\s*\n([\s\S]*?)\n```/.exec(txt);
      if (!m) continue;
      try { const d = parseElnYaml(m[1]); if (statusFilter && d.status !== statusFilter) continue; rows.push({ f, d, calc: calculateEln(d) }); } catch { /* skip */ }
    }
    rows.sort((a, b) => (b.d.date ?? "").localeCompare(a.d.date ?? "") || b.f.stat.mtime - a.f.stat.mtime);
    const box = el.createDiv({ cls: "ce-eln ce-eln-list" });
    const head = box.createDiv({ cls: "ce-eln-head" });
    head.createSpan({ cls: "ce-eln-code", text: `Experiments${folder ? " · " + folder : ""}` });
    const nb = head.createEl("button", { text: "+ New experiment" });
    nb.onclick = () => this.plugin.newExperiment(folder || undefined);
    const t = box.createDiv({ cls: "ce-eln-tablewrap" }).createEl("table", { cls: "ce-eln-table" });
    const hr = t.createEl("thead").createEl("tr");
    for (const h of ["Code", "Product", "Project", "Yield", "Status", "Date"]) hr.createEl("th", { text: h });
    const tb = t.createEl("tbody");
    for (const { f, d, calc } of rows) {
      const tr = tb.createEl("tr");
      const a = tr.createEl("td").createEl("a", { cls: "internal-link", text: d.code || f.basename });
      a.onclick = (e) => { e.preventDefault(); this.plugin.app.workspace.getLeaf(false).openFile(f); };
      const p = calc.products[0];
      const th = tr.createEl("td", { cls: "ce-eln-thumb" });
      if (p?.src.smiles) { try { setSvg(th, this.plugin.svgFor(parseAny(String(p.src.smiles)), { maxHeight: 50, padding: 2 })); } catch { /* */ } }
      tr.createEl("td", { text: d.project ?? "" });
      tr.createEl("td", { text: p?.yieldPct !== null && p?.yieldPct !== undefined && isFinite(p.yieldPct) ? p.yieldPct.toFixed(0) + "%" : "–" });
      tr.createEl("td").createSpan({ cls: `ce-eln-status ce-st-${(d.status ?? "Planned").toLowerCase().replace(/\s/g, "")}`, text: d.status ?? "Planned" });
      tr.createEl("td", { text: d.date ?? "" });
    }
    if (!rows.length) tb.createEl("tr").createEl("td", { attr: { colspan: 6 }, cls: "ce-eln-empty", text: "No experiments found" });
  }
}

export type TemplateKind = "classic" | "electro" | "legacy";

export function experimentTemplate(code: string, date: string, data: ElnData, sections: string[], kind: TemplateKind = "classic"): string {
  const prod = data.products?.find((p) => p.smiles);
  const charact = prod?.smiles ? characterizationTemplate(String(prod.smiles)) : sections.map((s) => `- **${s}:** `).join("\n");
  const block = "```eln\n" + elnYaml({ code, date, status: "Planned", ...(kind === "electro" ? { type: "electrochemistry", charge_F: 2.0, current_mA: 5, electrolyte: "nBu₄NBF₄", electrolyte_M: 0.05, anode: "graphite", cathode: "graphite" } : {}), ...data }).replace(/\n$/, "") + "\n```";
  const fm = `---\ntags: [experiment]\ndate: ${date}\nproject: ${data.project ?? ""}\nstatus: Planned\n---\n\n`;
  if (kind === "legacy") return `${fm}${block}\n\n## Aim\n\n\n## Procedure\n1.\n\n## Observations\n\n\n## TLC / Work-up\n\n\n## Characterization\n${charact}\n\n## Conclusion\n\n`;
  const hz = suggestHazards({ code, ...data });
  const risks = hz.length ? hz.map((h) => "- " + h.text).join("\n") : "- ";
  const electro = kind === "electro"
    ? "\n- Electrochemical set-up: undivided cell, constant current; electrodes cleaned/polished before use.\n- Power supply / potentiostat: \n- Supporting electrolyte dried under vacuum before use.\n"
    : "";
  return `${fm}${block}

## General Remarks
**Purpose:** 
**Literature:** 
**Risks & quenching:**
${risks}

## Chemicals & Equipment
- Glassware: 
- Inert gas: 
- Anhydrous solvents: ${electro}

## Experimental
**${dateStamp()}**

## Work-up/Purification


## Analytical Data
| ¹H NMR | ¹³C NMR | TLC (SiO₂) | HPLC (RP-C18) | GC |
|---|---|---|---|---|
|  |  |  |  |  |

✓ = analysis done; ✗ = analysis not applicable.

${charact}

## Conclusion

`;
}

export async function createExperimentFile(app: App, folder: string, code: string, content: string): Promise<TFile> {
  const dir = normalizePath(folder || "/");
  if (dir !== "/" && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
  const safe = code.replace(/[\\/:*?"<>|]/g, "-");
  let path = normalizePath(`${dir === "/" ? "" : dir + "/"}${safe}.md`);
  let n = 1;
  while (app.vault.getAbstractFileByPath(path)) path = normalizePath(`${dir === "/" ? "" : dir + "/"}${safe}-${n++}.md`);
  return app.vault.create(path, content);
}

export function nextExperimentCode(app: App, folder: string, prefix: string): string {
  const re = new RegExp(`^${prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}-?(\\d+)`);
  let max = 0;
  for (const f of app.vault.getMarkdownFiles()) {
    if (folder && !f.path.startsWith(folder + "/")) continue;
    const m = re.exec(f.basename);
    if (m) max = Math.max(max, parseInt(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

/** ELN data skeleton from a reaction drawn in the editor. */
export function elnFromDoc(doc: ChemDoc): ElnData {
  const d: ElnData = { reactants: [], products: [] };
  applySchemeToData(d, doc);
  if (d.reactants!.length) d.reactants![0].is_limiting = true;
  return d;
}
