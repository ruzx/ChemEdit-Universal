// Renders ```chem-calc blocks (and the legacy organic-helper / analytical-eln / bio-eln / polymer-eln / matrix-eln blocks).
// Inputs are edited inline (works on touch); results update live; inputs are saved back to the block on change.

import { App, FuzzySuggestModal, MarkdownPostProcessorContext, Menu, Notice, TFile, parseYaml, setIcon, stringifyYaml, Editor } from "obsidian";
import type ChemEditPlugin from "./main";
import { CALCS, CALC_BY_ID, CalcDef, CalcData, Row, Field, Plot, n } from "../chem/calcs";
import { HteView } from "./hteview";
import { XEC_EXAMPLE, XEC_CATSYS } from "../chem/hte";
import { computeProperties } from "../chem/props";
import { parseAny } from "../chem/index";
import { setSvg } from "../render/dom";
import { errMsg, str, isRecord } from "../chem/util";

export const LEGACY_DEFAULT: Record<string, string> = { "organic-helper": "nmr_yield", "analytical-eln": "calibration", "bio-eln": "pcr", "polymer-eln": "polymerization", "matrix-eln": "matrix" };
const mwCache = new Map<string, number | null>();
export const mwOf = (smi: string): number | null => {
  if (!mwCache.has(smi)) { try { mwCache.set(smi, computeProperties(parseAny(smi, "smiles"), "all")?.mw ?? null); } catch { mwCache.set(smi, null); } }
  return mwCache.get(smi)!;
};

export function fmtNum(v: unknown, d = 2): string {
  if (v === null || v === undefined || v === "" || (typeof v === "number" && !isFinite(v))) return "–";
  if (typeof v !== "number") return str(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 10 ** -Math.max(d, 3))) return v.toExponential(2);
  return v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, a >= 100 ? 0 : d) });
}

function plotSvg(p: Plot): string {
  const W = 300, H = 170, L = 42, B = 28, T = 8, R = 10;
  const pts = p.points;
  if (!pts.length) return "";
  let x0 = Math.min(0, ...pts.map((q) => q.x)), x1 = Math.max(...pts.map((q) => q.x));
  let y0 = Math.min(0, ...pts.map((q) => q.y)), y1 = Math.max(...pts.map((q) => q.y));
  if (p.extendX && p.line && p.line.m) { const xi = -p.line.b / p.line.m; if (xi < x0 && xi > x0 - (x1 - x0)) x0 = xi; }
  if (x1 === x0) x1 = x0 + 1; if (y1 === y0) y1 = y0 + 1;
  const sx = (x: number) => L + ((x - x0) / (x1 - x0)) * (W - L - R), sy = (y: number) => H - B - ((y - y0) / (y1 - y0)) * (H - B - T);
  const t = (v: number) => (Math.abs(v) >= 1e6 ? +(v / 1e6).toPrecision(3) + "M" : Math.abs(v) >= 1000 ? +(v / 1000).toPrecision(3) + "k" : String(+v.toPrecision(3)));
  let s = `<svg class="ce-calc-plot" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  s += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="ax"/><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="ax"/>`;
  for (let i = 0; i <= 4; i++) {
    const xv = x0 + ((x1 - x0) * i) / 4, yv = y0 + ((y1 - y0) * i) / 4;
    s += `<text x="${sx(xv)}" y="${H - B + 12}" class="tk" text-anchor="middle">${t(xv)}</text><text x="${L - 4}" y="${sy(yv) + 3}" class="tk" text-anchor="end">${t(yv)}</text>`;
    if (i) s += `<line x1="${L}" y1="${sy(yv)}" x2="${W - R}" y2="${sy(yv)}" class="gr"/>`;
  }
  s += `<text x="${(L + W - R) / 2}" y="${H - 2}" class="lb" text-anchor="middle">${p.xl}</text>`;
  if (p.line) s += `<line x1="${sx(x0)}" y1="${sy(p.line.m * x0 + p.line.b)}" x2="${sx(x1)}" y2="${sy(p.line.m * x1 + p.line.b)}" class="fit"/>`;
  if (p.step) s += `<polyline class="fit" fill="none" points="${pts.map((q) => `${sx(q.x)},${sy(q.y)}`).join(" ")}"/>`;
  for (const q of pts) s += `<circle cx="${sx(q.x)}" cy="${sy(q.y)}" r="3.5" class="${q.off ? "off" : "pt"}"/>`;
  return s + "</svg>";
}

export class CalcRenderer {
  constructor(private plugin: ChemEditPlugin) {}

  private async save(el: HTMLElement, ctx: MarkdownPostProcessorContext, d: CalcData) {
    const info = ctx.getSectionInfo(el);
    const file = this.plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!info || !(file instanceof TFile)) { new Notice("Couldn't locate the calculator block."); return; }
    const yaml = stringifyYaml(d).replace(/\n$/, "");
    await this.plugin.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const m = /^(\s*(?:>\s*)*)(`{3,}|~{3,})/.exec(lines[info.lineStart] ?? "");
      const prefix = m?.[1] ?? "";
      lines.splice(info.lineStart + 1, info.lineEnd - info.lineStart - 1, ...yaml.split("\n").map((l) => prefix + l));
      return lines.join("\n");
    });
  }

  render(tag: string, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    let d: CalcData;
    try { const v: unknown = parseYaml(source.replace(/smiles:\s*([^'"\s][^\n#]*)$/gm, (_m: string, s: string) => `smiles: '${s.trim().replace(/'/g, "''")}'`)); d = isRecord(v) ? v : {}; }
    catch (e) { el.createDiv({ cls: "chemedit-error", text: `Calculator: ${errMsg(e)}` }); return; }
    const type = str(d.type) || LEGACY_DEFAULT[tag] || "";
    const box = el.createDiv({ cls: "ce-calc" });
    const save = () => { void this.save(el, ctx, d); };
    if (type === "matrix" || type === "hte") {
      if (type === "matrix") { const conv = HteView.fromMatrix(d); for (const k of Object.keys(d)) delete d[k]; Object.assign(d, conv); }
      new HteView(d, save, ctx.sourcePath + "|" + str(d.title), this.plugin).render(box);
      return;
    }
    const def = CALC_BY_ID.get(type);
    if (!def) { this.renderPicker(box, d, save); return; }
    this.renderDef(box, def, d, save);
  }

  private header(box: HTMLElement, icon: string, title: string, group: string, d: CalcData, save: () => void, copy: () => string) {
    const h = box.createDiv({ cls: "ce-calc-head" });
    setIcon(h.createSpan({ cls: "ce-calc-icon" }), icon);
    const tw = h.createDiv({ cls: "ce-calc-titles" });
    const ti = tw.createEl("input", { type: "text", cls: "ce-calc-title", value: str(d.title) || title, attr: { placeholder: title, "aria-label": "Title" } });
    ti.onchange = () => { if (ti.value.trim() && ti.value !== title) d.title = ti.value.trim(); else delete d.title; save(); };
    tw.createDiv({ cls: "ce-calc-sub", text: `${group} · ${title}` });
    const act = h.createDiv({ cls: "ce-calc-actions" });
    const b = act.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Copy results (Excel)" } });
    setIcon(b, "copy");
    b.onclick = () => { void navigator.clipboard.writeText(copy()).then(() => new Notice("Copied — paste into Excel")); };
    const mb = act.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Change calculator" } });
    setIcon(mb, "more-vertical");
    mb.onclick = (e) => {
      const m = new Menu();
      for (const g of ["Organic", "Analytical", "Bio", "Polymer"]) {
        m.addSeparator();
        for (const c of CALCS.filter((x) => x.group === g)) m.addItem((i) => i.setTitle(`${g} · ${c.title}`).setIcon(c.icon).onClick(() => { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, { type: c.id }, JSON.parse(JSON.stringify(c.example)) as CalcData); save(); }));
      }
      m.addItem((i) => i.setTitle("HTE reaction array").setIcon("grid-3x3").onClick(() => { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, JSON.parse(JSON.stringify(XEC_EXAMPLE)) as CalcData); save(); }));
      m.showAtMouseEvent(e);
    };
  }

  private input(parent: HTMLElement, f: Field, obj: CalcData, live: () => void, save: () => void) {
    const t = f.t ?? "num";
    if (t === "bool") {
      const cb = parent.createEl("input", { type: "checkbox" });
      cb.checked = obj[f.k] === true || obj[f.k] === "true";
      cb.onchange = () => { if (cb.checked) obj[f.k] = true; else delete obj[f.k]; live(); save(); };
      return cb;
    }
    const inp = parent.createEl("input", { type: "text", cls: "ce-calc-in" + (t === "num" ? " is-num" : ""), value: str(obj[f.k]), attr: { placeholder: f.ph ?? (t === "num" ? "–" : ""), "aria-label": f.l } });
    if (t === "num") inp.inputMode = "decimal";
    const set = () => {
      const v = inp.value.trim();
      if (!v) delete obj[f.k];
      else if (t === "num") { const x = n(v); if (x !== null) obj[f.k] = x; }
      else obj[f.k] = v;
    };
    inp.oninput = () => { set(); live(); };
    inp.onchange = () => { set(); save(); };
    inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); };
    return inp;
  }

  private renderDef(box: HTMLElement, def: CalcDef, d: CalcData, save: () => void) {
    box.addClass(`ce-calc-${def.group.toLowerCase()}`);
    let out = def.calc(d, mwOf);
    const copy = () => {
      const lines = ["Parameter\tValue\tUnit"];
      for (const f of def.fields) if (d[f.k] !== undefined) lines.push(`${f.l}\t${str(d[f.k])}\t${f.u ?? ""}`);
      for (const r of def.results) { const v = out.v[r.k]; lines.push(`${r.l}\t${typeof v === "number" ? v.toFixed(r.d ?? 3) : str(v)}\t${r.u ?? ""}`); }
      for (const t of def.tables ?? []) {
        lines.push("", t.title, [...t.cols, ...(t.outs ?? [])].map((c) => c.l).join("\t"));
        rowsOf(d, t.k).forEach((row, i) => lines.push([...t.cols.map((c) => str(row[c.k])), ...(t.outs ?? []).map((o) => { const v = out.rows?.[t.k]?.[i]?.[o.k]; return typeof v === "number" ? v.toFixed(4) : str(v); })].join("\t")));
      }
      return lines.join("\n");
    };
    this.header(box, def.icon, def.title, def.group, d, save, copy);
    const resEl = box.createDiv({ cls: "ce-calc-results" });
    const outCells: Array<{ el: HTMLElement; t: string; i: number; k: string }> = [];
    const plotEl = box.createDiv({ cls: "ce-calc-plotwrap" });
    const notesEl = box.createDiv({ cls: "ce-calc-notes" });
    const paint = () => {
      out = def.calc(d, mwOf);
      resEl.empty();
      for (const r of def.results) {
        const v = out.v[r.k];
        const tile = resEl.createDiv({ cls: "ce-calc-tile" + (r.hero ? " is-hero" : "") + (r.text ? " is-text" : "") });
        if (r.grade && typeof v === "number") {
          const [good, mid] = r.grade;
          const ok = r.lowGood ? v <= good : v >= good, so = r.lowGood ? v <= mid : v >= mid;
          tile.addClass(ok ? "is-good" : so ? "is-mid" : "is-bad");
        }
        tile.createDiv({ cls: "ce-calc-tl", text: r.l });
        const val = tile.createDiv({ cls: "ce-calc-tv" });
        val.createSpan({ text: r.text ? str(v) || "–" : fmtNum(v, r.d ?? 2) });
        if (r.u && !r.text) val.createSpan({ cls: "ce-calc-tu", text: " " + r.u });
      }
      for (const c of outCells) c.el.setText(fmtNum(out.rows?.[c.t]?.[c.i]?.[c.k], 3));
      plotEl.empty();
      if (out.plot) setSvg(plotEl, plotSvg(out.plot));
      notesEl.empty();
      for (const nt of out.notes ?? []) notesEl.createDiv({ cls: "ce-calc-note", text: "ⓘ " + nt });
    };
    if (def.fields.length) {
      const grid = box.createDiv({ cls: "ce-calc-fields" });
      box.insertBefore(grid, resEl);
      for (const f of def.fields) {
        const w = grid.createDiv({ cls: "ce-calc-field" + (f.t === "text" || f.t === "smiles" ? " is-wide" : "") });
        const lab = w.createDiv({ cls: "ce-calc-fl" });
        lab.createSpan({ text: f.l });
        if (f.u) lab.createSpan({ cls: "ce-calc-fu", text: f.u });
        this.input(w, f, d, paint, save);
      }
    }
    for (const t of def.tables ?? []) {
      const sec = box.createDiv({ cls: "ce-calc-tablesec" });
      box.insertBefore(sec, resEl);
      const th = sec.createDiv({ cls: "ce-calc-th" });
      th.createSpan({ text: t.title });
      const add = th.createEl("button", { cls: "ce-calc-add", text: "+ Row" });
      add.onclick = () => { rowsOf(d, t.k, true).push({}); save(); };
      const wrap = sec.createDiv({ cls: "ce-calc-tablewrap" });
      const tb = wrap.createEl("table", { cls: "ce-calc-table" });
      const hr = tb.createEl("thead").createEl("tr");
      for (const c of t.cols) hr.createEl("th", { text: c.l });
      for (const o of t.outs ?? []) hr.createEl("th", { cls: "is-out", text: o.l });
      hr.createEl("th");
      const body = tb.createEl("tbody");
      const list = rowsOf(d, t.k);
      list.forEach((row, i) => {
        const tr = body.createEl("tr");
        for (const c of t.cols) this.input(tr.createEl("td"), c, row, paint, save);
        for (const o of t.outs ?? []) outCells.push({ el: tr.createEl("td", { cls: "is-out" }), t: t.k, i, k: o.k });
        const del = tr.createEl("td").createEl("button", { cls: "clickable-icon ce-calc-del", attr: { "aria-label": "Remove row" } });
        setIcon(del, "x");
        del.onclick = () => { list.splice(i, 1); save(); };
      });
      if (!list.length) body.createEl("tr").createEl("td", { attr: { colspan: t.cols.length + (t.outs?.length ?? 0) + 1 }, cls: "ce-eln-empty", text: "No rows — tap “+ Row”" });
    }
    paint();
  }

  private renderPicker(box: HTMLElement, d: CalcData, save: () => void) {
    box.createDiv({ cls: "ce-calc-sub", text: "Choose a calculator:" });
    const g = box.createDiv({ cls: "ce-calc-picker" });
    for (const c of CALCS) {
      const b = g.createEl("button", { cls: "ce-calc-pick" });
      setIcon(b.createSpan(), c.icon);
      b.createSpan({ text: c.title });
      b.onclick = () => { Object.assign(d, { type: c.id }, JSON.parse(JSON.stringify(c.example)) as CalcData); save(); };
    }
  }
}

/** "Insert calculator" picker. */
export class CalcPicker extends FuzzySuggestModal<{ id: string; title: string; group: string; desc: string }> {
  constructor(app: App, private onPick: (block: string) => void) { super(app); this.setPlaceholder("Calculator: qNMR, faradaic efficiency, calibration, PCR, DP/Mn…"); }
  getItems() { return [...CALCS.map((c) => ({ id: c.id, title: c.title, group: c.group, desc: c.desc })), { id: "hte", title: "HTE planner (plate, recipe, Bayesian next batch)", group: "HTE", desc: "Visual vial/plate screen with stock solutions, prep step, HPLC yields and Bayesian suggestions." }]; }
  getItemText(i: { title: string; group: string; desc: string }) { return `${i.group} · ${i.title} — ${i.desc}`; }
  onChooseItem(i: { id: string }) {
    this.onPick(calcBlock(i.id));
  }
}

export function insertCalc(app: App, editor: Editor) { new CalcPicker(app, (b) => editor.replaceSelection(b)).open(); }
export function calcBlock(id: string) { if (id === "hte" || id === "matrix") return "```chem-calc\n" + stringifyYaml(XEC_CATSYS) + "```\n"; const ex = CALC_BY_ID.get(id)!.example; return "```chem-calc\n" + stringifyYaml({ type: id, ...ex }) + "```\n"; }

/** Table rows of a calculator (created on demand when `create`). */
function rowsOf(d: CalcData, k: string, create = false): Row[] {
  const v = d[k];
  if (Array.isArray(v)) return v as Row[];
  const r: Row[] = [];
  if (create) d[k] = r;
  return r;
}
