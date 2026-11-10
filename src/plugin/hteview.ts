// Visual HTE planner (```chem-calc  type: hte). Tabs: Plan · Plate · Recipe · Results.
// Designed for small, fast screens (4–24 vials) with stock-solution maths, a prep step
// (e.g. in-situ Finkelstein), plate map, pipetting sheet, HPLC assay yields and Bayesian next-batch suggestions.

import { Menu, Notice, setIcon } from "obsidian";
import type ChemEditPlugin from "./main";
import { HteData, HFactor, HFixed, HLevel, HRun, HComp, PLATES, wellIds, lvl, combos, balancedSubset, ofat, recipe, prepInfo, runYield, mainEffects, suggestBO, mlCsv, Recipe, planChecks, timepoints, resOf, HTE_PRESETS, isNumericFactor } from "../chem/hte";
import { mwOf, fmtNum } from "./calcview";
import { parseAny } from "../chem/index";

const UI = new Map<string, { tab: string; well: string | null; colorBy: string; hl?: string }>();
const COLORS = ["#4f7cff", "#e8743b", "#19a979", "#d64ea8", "#9a6cff", "#d9a400", "#13a4b4", "#bf3a3a", "#6a8f2a", "#945ecf", "#555"];
const heat = (y: number) => { const t = Math.max(0, Math.min(1, y / 100)); const h = 5 + t * 125; return `hsl(${h} 70% ${48 - t * 6}%)`; };

export class HteView {
  private d: HteData;
  private ui: { tab: string; well: string | null; colorBy: string; hl?: string };
  private box!: HTMLElement;
  constructor(raw: any, private save: () => void, uiKey: string, private plugin?: ChemEditPlugin) {
    this.d = raw as HteData;
    const d = this.d;
    d.type = "hte";
    d.fixed = d.fixed ?? []; d.factors = d.factors ?? []; d.runs = d.runs ?? [];
    if (!d.plate) d.plate = "6";
    d.plate = String(d.plate);
    if (!UI.has(uiKey)) UI.set(uiKey, { tab: d.runs.length ? "plate" : "plan", well: null, colorBy: d.factors[0]?.name ?? "" });
    this.ui = UI.get(uiKey)!;
  }

  private using = (fn: string | null, ln: string | null, comp?: string) => {
    const runs = this.d.runs!.filter((r) => !r.skip);
    if (comp) return runs.filter((r) => (this.d.factors ?? []).some((f) => ((f.levels.map(lvl).find((l) => l.name === r.f[f.name])?.components as HComp[] | undefined) ?? []).some((c) => c.name === comp))).length;
    return fn ? runs.filter((r) => r.f[fn] === ln).length : runs.length;
  };
  private recipeFor = (f: Record<string, string>) => recipe(this.d, f, mwOf, this.using);

  private checks(el: HTMLElement, onlyWarn = false) {
    const cs = planChecks(this.d, this.recipeFor).filter((c) => !onlyWarn || c.k === "warn");
    if (!cs.length) return;
    const box = el.createDiv({ cls: "ce-hte-checks" });
    for (const c of cs) { const r = box.createDiv({ cls: `ce-hte-check is-${c.k}` }); setIcon(r.createSpan(), c.k === "warn" ? "alert-triangle" : c.k === "ok" ? "check-circle-2" : "lightbulb"); r.createSpan({ text: c.t }); }
  }

  /** pick a compound from the Lab compounds library / inventory (name, SMILES, MW) */
  private fromInventory(onPick: (c: { name: string; smiles?: string; mw?: number }) => void) {
    if (!this.plugin) { new Notice("Inventory not available here"); return; }
    import("./lab").then(({ CompoundPicker }) => new CompoundPicker(this.plugin!, (c: any) => onPick({ name: c.name, ...(c.smiles ? { smiles: c.smiles } : {}), ...(c.mw ? { mw: +c.mw } : {}) })).open());
  }

  /** convert the old matrix-eln / type: matrix format */
  static fromMatrix(m: any): HteData {
    const factors: HFactor[] = Object.entries(m.variables ?? {}).map(([k, v]: [string, any]) => ({ name: k, levels: (Array.isArray(v) ? v : String(v).split(",")).map((x: any) => (typeof x === "object" ? x : { name: String(x).trim() })) }));
    const runs: HRun[] = [];
    const ids = wellIds("96");
    combos(factors).forEach((f, i) => runs.push({ well: ids[i], batch: 1, f, yield: Array.isArray(m.yields) ? m.yields[i] ?? null : null }));
    return { type: "hte", title: m.title, plate: runs.length <= 6 ? "6" : runs.length <= 12 ? "12" : runs.length <= 24 ? "24" : runs.length <= 48 ? "48" : "96", scale_mmol: m.scale_mmol ?? 0.05, volume_ul: m.vol_per_vial_ul ?? 500, overage_percent: m.overage_percent ?? 10, fixed: (m.fixed_components ?? []).map((c: any) => ({ name: c.name, mw: c.mw, eq: c.eq })), factors, runs };
  }

  render(box: HTMLElement) {
    this.box = box;
    box.empty();
    box.addClass("ce-calc", "ce-hte");
    const d = this.d;
    const head = box.createDiv({ cls: "ce-calc-head" });
    setIcon(head.createSpan({ cls: "ce-calc-icon" }), "grid-3x3");
    const tw = head.createDiv({ cls: "ce-calc-titles" });
    const ti = tw.createEl("input", { type: "text", cls: "ce-calc-title", value: d.title ?? "", attr: { placeholder: "HTE screen" } });
    ti.onchange = () => { d.title = ti.value.trim() || undefined; this.save(); };
    const nRes = d.runs!.filter((r) => runYield(d, r) !== null).length;
    tw.createDiv({ cls: "ce-calc-sub", text: `HTE planner · ${PLATES[String(d.plate)]?.label ?? d.plate} · ${d.runs!.length} reactions · ${nRes} results · ${combos(d.factors!).length} possible combinations` });
    const tb = head.createDiv({ cls: "ce-calc-actions" });
    const pb = tb.createEl("button", { cls: "ce-hte-preset", attr: { "aria-label": "Start from a template" } });
    setIcon(pb.createSpan(), "layout-template"); pb.createSpan({ text: "Templates" });
    pb.onclick = (e) => {
      const m = new Menu();
      for (const p of HTE_PRESETS) m.addItem((i) => i.setTitle(`${p.title} — ${p.desc}`).onClick(() => { const keep = this.d.runs!.length && !confirmReplace(); if (keep) return; for (const k of Object.keys(this.d)) delete (this.d as any)[k]; Object.assign(this.d, JSON.parse(JSON.stringify(p.data))); this.ui.tab = "plan"; this.save(); }));
      m.showAtMouseEvent(e);
    };
    this.scheme(box);
    const tabs = box.createDiv({ cls: "ce-hte-tabs" });
    for (const [id, l, ic] of [["plan", "Plan", "clipboard-list"], ["plate", "Plate", "grid-3x3"], ["recipe", "Recipe", "flask-conical"], ["results", "Results & next", "sparkles"]] as const) {
      const b = tabs.createEl("button", { cls: "ce-hte-tab" + (this.ui.tab === id ? " is-on" : "") });
      setIcon(b.createSpan(), ic); b.createSpan({ text: l });
      b.onclick = () => { this.ui.tab = id; this.render(box); };
    }
    const body = box.createDiv({ cls: "ce-hte-body" });
    if (this.ui.tab === "plan") this.plan(body);
    else if (this.ui.tab === "plate") this.plate(body);
    else if (this.ui.tab === "recipe") this.recipeTab(body);
    else this.results(body);
  }

  // ---------------------------------------------------------------- reaction scheme (ELN style)
  private svgCache = new Map<string, string>();
  private struct(el: HTMLElement, smiles: string | undefined, h: number) {
    if (!smiles || !this.plugin) return false;
    const k = smiles + "|" + h;
    if (!this.svgCache.has(k)) { try { this.svgCache.set(k, this.plugin.svgFor(parseAny(smiles), { maxHeight: h, padding: 2 })); } catch { this.svgCache.set(k, ""); } }
    const svg = this.svgCache.get(k)!;
    if (svg) el.innerHTML = svg;
    return !!svg;
  }
  private levelSmiles(L: HLevel): string | undefined {
    if (L.smiles) return L.smiles;
    const comps = (L.components as HComp[] | undefined) ?? [];
    return (comps.find((c) => /lig/i.test(c.role ?? "") && c.smiles) ?? comps.find((c) => c.smiles))?.smiles;
  }

  private scheme(box: HTMLElement) {
    const d = this.d;
    const sc = box.createDiv({ cls: "ce-hte-scheme" });
    const row = sc.createDiv({ cls: "ce-hte-srow" });
    const eqTxt = (eq?: number) => (eq !== undefined ? `${+(+eq).toFixed(2)} eq` : "");
    // reactants: fixed components with a structure (not added after)
    const reactants = (d.fixed ?? []).filter((c) => c.smiles && !c.after);
    if (d.prep?.product_smiles && !reactants.some((c) => c.smiles === d.prep!.product_smiles)) reactants.push({ name: d.prep.product ?? "prep product", smiles: d.prep.product_smiles, from_prep: true });
    reactants.forEach((c, i) => {
      if (i) row.createDiv({ cls: "ce-hte-plus", text: "+" });
      const card = row.createDiv({ cls: "ce-hte-mol" + (c.limiting ? " is-limiting" : "") });
      const st = card.createDiv({ cls: "ce-hte-molsvg" });
      if (!this.struct(st, c.smiles, 74)) st.setText(c.name);
      card.createDiv({ cls: "ce-hte-molname", text: c.name.replace(/\s*\(.*?\)\s*/g, " ").trim() });
      card.createDiv({ cls: "ce-hte-moleq", text: [eqTxt(c.eq), c.limiting ? "limiting" : ""].filter(Boolean).join(" · ") });
    });
    if (!reactants.length) row.createDiv({ cls: "ce-hte-hint", text: "Add SMILES to the fixed components (or the prep product) to draw the scheme." });
    // arrow with conditions
    const arr = row.createDiv({ cls: "ce-hte-arrow" });
    const above = arr.createDiv({ cls: "ce-hte-above" });
    for (const f of (d.factors ?? []).filter((x) => !x.param)) above.createSpan({ cls: "ce-hte-var", text: f.name });
    for (const c of (d.fixed ?? []).filter((x) => !x.smiles && !x.after && !x.from_prep)) above.createSpan({ cls: "ce-hte-reag", text: `${c.name.replace(/\s*\(.*?\)\s*/g, " ").trim()} (${eqTxt(c.eq)})` });
    arr.createDiv({ cls: "ce-hte-line" });
    const below = arr.createDiv({ cls: "ce-hte-below" });
    const params = (d.factors ?? []).filter((x) => x.param);
    const cond = [d.solvent, ...params.map((f) => `[${f.name}]`), !params.some((f) => f.param === "temperature") ? d.temperature : "", !params.some((f) => f.param === "time") ? d.time : "", d.atmosphere].filter(Boolean);
    if (d.scale_mmol && d.volume_ul && !params.some((f) => f.param === "conc_M" || f.param === "volume_ul")) cond.push(`${(d.scale_mmol / (d.volume_ul / 1000)).toFixed(2)} M`);
    below.setText(cond.join(", "));
    // product
    const pc = row.createDiv({ cls: "ce-hte-mol is-product" });
    const ps = pc.createDiv({ cls: "ce-hte-molsvg" });
    if (!this.struct(ps, d.product?.smiles, 74)) ps.createDiv({ cls: "ce-hte-hint", text: this.plugin ? "tap to draw product" : "product" });
    pc.createDiv({ cls: "ce-hte-molname", text: d.product?.name ?? "product" });
    const ys = (d.runs ?? []).map((r) => runYield(d, r)).filter((y): y is number => y !== null);
    if (ys.length) pc.createDiv({ cls: "ce-hte-moleq", text: `best ${Math.max(...ys).toFixed(0)}% (${ys.length} results)` });
    if (this.plugin) { pc.addClass("is-click"); pc.onclick = () => this.plugin!.openEditor(d.product?.smiles ?? null, (r) => { d.product = { ...(d.product ?? {}), smiles: r.smiles }; this.save(); }, { title: "Product" }); }
    // variables strip
    const me = mainEffects(d);
    for (const [fi, f] of (d.factors ?? []).entries()) {
      const vs = sc.createDiv({ cls: "ce-hte-vars" });
      vs.createDiv({ cls: "ce-hte-varh", text: f.name + (f.param ? "" : " (variable)") });
      const strip = vs.createDiv({ cls: "ce-hte-varstrip" });
      f.levels.map(lvl).forEach((L, li) => {
        const chip = strip.createDiv({ cls: "ce-hte-level" + (this.ui.colorBy === f.name && this.ui.hl === L.name ? " is-on" : "") });
        chip.setCssStyles({ borderTopColor: COLORS[li % COLORS.length] });
        const sv = chip.createDiv({ cls: "ce-hte-levelsvg" });
        if (!this.struct(sv, this.levelSmiles(L), 48)) sv.createDiv({ cls: "ce-hte-levelbig", text: f.param ? L.name : L.name.replace(/^NiBr2·glyme \+ /, "").slice(0, 14) });
        chip.createDiv({ cls: "ce-hte-levelname", text: L.name });
        const best = me.find((m) => m.factor === f.name)?.levels.find((x) => x.name === L.name);
        if (best?.best !== null && best?.best !== undefined) chip.createDiv({ cls: "ce-hte-levely", text: `${best.best.toFixed(0)}%` }).setCssStyles({ background: heat(best.best) });
        const n = (d.runs ?? []).filter((r) => r.f[f.name] === L.name).length;
        if (n) chip.createDiv({ cls: "ce-hte-leveln", text: `${n}×` });
        chip.onclick = () => { this.ui.colorBy = f.name; this.ui.hl = this.ui.hl === L.name ? undefined : L.name; this.ui.tab = "plate"; this.render(this.box); };
      });
      void fi;
    }
  }

  // ---------------------------------------------------------------- inputs
  private inp(parent: HTMLElement, obj: any, k: string, ph: string, kind: "num" | "text" = "num", cls = "") {
    const i = parent.createEl("input", { type: "text", cls: "ce-calc-in " + (kind === "num" ? "is-num " : "") + cls, value: obj[k] ?? "", attr: { placeholder: ph, "aria-label": ph } });
    if (kind === "num") i.inputMode = "decimal";
    i.onchange = () => { const v = i.value.trim(); if (!v) delete obj[k]; else obj[k] = kind === "num" ? (isFinite(+v.replace(",", ".")) ? +v.replace(",", ".") : v) : v; this.save(); };
    i.onkeydown = (e) => { if (e.key === "Enter") i.blur(); };
    return i;
  }
  private chk(parent: HTMLElement, obj: any, k: string, label: string) {
    const l = parent.createEl("label", { cls: "ce-hte-chk" });
    const c = l.createEl("input", { type: "checkbox" });
    c.checked = !!obj[k];
    c.onchange = () => { if (c.checked) obj[k] = true; else delete obj[k]; this.save(); };
    l.appendText(label);
  }
  private field(grid: HTMLElement, label: string, unit: string, obj: any, k: string, kind: "num" | "text" = "num", ph = "") {
    const w = grid.createDiv({ cls: "ce-calc-field" });
    const lab = w.createDiv({ cls: "ce-calc-fl" }); lab.createSpan({ text: label }); if (unit) lab.createSpan({ cls: "ce-calc-fu", text: unit });
    this.inp(w, obj, k, ph || label, kind);
  }

  // ---------------------------------------------------------------- PLAN
  private plan(el: HTMLElement) {
    const d = this.d;
    this.checks(el);
    if (d.notes) el.createDiv({ cls: "ce-hte-info", text: "📝 " + d.notes });
    const sec = (t: string, hint?: string) => { const s = el.createDiv({ cls: "ce-hte-sec" }); const h = s.createDiv({ cls: "ce-hte-sech" }); h.createSpan({ text: t }); if (hint) h.createSpan({ cls: "ce-hte-hint", text: hint }); return s; };
    // scale
    const s1 = sec("1 · Scale & format", "per well, relative to the limiting reagent");
    const g = s1.createDiv({ cls: "ce-calc-fields" });
    const pw = g.createDiv({ cls: "ce-calc-field" });
    pw.createDiv({ cls: "ce-calc-fl", text: "Plate / vials" });
    const ps = pw.createEl("select", { cls: "dropdown" });
    for (const [k, p] of Object.entries(PLATES)) ps.createEl("option", { value: k, text: p.label });
    ps.value = String(d.plate);
    ps.onchange = () => { d.plate = ps.value; this.save(); };
    this.field(g, "Scale / well", "mmol", d, "scale_mmol");
    this.field(g, "Volume / well", "µL", d, "volume_ul");
    this.field(g, "Solvent", "", d, "solvent", "text", "DMA");
    this.field(g, "Overage", "%", d, "overage_percent");
    this.field(g, "Stock dispense", "µL", d, "stock_ul", "num", "50");
    this.field(g, "Batch size", "rxn", d, "batch_size", "num", "6");
    this.field(g, "Temperature", "", d, "temperature", "text", "60 °C");
    this.field(g, "Time", "", d, "time", "text", "16 h");
    this.field(g, "Atmosphere", "", d, "atmosphere", "text", "N₂");
    d.product = d.product ?? {};
    this.field(g, "Product name", "", d.product, "name", "text", "target");
    const pw2 = g.createDiv({ cls: "ce-calc-field is-wide" });
    const pl2 = pw2.createDiv({ cls: "ce-calc-fl" }); pl2.createSpan({ text: "Product SMILES" });
    const prow = pw2.createDiv({ cls: "ce-hte-inrow" });
    this.inp(prow, d.product, "smiles", "SMILES (or Draw…)", "text", "ce-hte-smi");
    if (this.plugin) prow.createEl("button", { text: "Draw…" }).onclick = () => this.plugin!.openEditor(d.product?.smiles ?? null, (r) => { d.product = { ...(d.product ?? {}), smiles: r.smiles }; this.save(); }, { title: "Product" });
    const conc = d.scale_mmol && d.volume_ul ? (d.scale_mmol / (d.volume_ul / 1000)) : null;
    if (conc) s1.createDiv({ cls: "ce-hte-info", text: `Reaction concentration: ${conc.toFixed(2)} M (limiting reagent)` });

    // prep
    const s2 = sec("2 · Prep step (optional)", "e.g. tosylate → iodide in situ; its solution feeds the plate");
    const p = (d.prep = d.prep ?? {});
    const g2 = s2.createDiv({ cls: "ce-calc-fields" });
    this.field(g2, "Starting material", "", p, "name", "text", "3-phenylpropyl tosylate");
    this.field(g2, "SMILES", "", p, "smiles", "text", "optional");
    this.field(g2, "Amount", "mmol", p, "mmol");
    this.field(g2, "Solvent volume", "mL", p, "volume_ml");
    this.field(g2, "Product", "", p, "product", "text", "alkyl iodide");
    this.field(g2, "Conversion", "%", p, "conversion", "num", "100");
    const rt = s2.createDiv({ cls: "ce-calc-tablewrap" }).createEl("table", { cls: "ce-calc-table" });
    const hr = rt.createEl("tr"); for (const h of ["Prep reagent", "eq", "MW", "ρ", "amount", ""]) hr.createEl("th", { text: h });
    (p.reagents = p.reagents ?? []).forEach((r, i) => {
      const tr = rt.createEl("tr");
      this.inp(tr.createEl("td"), r, "name", "TBAI", "text"); this.inp(tr.createEl("td"), r, "eq", "1.5"); this.inp(tr.createEl("td"), r, "mw", "MW"); this.inp(tr.createEl("td"), r, "density", "g/mL");
      const mg = p.mmol && r.mw ? p.mmol * (r.eq ?? 1) * r.mw : null;
      tr.createEl("td", { cls: "is-out", text: mg !== null ? fmtNum(mg, 1) + " mg" + (r.density ? ` = ${fmtNum(mg / r.density, 1)} µL` : "") : "–" });
      const del = tr.createEl("td").createEl("button", { cls: "clickable-icon" }); setIcon(del, "x"); del.onclick = () => { p.reagents!.splice(i, 1); this.save(); };
    });
    s2.createEl("button", { cls: "ce-calc-add", text: "+ Prep reagent" }).onclick = () => { p.reagents!.push({ name: "", eq: 1 }); this.save(); };
    const pi = prepInfo(d);
    if (pi) {
      const nRuns = d.runs!.filter((r) => !r.skip).length;
      const ok = pi.maxWells === null || nRuns <= pi.maxWells;
      s2.createDiv({ cls: "ce-hte-info" + (ok ? "" : " is-warn"), text: `Prep solution: ${pi.conc.toFixed(3)} M ${p.product ?? "product"}${pi.perWell ? ` · ${fmtNum(pi.perWell, 3)} mmol per well → enough for ${pi.maxWells} wells (incl. overage)` : " · mark a component below as “from prep”"}${!ok ? ` — you planned ${nRuns}!` : ""}` });
    }

    // fixed
    const s3 = sec("3 · Fixed components", "same in every well — eq vs. limiting reagent");
    const ft = s3.createDiv({ cls: "ce-calc-tablewrap" }).createEl("table", { cls: "ce-calc-table ce-hte-ftable" });
    const fh = ft.createEl("tr"); for (const h of ["Component", "SMILES", "eq", "MW", "ρ", "M", "Type", ""]) fh.createEl("th", { text: h });
    d.fixed!.forEach((c, i) => {
      const tr = ft.createEl("tr");
      this.inp(tr.createEl("td"), c, "name", "name", "text"); this.inp(tr.createEl("td"), c, "smiles", "SMILES", "text", "ce-hte-smi"); this.inp(tr.createEl("td"), c, "eq", "1");
      this.inp(tr.createEl("td"), c, "mw", c.smiles ? fmtNum(mwOf(c.smiles), 1) : "MW"); this.inp(tr.createEl("td"), c, "density", "g/mL"); this.inp(tr.createEl("td"), c, "conc_M", "M");
      const ty = tr.createEl("td", { cls: "ce-hte-types" });
      this.chk(ty, c, "limiting", "limiting"); this.chk(ty, c, "solid", "solid"); this.chk(ty, c, "from_prep", "prep solution"); this.chk(ty, c, "in_prep", "inside prep"); this.chk(ty, c, "after", "added after (IS)");
      const del = tr.createEl("td").createEl("button", { cls: "clickable-icon" }); setIcon(del, "x"); del.onclick = () => { d.fixed!.splice(i, 1); this.save(); };
    });
    const f3 = s3.createDiv({ cls: "ce-hte-wacts" });
    f3.createEl("button", { cls: "ce-calc-add", text: "+ Component" }).onclick = () => { d.fixed!.push({ name: "", eq: 1 }); this.save(); };
    f3.createEl("button", { cls: "ce-calc-add", text: "+ From inventory…" }).onclick = () => this.fromInventory((c) => { d.fixed!.push({ ...c, eq: 1 }); this.save(); });

    // factors
    const s4 = sec("4 · Variables to screen", "each level becomes an option on the plate");
    d.factors!.forEach((f, fi) => {
      const card = s4.createDiv({ cls: "ce-hte-factor" });
      card.setCssStyles({ borderLeftColor: COLORS[fi % COLORS.length] });
      const fh2 = card.createDiv({ cls: "ce-hte-factorh" });
      this.inp(fh2, f, "name", "variable (ligand, base…)", "text", "ce-hte-fname");
      const ps = fh2.createEl("select", { cls: "dropdown ce-hte-param" });
      for (const [v, l] of [["", "chemical"], ["conc_M", "concentration (M)"], ["volume_ul", "volume (µL)"], ["temperature", "temperature"], ["time", "time"]]) ps.createEl("option", { value: v, text: l });
      ps.value = f.param ?? "";
      ps.onchange = () => { if (ps.value) f.param = ps.value as any; else delete f.param; this.save(); };
      if (!f.param) { fh2.createSpan({ cls: "ce-hte-hint", text: "default eq" }); this.inp(fh2, f, "eq", "eq", "num", "ce-hte-small"); this.chk(fh2, f, "solid", "solids"); }
      if (isNumericFactor(f)) fh2.createSpan({ cls: "ce-hte-badge", text: "numeric" });
      const del = fh2.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Remove variable" } }); setIcon(del, "trash-2"); del.onclick = () => { d.factors!.splice(fi, 1); this.save(); };
      const lt = card.createDiv({ cls: "ce-calc-tablewrap" }).createEl("table", { cls: "ce-calc-table" });
      const lh = lt.createEl("tr"); for (const h of ["Level", "SMILES", "eq", "MW", "ρ", "", ""]) lh.createEl("th", { text: h });
      f.levels = f.levels.map(lvl);
      (f.levels as HLevel[]).forEach((L, li) => {
        const tr = lt.createEl("tr");
        this.inp(tr.createEl("td"), L, "name", f.param ? "value, e.g. 60 °C" : "name", "text");
        if (f.param) { tr.createEl("td", { attr: { colspan: 5 } }); }
        else if (Array.isArray(L.components)) { tr.createEl("td", { cls: "ce-hte-hint", attr: { colspan: 5 }, text: `system of ${L.components.length} part(s) ↓` }); }
        else {
          this.inp(tr.createEl("td"), L, "smiles", "SMILES", "text", "ce-hte-smi"); this.inp(tr.createEl("td"), L, "eq", String(f.eq ?? "eq"));
          this.inp(tr.createEl("td"), L, "mw", L.smiles ? fmtNum(mwOf(L.smiles), 1) : "MW"); this.inp(tr.createEl("td"), L, "density", "g/mL");
          this.chk(tr.createEl("td"), L, "solid", "solid");
        }
        const act = tr.createEl("td", { cls: "ce-hte-lacts" });
        if (!f.param) { const pb2 = act.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Make it a system of several parts (e.g. Ni salt + ligand)" } }); setIcon(pb2, "layers"); pb2.onclick = () => { L.components = (L.components as HComp[] | undefined) ?? (L.mw || L.smiles ? [{ role: "part 1", name: L.name, mw: L.mw, smiles: L.smiles, eq: L.eq ?? f.eq }] : []); (L.components as HComp[]).push({ role: `part ${(L.components as HComp[]).length + 1}`, name: "", eq: f.eq ?? 0.1 }); this.save(); }; }
        const x = act.createEl("button", { cls: "clickable-icon" }); setIcon(x, "x"); x.onclick = () => { f.levels.splice(li, 1); this.save(); };
        if (Array.isArray(L.components)) {
          (L.components as HComp[]).forEach((c, ci) => {
            const cr = lt.createEl("tr", { cls: "ce-hte-comp" });
            const c0 = cr.createEl("td"); c0.createSpan({ cls: "ce-hte-hint", text: "↳ " }); this.inp(c0, c, "role", "role (Ni, ligand…)", "text", "ce-hte-role");
            this.inp(cr.createEl("td"), c, "name", "name", "text"); this.inp(cr.createEl("td"), c, "eq", "eq");
            this.inp(cr.createEl("td"), c, "mw", c.smiles ? fmtNum(mwOf(c.smiles), 1) : "MW"); this.inp(cr.createEl("td"), c, "conc_M", "M");
            this.chk(cr.createEl("td"), c, "solid", "solid");
            const cx = cr.createEl("td").createEl("button", { cls: "clickable-icon" }); setIcon(cx, "x"); cx.onclick = () => { (L.components as HComp[]).splice(ci, 1); if (!(L.components as HComp[]).length) delete L.components; this.save(); };
          });
        }
      });
      const la = card.createDiv({ cls: "ce-hte-wacts" });
      la.createEl("button", { cls: "ce-calc-add", text: "+ Level" }).onclick = () => { f.levels.push({ name: "" }); this.save(); };
      if (!f.param) la.createEl("button", { cls: "ce-calc-add", text: "+ From inventory…" }).onclick = () => this.fromInventory((c) => { f.levels.push(c); this.save(); });
    });
    s4.createEl("button", { cls: "ce-calc-add", text: "+ Variable" }).onclick = () => { d.factors!.push({ name: `variable ${d.factors!.length + 1}`, levels: [{ name: "A" }, { name: "B" }] }); this.save(); };
    const n = combos(d.factors!).length, cap = wellIds(String(d.plate)).length;
    el.createDiv({ cls: "ce-hte-info", text: `${n} possible combinations · plate holds ${cap}. ${n <= cap ? "A full factorial fits on one plate." : `Too many for one plate — use “Balanced” or “Bayesian” batches of ${d.batch_size ?? 6} on the Plate tab.`}` });
    const go = el.createEl("button", { cls: "mod-cta ce-hte-next", text: "Continue → plate layout" });
    go.onclick = () => { this.ui.tab = "plate"; this.render(this.box); };
  }

  // ---------------------------------------------------------------- PLATE
  private plate(el: HTMLElement) {
    const d = this.d;
    const ids = wellIds(String(d.plate));
    const runs = d.runs!;
    const used = new Set(runs.map((r) => r.well));
    const free = () => ids.filter((w) => !runs.some((r) => r.well === w));
    const batchNo = Math.max(0, ...runs.map((r) => r.batch ?? 1)) + 1;
    const add = (list: Array<Record<string, string>>) => {
      const fr = free();
      if (!list.length) { new Notice("Nothing new to add — all combinations tested?"); return; }
      if (fr.length < list.length) new Notice(`Only ${fr.length} free wells — larger plate?`);
      list.slice(0, fr.length).forEach((f, i) => runs.push({ well: fr[i], batch: batchNo, f }));
      this.save();
    };
    this.checks(el, true);
    const bs = Math.max(1, Number(d.batch_size ?? 6));
    const bar = el.createDiv({ cls: "ce-hte-design" });
    const btn = (icon: string, label: string, title: string, fn: () => void, cta = false) => { const b = bar.createEl("button", { cls: cta ? "mod-cta" : "", attr: { "aria-label": title } }); setIcon(b.createSpan(), icon); b.createSpan({ text: label }); b.onclick = fn; };
    const all = combos(d.factors!);
    const nRes = runs.filter((r) => runYield(d, r) !== null).length;
    btn("sparkles", nRes >= 3 ? `Bayesian next ${bs}` : `Smart first ${bs}`, "Balanced space-filling first batch; after ≥3 results: Gaussian-process expected improvement", () => add(suggestBO(d, bs).picks.map((p) => p.f)), true);
    btn("layout-grid", `Full factorial (${all.length})`, "Every combination", () => { const tested = new Set(runs.map((r) => JSON.stringify(r.f))); add(all.filter((c) => !tested.has(JSON.stringify(c)))); });
    btn("shuffle", `Balanced ${bs}`, "Maximally different conditions with every level represented", () => add(balancedSubset(all, bs, d.factors!, runs.map((r) => r.f))));
    btn("git-commit-horizontal", "One-at-a-time", "Baseline + vary one variable at a time", () => add(ofat(d.factors!)));
    btn("eraser", "Clear", "Remove planned wells without results", () => { d.runs = runs.filter((r) => runYield(d, r) !== null); this.ui.well = null; this.save(); });

    const wrap = el.createDiv({ cls: "ce-hte-platewrap" });
    const P = PLATES[String(d.plate)] ?? PLATES["24"];
    const left = wrap.createDiv({ cls: "ce-hte-left" });
    const cb = left.createDiv({ cls: "ce-hte-colorby" });
    cb.createSpan({ cls: "ce-hte-hint", text: "Colour by" });
    for (const k of [...d.factors!.map((f) => f.name), "yield", "batch"]) {
      const c = cb.createEl("button", { cls: "ce-lab-chip" + (this.ui.colorBy === k ? " is-on" : ""), text: k });
      c.onclick = () => { this.ui.colorBy = k; this.ui.hl = undefined; this.render(this.box); };
    }
    const plate = left.createDiv({ cls: "ce-hte-plate" + (P.rows * P.cols <= 12 ? " is-vials" : "") });
    plate.setCssStyles({ gridTemplateColumns: `24px repeat(${P.cols}, 1fr)` });
    plate.createDiv({ cls: "ce-hte-corner" });
    for (let c = 1; c <= P.cols; c++) plate.createDiv({ cls: "ce-hte-colh", text: String(c) });
    const fac = d.factors!.find((f) => f.name === this.ui.colorBy);
    const levelColor = (name: string) => { const i = (fac?.levels.map(lvl).findIndex((l) => l.name === name)) ?? -1; return i >= 0 ? COLORS[i % COLORS.length] : "#999"; };
    for (let r = 0; r < P.rows; r++) {
      plate.createDiv({ cls: "ce-hte-rowh", text: String.fromCharCode(65 + r) });
      for (let c = 1; c <= P.cols; c++) {
        const id = String.fromCharCode(65 + r) + c;
        const run = runs.find((x) => x.well === id);
        const dim = !!this.ui.hl && (!run || run.f[this.ui.colorBy] !== this.ui.hl);
        const w = plate.createDiv({ cls: "ce-hte-well" + (run ? " is-used" : "") + (this.ui.well === id ? " is-sel" : "") + (run?.skip ? " is-skip" : "") + (dim ? " is-dim" : "") });
        const y = run ? runYield(d, run) : null;
        if (run) {
          let col = "";
          if (this.ui.colorBy === "yield") col = y !== null ? heat(y) : "";
          else if (this.ui.colorBy === "batch") col = COLORS[((run.batch ?? 1) - 1) % COLORS.length];
          else if (fac) col = levelColor(run.f[fac.name]);
          if (col) w.setCssStyles({ background: col });
          w.createSpan({ cls: "ce-hte-wl", text: y !== null ? Math.round(y) + "%" : id });
        } else w.createSpan({ cls: "ce-hte-wl is-empty", text: id });
        w.onclick = () => { this.ui.well = id; this.render(this.box); };
        w.setAttribute("aria-label", run ? `${id}: ${d.factors!.map((f) => run.f[f.name]).join(" · ")}${y !== null ? ` — ${y.toFixed(1)}%` : ""}` : `${id} (empty)`);
      }
    }
    // legend
    if (fac) { const lg = left.createDiv({ cls: "ce-hte-legend" }); fac.levels.map(lvl).forEach((l, i) => { const it = lg.createDiv(); it.createSpan({ cls: "ce-hte-sw" }).setCssStyles({ background: COLORS[i % COLORS.length] }); it.appendText(l.name); }); }
    else if (this.ui.colorBy === "yield") { const lg = left.createDiv({ cls: "ce-hte-legend" }); for (const v of [0, 25, 50, 75, 100]) { const it = lg.createDiv(); it.createSpan({ cls: "ce-hte-sw" }).setCssStyles({ background: heat(v) }); it.appendText(v + "%"); } }
    // well panel
    const side = wrap.createDiv({ cls: "ce-hte-wellpanel" });
    const wid = this.ui.well;
    if (!wid) { side.createDiv({ cls: "ce-hte-hint", text: `${runs.length} wells planned · ${free().length} free. Tap a well to set its conditions, see its recipe or enter the result.` }); return; }
    let run = runs.find((x) => x.well === wid);
    side.createDiv({ cls: "ce-hte-wellh", text: `Well ${wid}` + (run?.batch ? ` · batch ${run.batch}` : "") });
    for (const f of d.factors!) {
      const row = side.createDiv({ cls: "ce-hte-wrow" });
      row.createSpan({ cls: "ce-hte-hint", text: f.name });
      const s = row.createEl("select", { cls: "dropdown" });
      s.createEl("option", { value: "", text: "—" });
      for (const l of f.levels.map(lvl)) s.createEl("option", { value: l.name, text: l.name });
      s.value = run?.f[f.name] ?? "";
      s.onchange = () => { if (!run) { run = { well: wid, batch: batchNo, f: {} }; runs.push(run); } if (s.value) run.f[f.name] = s.value; else delete run.f[f.name]; this.save(); };
    }
    if (!run) return;
    const rc = this.recipeFor(run.f);
    const t = side.createEl("table", { cls: "ce-calc-table ce-hte-wrecipe" });
    for (const l of rc.lines) { const tr = t.createEl("tr"); tr.createEl("td", { text: l.name + (l.after ? " ⟂" : "") }); tr.createEl("td", { cls: "is-out" + (l.stockKey === "__inprep" ? " is-inmix" : ""), text: l.stockKey === "__inprep" ? `in mix (${l.mmol !== null ? fmtNum(l.mmol * 1000, 1) + " µmol" : ""})` : l.ul !== null ? `${fmtNum(l.ul, 1)} µL` : l.mg !== null ? `${fmtNum(l.mg, 2)} mg` : "—" }); }
    if (rc.solventUl !== null) { const tr = t.createEl("tr"); tr.createEl("td", { text: `${d.solvent ?? "solvent"} (top-up)` }); tr.createEl("td", { cls: "is-out", text: `${fmtNum(rc.solventUl, 0)} µL` }); }
    side.createDiv({ cls: "ce-hte-sech2", text: "Result" });
    for (const tp of timepoints(d)) {
      if (tp) side.createDiv({ cls: "ce-hte-tp", text: tp });
      const rg = side.createDiv({ cls: "ce-calc-fields ce-hte-res" });
      const ro = resOf(run, tp);
      if ((d.analysis?.method ?? "hplc") === "hplc") { this.field(rg, "Area product", "", ro, "area_p"); this.field(rg, "Area IS", "", ro, "area_is"); }
      this.field(rg, "…or yield", "%", ro, "yield");
      const yt = runYield(d, run, tp);
      if (tp && yt !== null) rg.createDiv({ cls: "ce-hte-tpy", text: `${yt.toFixed(1)} %` });
    }
    const y = runYield(d, run);
    if (y !== null) side.createDiv({ cls: "ce-hte-yield", text: `${y.toFixed(1)} %` }).setCssStyles({ color: heat(y) });
    this.inp(side, run, "note", "note (colour, precipitate…)", "text", "ce-hte-note");
    const acts = side.createDiv({ cls: "ce-hte-wacts" });
    const sk = acts.createEl("button", { text: run.skip ? "Include" : "Exclude (failed setup)" }); sk.onclick = () => { if (run!.skip) delete run!.skip; else run!.skip = true; this.save(); };
    const dup = acts.createEl("button", { text: "Duplicate (replicate)" });
    dup.onclick = () => { const fw = ids.find((w) => !runs.some((r) => r.well === w)); if (!fw) { new Notice("No free well"); return; } runs.push({ well: fw, batch: run!.batch, f: { ...run!.f }, note: `replicate of ${wid}` }); this.ui.well = fw; this.save(); };
    const rm = acts.createEl("button", { text: "Empty well" }); rm.onclick = () => { d.runs = runs.filter((r) => r !== run); this.ui.well = null; this.save(); };
  }

  // ---------------------------------------------------------------- RECIPE
  private recipeTab(el: HTMLElement) {
    const d = this.d;
    const runs = d.runs!.filter((r) => !r.skip);
    if (!runs.length) { el.createDiv({ cls: "ce-hte-hint", text: "Plan wells on the Plate tab first." }); return; }
    const recs = runs.map((r) => ({ r, rc: this.recipeFor(r.f) }));
    const md: string[] = [];
    const ov = 1 + (d.overage_percent ?? 10) / 100;
    // prep
    const pi = prepInfo(d), p = d.prep;
    if (pi && p) {
      const s = el.createDiv({ cls: "ce-hte-sec" });
      s.createDiv({ cls: "ce-hte-sech", text: "Step 1 · Prep solution" });
      const lines = [`${p.name ?? "Starting material"} (${fmtNum(p.mmol, 3)} mmol${p.smiles && mwOf(p.smiles) ? `, ${fmtNum(p.mmol! * mwOf(p.smiles)!, 1)} mg` : ""})`, ...pi.reagents.map((r) => `${r.name} (${fmtNum(r.mmol, 3)} mmol, ${r.eq} eq.${r.mg ? `, ${fmtNum(r.mg, 1)} mg` : ""}${r.mg && (r as any).density ? ` = ${fmtNum(r.mg / (r as any).density, 1)} µL` : ""})`), `dissolve in ${p.volume_ml} mL ${p.solvent ?? d.solvent ?? "solvent"} → ${pi.conc.toFixed(3)} M ${p.product ?? "product"} (assumes ${p.conversion ?? 100}% conversion; check by TLC/HPLC before use)`];
      const ul = s.createEl("ul"); for (const l of lines) ul.createEl("li", { text: l });
      const need = runs.length * (pi.perWell ?? 0) * ov;
      s.createDiv({ cls: "ce-hte-info" + (need > pi.mmol ? " is-warn" : ""), text: `Plate needs ${fmtNum(need, 3)} mmol of ${p.mmol} mmol (${runs.length} wells + ${d.overage_percent ?? 10}% overage)` });
      md.push(`**Prep:** ${lines.join("; ")}.`);
    }
    // stocks
    const stocks = new Map<string, { conc: number; totalUl: number; mg: number | null }>();
    const solids = new Map<string, number>();
    for (const { rc } of recs) for (const l of rc.lines) { const k = l.stockKey ?? l.name; if (l.stock && !stocks.has(k)) stocks.set(k, l.stock); if (!l.stock && l.how.startsWith("weigh")) solids.set(k, (solids.get(k) ?? 0) + (l.mg ?? 0)); }
    const s2 = el.createDiv({ cls: "ce-hte-sec" });
    s2.createDiv({ cls: "ce-hte-sech", text: "Step 2 · Stock solutions" });
    if (stocks.size) {
      const t = s2.createDiv({ cls: "ce-calc-tablewrap" }).createEl("table", { cls: "ce-calc-table" });
      const hr = t.createEl("tr"); for (const h of ["Stock", "conc.", "prepare", "weigh", "per well"]) hr.createEl("th", { text: h });
      for (const [n, st] of stocks) { const tr = t.createEl("tr"); tr.createEl("td", { text: n }); tr.createEl("td", { text: `${fmtNum(st.conc, 3)} M` }); tr.createEl("td", { text: `${st.totalUl} µL ${d.solvent ?? ""}` }); tr.createEl("td", { cls: "is-out", text: st.mg !== null ? `${fmtNum(st.mg, 2)} mg` : "MW?" }); tr.createEl("td", { text: `${d.stock_ul ?? 50} µL` }); md.push(`- Stock ${n}: ${st.mg !== null ? fmtNum(st.mg, 2) + " mg in " : ""}${st.totalUl} µL ${d.solvent ?? ""} (${fmtNum(st.conc, 3)} M)`); }
    } else s2.createDiv({ cls: "ce-hte-hint", text: "No stock solutions needed." });
    if (solids.size) { s2.createDiv({ cls: "ce-hte-hint", text: "Solids weighed per vial: " + [...solids.entries()].map(([n, mg]) => `${n} (Σ ${fmtNum(mg, 1)} mg)`).join(", ") }); }
    // dispense table
    const s3 = el.createDiv({ cls: "ce-hte-sec" });
    s3.createDiv({ cls: "ce-hte-sech", text: "Step 3 · Dispense (per well)" });
    const names = [...new Set(recs.flatMap((x) => x.rc.lines.filter((l) => (l.ul !== null || l.mg !== null) && l.stockKey !== "__inprep").map((l) => l.name.replace(/:.*/, ""))))];
    const params = (d.factors ?? []).filter((f) => f.param);
    const t = s3.createDiv({ cls: "ce-calc-tablewrap" }).createEl("table", { cls: "ce-calc-table ce-hte-disp" });
    const hr = t.createEl("tr"); for (const h of ["Well", ...params.map((f) => f.name), ...names, `${d.solvent ?? "solvent"}`]) hr.createEl("th", { text: h });
    const tsv: string[] = [["Well", ...params.map((f) => f.name), ...names, d.solvent ?? "solvent"].join("\t")];
    for (const { r, rc } of recs) {
      const tr = t.createEl("tr");
      tr.createEl("td", { cls: "ce-calc-vial", text: r.well });
      const cells: string[] = [r.well];
      for (const f of params) { tr.createEl("td", { cls: "ce-hte-param-cell", text: r.f[f.name] ?? "—" }); cells.push(r.f[f.name] ?? ""); }
      for (const n of names) {
        const l = rc.lines.find((x) => x.name.replace(/:.*/, "") === n);
        const txt = !l || (l.ul === null && l.mg === null) ? "—" : l.ul !== null ? `${fmtNum(l.ul, 1)} µL` : `${fmtNum(l.mg, 2)} mg`;
        const td = tr.createEl("td", { text: txt });
        if (l?.name.includes(":")) td.createDiv({ cls: "ce-hte-hint", text: l.name.split(": ")[1] });
        if (l?.warn) td.addClass("is-warn");
        cells.push(txt + (l?.name.includes(":") ? ` (${l.name.split(": ")[1]})` : ""));
      }
      tr.createEl("td", { text: rc.solventUl !== null ? `${fmtNum(rc.solventUl, 0)} µL` : "—" });
      cells.push(rc.solventUl !== null ? `${fmtNum(rc.solventUl, 0)} µL` : "");
      tsv.push(cells.join("\t"));
    }
    const warns = [...new Set(recs.flatMap((x) => [...x.rc.warnings, ...x.rc.lines.filter((l) => l.warn).map((l) => `${l.name}: ${l.warn}`)]))];
    for (const w of warns) s3.createDiv({ cls: "ce-hte-info is-warn", text: "⚠ " + w });
    s3.createDiv({ cls: "ce-hte-hint", text: "Suggested order: solids (reductant, Ni/ligand if solid) → seal & purge (glovebox / N₂) → solvent top-up → stock solutions → limiting reagent & prep solution last; stir. Components marked ⟂ (internal standard) are added after the reaction, before HPLC." });
    const acts = el.createDiv({ cls: "ce-hte-wacts" });
    acts.createEl("button", { text: "Copy dispense table (Excel)" }).onclick = async () => { await navigator.clipboard.writeText(tsv.join("\n")); new Notice("Copied"); };
    acts.createEl("button", { text: "Copy as lab-book text" }).onclick = async () => {
      const lines = [`**HTE ${d.title ?? ""}** — ${runs.length} reactions, ${fmtNum(d.scale_mmol, 3)} mmol scale, ${d.volume_ul} µL ${d.solvent ?? ""}`, ...md, "", "| " + tsv[0].split("\t").join(" | ") + " |", "|" + tsv[0].split("\t").map(() => "---").join("|") + "|", ...tsv.slice(1).map((r) => "| " + r.split("\t").join(" | ") + " |")];
      await navigator.clipboard.writeText(lines.join("\n")); new Notice("Copied — paste into Experimental");
    };
  }

  // ---------------------------------------------------------------- RESULTS
  private results(el: HTMLElement) {
    const d = this.d;
    const runs = d.runs!;
    const a = (d.analysis = d.analysis ?? { method: "hplc", rf: 1, is_eq: 0.33 });
    const s0 = el.createDiv({ cls: "ce-hte-sec" });
    const h0 = s0.createDiv({ cls: "ce-hte-sech" }); h0.createSpan({ text: "Analysis" });
    const g = s0.createDiv({ cls: "ce-calc-fields" });
    const mw = g.createDiv({ cls: "ce-calc-field" }); mw.createDiv({ cls: "ce-calc-fl", text: "Method" });
    const ms = mw.createEl("select", { cls: "dropdown" }); for (const [k, l] of [["hplc", "HPLC/GC areas + IS"], ["yield", "enter yields"]]) ms.createEl("option", { value: k, text: l });
    ms.value = a.method ?? "hplc"; ms.onchange = () => { a.method = ms.value as any; this.save(); };
    const tpw = g.createDiv({ cls: "ce-calc-field is-wide" }); tpw.createDiv({ cls: "ce-calc-fl", text: "Timepoints (comma-separated)" });
    const tpi = tpw.createEl("input", { type: "text", cls: "ce-calc-in", value: (a.timepoints ?? []).join(", "), attr: { placeholder: "e.g. 4 h, 16 h (empty = single)" } });
    tpi.onchange = () => { const v = tpi.value.split(",").map((x) => x.trim()).filter(Boolean); if (v.length) a.timepoints = v; else delete a.timepoints; this.save(); };
    if (a.method !== "yield") { this.field(g, "Response factor", "prod/IS", a, "rf", "num", "1"); this.field(g, "IS amount", "eq", a, "is_eq", "num", "0.33"); s0.createDiv({ cls: "ce-hte-hint", text: "Assay yield = (A_prod / A_IS) × n_IS / (RF × n_limiting). Determine RF once from a weighed mixture of product and internal standard." }); }
    // results table
    const s1 = el.createDiv({ cls: "ce-hte-sec" });
    s1.createDiv({ cls: "ce-hte-sech", text: "Results" });
    const t = s1.createDiv({ cls: "ce-calc-tablewrap" }).createEl("table", { cls: "ce-calc-table" });
    const tps = timepoints(d);
    const hr = t.createEl("tr");
    for (const x of ["Well", "B", ...d.factors!.map((f) => f.name)]) hr.createEl("th", { text: x });
    for (const tp of tps) { if (a.method !== "yield") { hr.createEl("th", { text: `A prod${tp ? " " + tp : ""}` }); hr.createEl("th", { text: `A IS${tp ? " " + tp : ""}` }); } hr.createEl("th", { text: `Yield %${tp ? " " + tp : ""}` }); }
    const sorted = [...runs].sort((p, q) => (runYield(d, q) ?? -1) - (runYield(d, p) ?? -1));
    for (const r of sorted) {
      const tr = t.createEl("tr", { cls: r.skip ? "is-skip" : "" });
      tr.createEl("td", { cls: "ce-calc-vial", text: r.well }); tr.createEl("td", { text: String(r.batch ?? 1) });
      for (const f of d.factors!) tr.createEl("td", { text: r.f[f.name] ?? "—" });
      for (const tp of tps) {
        const ro = resOf(r, tp);
        if (a.method !== "yield") { this.inp(tr.createEl("td"), ro, "area_p", "area"); this.inp(tr.createEl("td"), ro, "area_is", "area"); }
        const y = runYield(d, r, tp);
        const yt = tr.createEl("td");
        if (a.method === "yield") this.inp(yt, ro, "yield", "%"); else yt.setText(y !== null ? y.toFixed(1) : "—");
        if (y !== null) yt.setCssStyles({ background: heat(y), color: "#fff", fontWeight: "700" });
      }
    }
    // main effects
    const me = mainEffects(d);
    if (runs.some((r) => runYield(d, r) !== null)) {
      const s2 = el.createDiv({ cls: "ce-hte-sec" });
      s2.createDiv({ cls: "ce-hte-sech", text: "Main effects (mean yield per level)" });
      for (const m of me) {
        s2.createDiv({ cls: "ce-hte-hint", text: m.factor });
        for (const l of m.levels) {
          const row = s2.createDiv({ cls: "ce-hte-bar" });
          row.createSpan({ cls: "ce-hte-barl", text: l.name });
          const b = row.createDiv({ cls: "ce-hte-bart" });
          if (l.mean !== null) b.createDiv({ cls: "ce-hte-barf" }).setCssStyles({ width: Math.max(2, l.mean) + "%", background: heat(l.mean) });
          row.createSpan({ cls: "ce-hte-barv", text: l.mean !== null ? `${l.mean.toFixed(0)}% (n=${l.n})` : "untested" });
        }
      }
    }
    // next batch
    const s3 = el.createDiv({ cls: "ce-hte-sec ce-hte-bo" });
    const bs = Math.max(1, Number(d.batch_size ?? 6));
    const sg = suggestBO(d, bs);
    const h3 = s3.createDiv({ cls: "ce-hte-sech" });
    setIcon(h3.createSpan(), "sparkles");
    h3.createSpan({ text: sg.mode === "bo" ? ` Next batch — Bayesian optimisation (${bs})` : ` First batch — balanced exploration (${bs})` });
    s3.createDiv({ cls: "ce-hte-hint", text: sg.mode === "bo" ? "Gaussian process (main-effect + interaction kernel) fitted to your yields; picks maximise expected improvement over the best result, spread over the batch." : "Fewer than 3 results: start with maximally different conditions so every level is tested once." });
    if (!sg.picks.length) s3.createDiv({ cls: "ce-hte-hint", text: "All combinations have been tested. For the next round add levels or a variable (reductant, temperature, concentration…) — or start from Templates → “XEC — round 2 (Bayesian)” and keep your best 2–3 catalyst systems." });
    else {
      const tb = s3.createDiv({ cls: "ce-calc-tablewrap" }).createEl("table", { cls: "ce-calc-table" });
      const hh = tb.createEl("tr"); for (const x of ["#", ...d.factors!.map((f) => f.name), ...(sg.mode === "bo" ? ["predicted", "± 1σ", "EI"] : [])]) hh.createEl("th", { text: x });
      sg.picks.forEach((p, i) => { const tr = tb.createEl("tr"); tr.createEl("td", { text: String(i + 1) }); for (const f of d.factors!) tr.createEl("td", { text: p.f[f.name] }); if (sg.mode === "bo") { tr.createEl("td", { cls: "is-out", text: p.mean.toFixed(0) + "%" }); tr.createEl("td", { text: p.sd.toFixed(0) }); tr.createEl("td", { text: p.ei.toFixed(1) }); } });
      const addb = s3.createEl("button", { cls: "mod-cta", text: `Add these ${sg.picks.length} to the plate` });
      addb.onclick = () => {
        const ids = wellIds(String(d.plate)).filter((w) => !runs.some((r) => r.well === w));
        const b = Math.max(0, ...runs.map((r) => r.batch ?? 1)) + 1;
        if (ids.length < sg.picks.length) new Notice("Not enough free wells — switch to a larger plate in Plan");
        sg.picks.slice(0, ids.length).forEach((p, i) => runs.push({ well: ids[i], batch: b, f: p.f }));
        this.ui.tab = "plate"; this.save();
      };
    }
    const acts = el.createDiv({ cls: "ce-hte-wacts" });
    acts.createEl("button", { text: "Export CSV (ML / Bayesian tools)" }).onclick = async () => { await navigator.clipboard.writeText(mlCsv(d)); new Notice("CSV copied (one-hot encoded) — paste into a .csv / EDBO / Python"); };
  }
}

function confirmReplace(): boolean {
  try { return window.confirm("Replace this screen (including its results) with the template?"); } catch { return true; }
}
