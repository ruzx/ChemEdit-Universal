// TLC wizard: photo → plate detection (white region, "document scan") → perspective crop →
// baseline/front + spot detection → Rf, lane labels, solvent system & stain chips →
// annotated PNG + template-formatted line inserted into the experiment note.

import { Modal, Notice } from "obsidian";
import { Img, Pt, Spot, detectPlate, warp, warpSize, contrastMap, detectLines, detectSpots, clusterLanes, rfValue } from "../tlc/image";
import {
  ElnCtx, SectionKey, chips, label, solventPicker, systemText, STAINS, DEFAULT_SYSTEM, SolventSystem,
  pickImage, loadImage, saveBinary, insertIntoNote, fileStamp, nowHM,
} from "./labbook";

type Step = "photo" | "crop" | "analyse" | "finish";
interface TSpot extends Spot { lane: number; name: string; manual?: boolean }
const LANE_LABELS = ["SM", "Co", "RM", "P", "Ref", "A", "B", "C"];

function imgFromCanvas(c: HTMLCanvasElement): Img {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: d.data };
}
function canvasFromImg(img: Img): HTMLCanvasElement {
  const c = createEl("canvas");
  c.width = img.width; c.height = img.height;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

export class TlcModal extends Modal {
  private step: Step = "photo";
  private src: HTMLCanvasElement | null = null; // downscaled photo (≤1600 px)
  private quad: Pt[] = [];
  private plate: Img | null = null;
  private plateCanvas: HTMLCanvasElement | null = null;
  private baseline = 0.85;
  private front = 0.1;
  private spots: TSpot[] = [];
  private laneNames: string[] = [];
  private sensitivity = 0.5;
  private sys: SolventSystem;
  private stains = new Set<string>(["UV 254 nm"]);
  private section: SectionKey = "experimental";
  private note = "";
  private stage!: HTMLElement;

  constructor(private ctx: ElnCtx, section?: SectionKey) {
    super(ctx.plugin.app);
    this.sys = { ...(ctx.plugin.settings.lastSystem ?? DEFAULT_SYSTEM) };
    if (section) this.section = section;
    else if (/purif|work|isolat|complete/i.test(ctx.data.status ?? "")) this.section = "workup";
  }

  onOpen() {
    this.modalEl.addClass("ce-lb-modal", "ce-tlc-modal");
    this.titleEl.setText("TLC");
    this.stage = this.contentEl.createDiv();
    this.draw();
  }
  onClose() { this.contentEl.empty(); }

  private compounds(): string[] {
    const n = [...this.ctx.calc.rows.filter((r) => r.role !== "solvent").map((r) => r.src.name || r.formula), ...this.ctx.calc.products.map((p) => p.src.name || "product")].filter(Boolean) as string[];
    return [...new Set([...n, "product", "starting material", "side product", "?"])];
  }

  private draw() {
    const s = this.stage;
    s.empty();
    const steps: Step[] = ["photo", "crop", "analyse", "finish"];
    const nav = s.createDiv({ cls: "ce-tlc-steps" });
    steps.forEach((st, i) => nav.createSpan({ cls: "ce-tlc-step" + (st === this.step ? " is-on" : ""), text: `${i + 1}. ${st === "photo" ? "Photo" : st === "crop" ? "Plate" : st === "analyse" ? "Spots" : "Details"}` }));
    if (this.step === "photo") this.drawPhoto(s);
    else if (this.step === "crop") this.drawCrop(s);
    else if (this.step === "analyse") this.drawAnalyse(s);
    else this.drawFinish(s);
  }

  // ---------------------------------------------------------------- 1. photo
  private drawPhoto(s: HTMLElement) {
    s.createDiv({ cls: "ce-lb-hint", text: "Place the plate on a dark, even background, shoot from straight above, avoid glare. For UV-active spots take the photo under the UV lamp or circle them with pencil first." });
    const row = s.createDiv({ cls: "ce-lb-buttons" });
    const go = async (cap: boolean) => {
      const f = await pickImage(cap);
      if (!f) return;
      try {
        const im = await loadImage(f);
        const k = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
        const c = createEl("canvas");
        c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
        c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
        this.src = c;
        const q = detectPlate(imgFromCanvas(c));
        this.quad = q ?? this.fullQuad();
        if (!q) new Notice("Plate not found automatically — drag the corners");
        this.step = "crop";
        this.draw();
      } catch (e: any) { new Notice("Could not read image: " + (e?.message ?? e)); }
    };
    row.createEl("button", { text: "📷 Take photo", cls: "mod-cta" }).onclick = () => go(true);
    row.createEl("button", { text: "🖼 Choose image" }).onclick = () => go(false);
  }

  private fullQuad(): Pt[] {
    const w = this.src!.width, h = this.src!.height;
    return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  }

  // ---------------------------------------------------------------- 2. crop
  private drawCrop(s: HTMLElement) {
    const src = this.src!;
    s.createDiv({ cls: "ce-lb-hint", text: "Drag the 4 corners onto the plate edges (detected automatically when the plate is lighter than the background)." });
    const cv = s.createEl("canvas", { cls: "ce-tlc-canvas" });
    cv.width = src.width; cv.height = src.height;
    const g = cv.getContext("2d")!;
    const paint = () => {
      g.drawImage(src, 0, 0);
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.beginPath(); g.rect(0, 0, cv.width, cv.height);
      g.moveTo(this.quad[0].x, this.quad[0].y); for (let i = 3; i >= 0; i--) g.lineTo(this.quad[i].x, this.quad[i].y); g.closePath();
      g.fill("evenodd");
      g.strokeStyle = "#2e9bff"; g.lineWidth = Math.max(2, cv.width / 300);
      g.beginPath(); this.quad.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.stroke();
      const r = Math.max(10, cv.width / 45);
      for (const p of this.quad) { g.fillStyle = "rgba(46,155,255,0.35)"; g.beginPath(); g.arc(p.x, p.y, r, 0, 7); g.fill(); g.stroke(); }
    };
    paint();
    let drag = -1;
    const pos = (e: PointerEvent): Pt => { const b = cv.getBoundingClientRect(); return { x: ((e.clientX - b.left) / b.width) * cv.width, y: ((e.clientY - b.top) / b.height) * cv.height }; };
    cv.onpointerdown = (e) => {
      const p = pos(e);
      let best = -1, bd = Infinity;
      this.quad.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = i; } });
      if (bd < cv.width / 6) { drag = best; cv.setPointerCapture(e.pointerId); e.preventDefault(); }
    };
    cv.onpointermove = (e) => { if (drag < 0) return; const p = pos(e); this.quad[drag] = { x: Math.max(0, Math.min(cv.width, p.x)), y: Math.max(0, Math.min(cv.height, p.y)) }; paint(); };
    cv.onpointerup = () => { drag = -1; };
    const row = s.createDiv({ cls: "ce-lb-buttons" });
    row.createEl("button", { text: "← Photo" }).onclick = () => { this.step = "photo"; this.draw(); };
    row.createEl("button", { text: "Auto-detect" }).onclick = () => { const q = detectPlate(imgFromCanvas(src)); if (q) { this.quad = q; paint(); } else new Notice("No plate found"); };
    row.createEl("button", { text: "Full image" }).onclick = () => { this.quad = this.fullQuad(); paint(); };
    row.createEl("button", { text: "Rotate 90°" }).onclick = () => { this.quad = [this.quad[3], this.quad[0], this.quad[1], this.quad[2]]; paint(); };
    row.createEl("button", { text: "Next →", cls: "mod-cta" }).onclick = () => { this.makePlate(); this.step = "analyse"; this.draw(); };
  }

  private makePlate() {
    const { w, h } = warpSize(this.quad, 900);
    this.plate = warp(imgFromCanvas(this.src!), this.quad, w, h);
    this.plateCanvas = canvasFromImg(this.plate);
    const cm = contrastMap(this.plate);
    const l = detectLines(this.plate, cm);
    this.baseline = l.baseline ?? 0.88;
    this.front = l.front ?? 0.08;
    this.redetect(cm);
  }

  private redetect(cm = contrastMap(this.plate!)) {
    const keep = this.spots.filter((x) => x.manual);
    const sp = detectSpots(this.plate!, this.sensitivity, cm, { baseline: this.baseline, front: this.front })
      .filter((x) => x.y / this.plate!.height < this.baseline - 0.01 && x.y / this.plate!.height > this.front - 0.02);
    this.spots = [...sp.map((x) => ({ ...x, lane: 0, name: "" })), ...keep];
    this.relane();
  }

  private relane() {
    const { lane, centres } = clusterLanes(this.spots, this.plate!.width);
    this.spots.forEach((x, i) => (x.lane = lane[i]));
    while (this.laneNames.length < centres.length) {
      const i = this.laneNames.length;
      this.laneNames.push(centres.length === 3 ? ["SM", "Co", "RM"][i] : centres.length === 2 ? ["SM", "RM"][i] : LANE_LABELS[i] ?? String(i + 1));
    }
    this.laneNames.length = centres.length;
  }

  private rf(s: Spot) { return rfValue(s.y / this.plate!.height, this.baseline, this.front); }

  // ---------------------------------------------------------------- 3. analyse
  private drawAnalyse(s: HTMLElement) {
    const pl = this.plateCanvas!;
    s.createDiv({ cls: "ce-lb-hint", text: "Drag the green (baseline) and blue (solvent front) lines. Tap empty plate to add a spot, tap a spot to remove it." });
    const wrap = s.createDiv({ cls: "ce-tlc-plate-wrap" });
    const cv = wrap.createEl("canvas", { cls: "ce-tlc-canvas ce-tlc-plate" });
    cv.width = pl.width; cv.height = pl.height;
    const paint = () => this.paintPlate(cv.getContext("2d")!, cv.width, cv.height, true);
    paint();
    let drag: "base" | "front" | null = null, moved = false;
    const pos = (e: PointerEvent): Pt => { const b = cv.getBoundingClientRect(); return { x: ((e.clientX - b.left) / b.width) * cv.width, y: ((e.clientY - b.top) / b.height) * cv.height }; };
    cv.onpointerdown = (e) => {
      const p = pos(e), fy = p.y / cv.height, tol = 0.03;
      drag = Math.abs(fy - this.baseline) < tol ? "base" : Math.abs(fy - this.front) < tol ? "front" : null;
      moved = false;
      cv.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    cv.onpointermove = (e) => {
      if (!drag) return;
      const fy = Math.max(0, Math.min(1, pos(e).y / cv.height));
      if (drag === "base") this.baseline = Math.max(fy, this.front + 0.05); else this.front = Math.min(fy, this.baseline - 0.05);
      moved = true; paint(); list();
    };
    cv.onpointerup = (e) => {
      if (drag) { drag = null; if (moved) return; }
      const p = pos(e);
      const hit = this.spots.findIndex((x) => Math.hypot(x.x - p.x, x.y - p.y) < Math.max(x.r, cv.width / 40));
      if (hit >= 0) this.spots.splice(hit, 1);
      else this.spots.push({ x: p.x, y: p.y, r: cv.width / 45, area: 0, strength: 0, lane: 0, name: "", manual: true });
      this.relane(); paint(); list();
    };
    const sl = s.createDiv({ cls: "ce-lb-row" });
    sl.createSpan({ cls: "ce-lb-label", text: "Sensitivity" });
    const range = sl.createEl("input", { type: "range" });
    range.min = "0"; range.max = "1"; range.step = "0.05"; range.value = String(this.sensitivity);
    range.onchange = () => { this.sensitivity = +range.value; this.redetect(); paint(); list(); };
    sl.createEl("button", { text: "Clear spots" }).onclick = () => { this.spots = []; this.relane(); paint(); list(); };

    const lb = s.createDiv();
    const list = () => {
      lb.empty();
      if (!this.spots.length) { lb.createDiv({ cls: "ce-lb-hint", text: "No spots yet." }); return; }
      this.laneNames.forEach((ln, li) => {
        const box = lb.createDiv({ cls: "ce-tlc-lane" });
        const head = box.createDiv({ cls: "ce-lb-row" });
        head.createSpan({ cls: "ce-lb-anname", text: `Lane ${li + 1}` });
        chips(head, LANE_LABELS.slice(0, 5), (v) => { this.laneNames[li] = v; paint(); list(); }, { selected: ln });
        const inp = head.createEl("input", { type: "text", value: LANE_LABELS.includes(ln) ? "" : ln, placeholder: "custom", cls: "ce-lb-small" });
        inp.onchange = () => { if (inp.value.trim()) { this.laneNames[li] = inp.value.trim(); paint(); } };
        for (const sp of this.spots.filter((x) => x.lane === li).sort((a, b) => a.y - b.y)) {
          const r = box.createDiv({ cls: "ce-tlc-spotrow" });
          r.createSpan({ cls: "ce-tlc-rf", text: `Rf ${this.rf(sp).toFixed(2)}` });
          const sel = r.createEl("select", { cls: "dropdown" });
          sel.createEl("option", { value: "", text: "assign…" });
          for (const c of this.compounds()) sel.createEl("option", { value: c, text: c });
          sel.value = sp.name;
          sel.onchange = () => { sp.name = sel.value; paint(); };
        }
      });
    };
    list();
    const row = s.createDiv({ cls: "ce-lb-buttons" });
    row.createEl("button", { text: "← Plate" }).onclick = () => { this.step = "crop"; this.draw(); };
    row.createEl("button", { text: "Next →", cls: "mod-cta" }).onclick = () => { this.step = "finish"; this.draw(); };
  }

  private paintPlate(g: CanvasRenderingContext2D, w: number, h: number, handles: boolean) {
    g.drawImage(this.plateCanvas!, 0, 0, w, h);
    const lw = Math.max(2, w / 250);
    const line = (f: number, col: string, txt: string) => {
      g.strokeStyle = col; g.lineWidth = lw; g.setLineDash(handles ? [] : [lw * 3, lw * 2]);
      g.beginPath(); g.moveTo(0, f * h); g.lineTo(w, f * h); g.stroke(); g.setLineDash([]);
      if (handles) { g.fillStyle = col; g.beginPath(); g.arc(w - lw * 8, f * h, lw * 5, 0, 7); g.fill(); }
      g.font = `${Math.round(w / 22)}px sans-serif`; g.fillStyle = col; g.fillText(txt, lw * 3, f * h - lw * 2);
    };
    line(this.baseline, "#18a058", "baseline");
    line(this.front, "#2e7dff", "front");
    const fs = Math.max(11, Math.round(w / 20));
    g.font = `bold ${fs}px sans-serif`;
    const { centres } = clusterLanes(this.spots, this.plate!.width);
    centres.forEach((cx, i) => {
      const x = (cx / this.plate!.width) * w, t = this.laneNames[i] ?? "";
      g.fillStyle = "rgba(255,255,255,0.85)"; const tw = g.measureText(t).width;
      g.fillRect(x - tw / 2 - 3, this.baseline * h + fs * 0.3, tw + 6, fs * 1.2);
      g.fillStyle = "#222"; g.fillText(t, x - tw / 2, this.baseline * h + fs * 1.25);
    });
    g.font = `${Math.round(fs * 0.8)}px sans-serif`;
    for (const sp of this.spots) {
      const x = (sp.x / this.plate!.width) * w, y = (sp.y / this.plate!.height) * h, r = (sp.r / this.plate!.width) * w;
      g.strokeStyle = sp.manual ? "#e07b00" : "#d03050"; g.lineWidth = lw;
      g.beginPath(); g.ellipse(x, y, r, r * 0.8, 0, 0, 7); g.stroke();
      const t = this.rf(sp).toFixed(2);
      g.fillStyle = "rgba(255,255,255,0.8)"; const tw = g.measureText(t).width;
      g.fillRect(x + r + 2, y - fs * 0.45, tw + 4, fs * 0.9);
      g.fillStyle = "#b0203f"; g.fillText(t, x + r + 4, y + fs * 0.28);
    }
  }

  // ---------------------------------------------------------------- 4. finish
  private text(): string {
    const byName = new Map<string, number>();
    const lines: string[] = [];
    const stains = [...this.stains].join(", ") || "UV";
    const fmt = (sp: TSpot) => `${this.rf(sp).toFixed(2)}${sp.name ? ` (${sp.name})` : ""}`;
    const multi = this.laneNames.length > 1;
    if (multi && this.spots.length) {
      this.laneNames.forEach((ln, li) => {
        const sp = this.spots.filter((x) => x.lane === li).sort((a, b) => a.y - b.y);
        lines.push(`${ln}: ${sp.length ? sp.map(fmt).join(", ") : "–"}`);
        for (const x of sp) if (x.name) byName.set(x.name, this.rf(x));
      });
    }
    const rfs = multi ? [...byName].map(([n, r]) => `${r.toFixed(2)} (${n})`).join(", ") : this.spots.sort((a, b) => a.y - b.y).map(fmt).join(", ");
    let t = `TLC (${systemText(this.sys)}): ${rfs ? "Rf = " + rfs : "see image"}; detection: ${stains}`;
    if (multi) t += `\n   ${lines.join(" | ")}`;
    if (this.note.trim()) t += `\n   ${this.note.trim()}`;
    return t;
  }

  private drawFinish(s: HTMLElement) {
    label(s, "Eluent");
    const prev = { el: null as HTMLElement | null };
    solventPicker(s, this.sys, () => { this.ctx.plugin.settings.lastSystem = { ...this.sys }; upd(); });
    label(s, "Detection (multiple)");
    chips(s, STAINS, (v, el) => { if (this.stains.has(v)) this.stains.delete(v); else this.stains.add(v); el.toggleClass("is-on", this.stains.has(v)); upd(); }, { selected: [...this.stains] });
    label(s, "Remark");
    chips(s, ["full conversion", "incomplete conversion", "no conversion", "new spot", "streaking", "co-spot confirms identity", `${nowHM()}`], (v) => { this.note = this.note ? this.note + ", " + v : v; ta2.value = this.note; upd(); });
    const ta2 = s.createEl("input", { type: "text", cls: "ce-lb-wide", value: this.note, placeholder: "e.g. after 2 h" });
    ta2.oninput = () => { this.note = ta2.value; upd(); };
    label(s, "Into section");
    chips(s, ["Experimental", "Work-up"], (v) => { this.section = v === "Experimental" ? "experimental" : "workup"; this.draw(); }, { selected: this.section === "workup" ? "Work-up" : "Experimental" });
    const pv = s.createEl("pre", { cls: "ce-tlc-preview" });
    prev.el = pv;
    const upd = () => { pv.setText(this.text()); };
    upd();
    const row = s.createDiv({ cls: "ce-lb-buttons" });
    row.createEl("button", { text: "← Spots" }).onclick = () => { this.step = "analyse"; this.draw(); };
    row.createEl("button", { text: "Copy text" }).onclick = async () => { await navigator.clipboard.writeText(this.text()); new Notice("Copied"); };
    row.createEl("button", { text: "Insert into note", cls: "mod-cta" }).onclick = () => this.insert();
  }

  private async insert() {
    const pl = this.plateCanvas!;
    const scale = Math.min(1, 700 / pl.height);
    const c = createEl("canvas");
    c.width = Math.round(pl.width * scale); c.height = Math.round(pl.height * scale);
    this.paintPlate(c.getContext("2d")!, c.width, c.height, false);
    const blob: Blob = await new Promise((ok, err) => c.toBlob((b) => (b ? ok(b) : err(new Error("encode"))), "image/png"));
    const code = (this.ctx.data.code || this.ctx.file.basename).replace(/[\\/:*?"<>|\s]/g, "_");
    const f = await saveBinary(this.app, this.ctx.plugin.settings.elnMediaFolder, `TLC_${code}_${fileStamp()}.png`, blob);
    await this.ctx.plugin.saveSettings();
    await insertIntoNote(this.app, this.ctx.file, `${this.text()}\n   ![[${f.name}|180]]`, this.section, { numbered: this.section === "experimental", date: true });
    this.close();
  }
}
