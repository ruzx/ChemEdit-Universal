// Additional file formats: RXN (V2000), SDF, ChemDraw CDXML, Ketcher KET.

import { ELEMENTS, atomicNumber } from "./elements";
import { ArrowKind, BondStereo, ChemDoc, addAtom, addBond, buildGraph, components, emptyDoc, mergeInto, newId, translateDoc, docBBox, hydrogenCount } from "./model";
import { parseMolfile, writeMolfile, normaliseScale, hasCoordinates } from "./molfile";
import { layoutDoc, arrangeDoc } from "./layout";
import { reactionRoles, Role, kekulize } from "./smiles";
import { expandAbbreviations, lookupAbbreviation } from "./abbrev";

// ------------------------------------------------------------------ RXN

export function isRxn(s: string) { return /^\s*\$RXN/.test(s); }

export function parseRxn(text: string): ChemDoc {
  const lines = text.replace(/\r/g, "").split("\n");
  const start = lines.findIndex((l) => l.startsWith("$RXN"));
  const counts = lines[start + 4] ?? "";
  const nR = parseInt(counts.slice(0, 3)) || 0, nP = parseInt(counts.slice(3, 6)) || 0, nA = parseInt(counts.slice(6, 9)) || 0;
  const blocks = text.replace(/\r/g, "").split(/^\$MOL\s*$/m).slice(1);
  const doc = emptyDoc();
  const roles = new Map<number, Role>();
  blocks.forEach((b, i) => {
    const m = parseMolfile(b);
    if (!hasCoordinates(m)) layoutDoc(m);
    const role: Role = i < nR ? "r" : i < nR + nP ? "p" : "a";
    void nA;
    const map = mergeInto(doc, m);
    for (const a of m.atoms) roles.set(map.get(a.id)!, role);
  });
  arrangeDoc(doc, roles);
  return doc;
}

function rolesOf(doc: ChemDoc) {
  const g = buildGraph(doc);
  const comps = components(doc, g);
  const r = reactionRoles(doc, comps);
  return { comps, roles: r };
}

function subDoc(doc: ChemDoc, ids: number[]): ChemDoc {
  const s = new Set(ids);
  const d = emptyDoc();
  mergeInto(d, { atoms: doc.atoms.filter((a) => s.has(a.id)), bonds: doc.bonds.filter((b) => s.has(b.a) && s.has(b.b)), arrows: [], pluses: [], texts: [], nextId: 0 });
  return d;
}

export function writeRxn(src: ChemDoc): string {
  const doc = expandAbbreviations(src);
  const { comps, roles } = rolesOf(doc);
  const R = comps.filter((_, i) => !roles || roles[i] === "r");
  const P = roles ? comps.filter((_, i) => roles[i] === "p") : [];
  const A = roles ? comps.filter((_, i) => roles[i] === "a") : [];
  const i3 = (v: number) => String(v).padStart(3);
  let out = `$RXN\n\n  ChemEdit\n\n${i3(R.length)}${i3(P.length)}${A.length ? i3(A.length) : ""}\n`;
  for (const c of [...R, ...P, ...A]) out += "$MOL\n" + writeMolfile(subDoc(doc, c)) + "\n";
  return out;
}

// ------------------------------------------------------------------ SDF

export interface SdfRecord { doc: ChemDoc; name: string; fields: Record<string, string> }

export function isSdf(s: string) { return /\$\$\$\$/.test(s) && /V[23]000/.test(s); }

export function parseSdf(text: string): SdfRecord[] {
  const out: SdfRecord[] = [];
  for (const rec of text.replace(/\r/g, "").split(/^\$\$\$\$\s*$/m)) {
    if (!/V[23]000/.test(rec)) continue;
    const end = rec.search(/^M\s+END/m);
    const molPart = rec.slice(0, end + 6);
    const rest = rec.slice(end + 6);
    const doc = parseMolfile(molPart.replace(/^\n+/, (m) => m.length > 1 ? "\n" : m));
    if (!hasCoordinates(doc)) layoutDoc(doc);
    const fields: Record<string, string> = {};
    const re = />\s*(?:<([^>]+)>)?[^\n]*\n([\s\S]*?)(?=\n\s*\n|\n?$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest))) if (m[1]) fields[m[1].trim()] = m[2].trim();
    const name = molPart.replace(/^\n/, "").split("\n")[0].trim() || fields["NAME"] || fields["Name"] || fields["ID"] || `Record ${out.length + 1}`;
    out.push({ doc, name, fields });
  }
  return out;
}

export function writeSdf(records: Array<{ doc: ChemDoc; name?: string; fields?: Record<string, string> }>): string {
  return records.map((r) => {
    let s = writeMolfile(expandAbbreviations(r.doc), r.name ?? "") + "\n";
    for (const [k, v] of Object.entries(r.fields ?? {})) s += `> <${k}>\n${v}\n\n`;
    return s + "$$$$";
  }).join("\n") + "\n";
}

/** Each connected fragment as one SDF record. */
export function docToSdf(doc: ChemDoc, nameBase = "Structure"): string {
  const d = expandAbbreviations(doc);
  const g = buildGraph(d);
  return writeSdf(components(d, g).map((c, i) => ({ doc: subDoc(d, c), name: `${nameBase} ${i + 1}` })));
}

/** All SDF records placed side by side in one document. */
export function sdfToDoc(text: string): ChemDoc {
  const recs = parseSdf(text);
  const doc = emptyDoc();
  let x = 0;
  for (const r of recs.slice(0, 60)) {
    const bb = docBBox(r.doc);
    const map = mergeInto(doc, r.doc);
    translateDoc(doc, x - bb.minX, -(bb.minY + bb.maxY) / 2, new Set(map.values()));
    x += bb.w + 2;
  }
  return doc;
}

// ------------------------------------------------------------------ tiny XML

export interface XNode { tag: string; attr: Record<string, string>; children: XNode[]; text: string }

export function parseXml(src: string): XNode {
  const root: XNode = { tag: "#root", attr: {}, children: [], text: "" };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_: string, n: string) => String.fromCharCode(+n)).replace(/&#x([\da-f]+);/gi, (_: string, n: string) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, "&");
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const node: XNode = { tag: m[3], attr: {}, children: [], text: "" };
      const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = ar.exec(m[4]))) node.attr[a[1]] = unesc(a[2] ?? a[3] ?? "");
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6]) top.text += unesc(m[6]);
  }
  return root;
}

const walk = (n: XNode, fn: (x: XNode, parent: XNode | null) => void, parent: XNode | null = null) => { fn(n, parent); for (const c of n.children) walk(c, fn, n); };
const textOf = (n: XNode): string => n.text + n.children.map(textOf).join("");

// ------------------------------------------------------------------ CDXML

export function isCdxml(s: string) { return /<CDXML[\s>]/.test(s); }

export function parseCdxml(text: string): ChemDoc {
  const root = parseXml(text);
  let cd: XNode | null = null;
  walk(root, (x) => { if (!cd && x.tag === "CDXML") cd = x; });
  if (!cd) throw new Error("Not a CDXML document");
  const bl = parseFloat((cd as XNode).attr.BondLength ?? "14.4") || 14.4;
  const doc = emptyDoc();
  const idMap = new Map<string, number>();
  const pt = (s: string | undefined) => { const v = (s ?? "0 0").trim().split(/\s+/).map(Number); return { x: v[0] / bl, y: v[1] / bl }; };

  const readFragment = (frag: XNode) => {
    for (const n of frag.children.filter((c) => c.tag === "n")) {
      const type = n.attr.NodeType ?? "Element";
      if (type === "ExternalConnectionPoint") continue;
      const p = pt(n.attr.p);
      const z = parseInt(n.attr.Element ?? "6");
      const label = n.children.find((c) => c.tag === "t");
      let a;
      if (type === "Nickname" || type === "Fragment" || type === "GenericNickname" || type === "Unspecified" || type === "Anonymous") {
        const txt = label ? textOf(label).trim() : (n.attr.GenericNickname ?? "R");
        a = addAtom(doc, "*", p.x, p.y, { label: txt });
        const ex = lookupAbbreviation(txt);
        if (ex) a.expand = ex;
      } else {
        a = addAtom(doc, ELEMENTS[z - 1] ?? "C", p.x, p.y, { charge: parseInt(n.attr.Charge ?? "0") || 0 });
        if (n.attr.Isotope) a.isotope = parseInt(n.attr.Isotope);
        if (n.attr.NumHydrogens !== undefined) a.hCount = parseInt(n.attr.NumHydrogens);
        if (n.attr.Radical && n.attr.Radical !== "None") a.radical = 1;
      }
      idMap.set(n.attr.id, a.id);
    }
    for (const b of frag.children.filter((c) => c.tag === "b")) {
      const A = idMap.get(b.attr.B), B = idMap.get(b.attr.E);
      if (A === undefined || B === undefined) continue;
      const o = b.attr.Order ?? "1";
      const order = o === "2" ? 2 : o === "3" ? 3 : o === "1.5" ? 4 : 1;
      const disp = b.attr.Display ?? "";
      let st: BondStereo = 0, from = A, to = B;
      if (disp === "WedgeBegin") st = 1;
      else if (disp === "WedgeEnd") { st = 1; from = B; to = A; }
      else if (disp === "WedgedHashBegin") st = 6;
      else if (disp === "WedgedHashEnd") { st = 6; from = B; to = A; }
      else if (disp === "Wavy") st = 4;
      const bd = addBond(doc, from, to, order === 4 ? 4 : order, st);
      if (bd && b.attr.DoublePosition) bd.dbl = b.attr.DoublePosition === "Center" ? 2 : b.attr.DoublePosition === "Right" ? -1 : 1;
    }
  };

  walk(cd, (x, parent) => {
    if (x.tag === "fragment" && parent && parent.tag !== "n") readFragment(x);
    else if (x.tag === "t" && parent && (parent.tag === "page" || parent.tag === "group")) {
      const p = pt(x.attr.p);
      const t = textOf(x).trim();
      if (t) doc.texts.push({ id: newId(doc), x: p.x + t.length * 0.18, y: p.y - 0.2, text: t });
    } else if (x.tag === "arrow" && x.attr.Head3D && x.attr.Tail3D) {
      const h = pt(x.attr.Head3D), t = pt(x.attr.Tail3D);
      let kind: ArrowKind = "forward";
      if (x.attr.ArrowheadType === "Hollow" || x.attr.NoGo === "Retro") kind = "retro";
      else if ((x.attr.ArrowheadHead ?? "").startsWith("Half") && (x.attr.ArrowheadTail ?? "").startsWith("Half")) kind = "equilibrium";
      else if (x.attr.ArrowheadHead && x.attr.ArrowheadTail) kind = "resonance";
      if (x.attr.LineType === "Dashed") kind = "dashed";
      doc.arrows.push({ id: newId(doc), x1: t.x, y1: t.y, x2: h.x, y2: h.y, kind });
    } else if (x.tag === "graphic") {
      const bb = (x.attr.BoundingBox ?? "").split(/\s+/).map(Number);
      if (bb.length < 4) return;
      if (x.attr.GraphicType === "Line" && x.attr.ArrowType && !hasArrowSibling(parent, x)) {
        // BoundingBox = head(x,y) tail(x,y) for arrows in older CDXML
        doc.arrows.push({ id: newId(doc), x1: bb[2] / bl, y1: bb[3] / bl, x2: bb[0] / bl, y2: bb[1] / bl, kind: /Equilibrium|Resonance/.test(x.attr.ArrowType) ? (x.attr.ArrowType.includes("Resonance") ? "resonance" : "equilibrium") : x.attr.ArrowType === "RetroSynthetic" ? "retro" : "forward" });
      } else if (x.attr.GraphicType === "Symbol" && x.attr.SymbolType === "Plus") {
        doc.pluses.push({ id: newId(doc), x: (bb[0] + bb[2]) / 2 / bl, y: (bb[1] + bb[3]) / 2 / bl });
      }
    }
  });
  const arom = new Set<number>();
  for (const b of doc.bonds) if (b.order === 4) { arom.add(b.a); arom.add(b.b); }
  if (arom.size) kekulize(doc, buildGraph(doc), arom);
  return doc;
}

function hasArrowSibling(parent: XNode | null, g: XNode) {
  return !!parent?.children.some((c) => c.tag === "arrow" && (c.attr.id === g.attr.SupersededBy || g.attr.SupersededBy));
}

export function writeCdxml(src: ChemDoc): string {
  const doc = expandAbbreviations(src);
  const g = buildGraph(doc);
  const BL = 14.4;
  const bb = docBBox(doc);
  const ox = 40 - bb.minX * BL, oy = 40 - bb.minY * BL;
  const P = (x: number, y: number) => `${(x * BL + ox).toFixed(2)} ${(y * BL + oy).toFixed(2)}`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let id = 1000;
  const nid = new Map<number, number>();
  let body = "";
  for (const comp of components(doc, g)) {
    body += `<fragment id="${id++}">`;
    for (const aid of comp) {
      const a = g.atomById.get(aid)!;
      const i = id++;
      nid.set(aid, i);
      let attrs = `id="${i}" p="${P(a.x, a.y)}"`;
      if (a.el !== "C" && a.el !== "*") attrs += ` Element="${atomicNumber(a.el)}"`;
      if (a.charge) attrs += ` Charge="${a.charge}"`;
      if (a.isotope) attrs += ` Isotope="${a.isotope}"`;
      const h = hydrogenCount(g, a);
      const showLabel = a.el !== "C" || g.adj.get(aid)!.length === 0 || a.charge !== 0;
      if (a.hCount !== undefined || showLabel) attrs += ` NumHydrogens="${h}"`;
      if (a.el === "*") attrs += ` NodeType="GenericNickname" GenericNickname="${esc(a.label ?? "R")}"`;
      body += `<n ${attrs}`;
      if (showLabel) {
        const lab = (a.el === "*" ? a.label ?? "R" : a.el) + (h && a.el !== "*" ? "H" + (h > 1 ? h : "") : "");
        body += `><t p="${P(a.x - 0.2, a.y + 0.25)}" LabelJustification="Left"><s font="3" size="10" face="96">${esc(lab)}</s></t></n>`;
      } else body += "/>";
    }
    for (const b of doc.bonds) {
      if (!comp.includes(b.a)) continue;
      let attrs = `id="${id++}" B="${nid.get(b.a)}" E="${nid.get(b.b)}"`;
      if (b.order !== 1) attrs += ` Order="${b.order}"`;
      if (b.stereo === 1) attrs += ` Display="WedgeBegin"`;
      else if (b.stereo === 6) attrs += ` Display="WedgedHashBegin"`;
      else if (b.stereo === 4) attrs += ` Display="Wavy"`;
      if (b.order === 2 && b.dbl) attrs += ` DoublePosition="${b.dbl === 2 ? "Center" : b.dbl === 1 ? "Left" : "Right"}"`;
      body += `<b ${attrs}/>`;
    }
    body += `</fragment>`;
  }
  for (const t of doc.texts) {
    body += `<t id="${id++}" p="${P(t.x - t.text.length * 0.18, t.y + 0.2)}"><s font="3" size="10" face="96">${esc(t.text)}</s></t>`;
  }
  for (const p of doc.pluses) {
    body += `<graphic id="${id++}" BoundingBox="${P(p.x - 0.2, p.y - 0.2)} ${P(p.x + 0.2, p.y + 0.2)}" GraphicType="Symbol" SymbolType="Plus"/>`;
  }
  for (const r of doc.arrows) {
    let extra = `ArrowheadHead="Full" ArrowheadType="Solid"`;
    if (r.kind === "equilibrium") extra = `ArrowheadHead="HalfLeft" ArrowheadTail="HalfLeft" ArrowheadType="Solid" ArrowShaftSpacing="4"`;
    if (r.kind === "resonance") extra = `ArrowheadHead="Full" ArrowheadTail="Full" ArrowheadType="Solid"`;
    if (r.kind === "retro") extra = `ArrowheadHead="Full" ArrowheadType="Hollow" ArrowShaftSpacing="4"`;
    if (r.kind === "dashed") extra += ` LineType="Dashed"`;
    const [hx, hy] = P(r.x2, r.y2).split(" "), [tx, ty] = P(r.x1, r.y1).split(" ");
    body += `<arrow id="${id++}" BoundingBox="${P(Math.min(r.x1, r.x2), Math.min(r.y1, r.y2))} ${P(Math.max(r.x1, r.x2), Math.max(r.y1, r.y2))}" FillType="None" ${extra} Head3D="${hx} ${hy} 0" Tail3D="${tx} ${ty} 0"/>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd" >
<CDXML CreationProgram="ChemEdit" BondLength="14.40" LineWidth="0.60" BoldWidth="2" HashSpacing="2.50" MarginWidth="1.60" BondSpacing="18" LabelFont="3" LabelSize="10" LabelFace="96" CaptionFont="3" CaptionSize="10" color="0" bgcolor="1">
<colortable><color r="1" g="1" b="1"/><color r="0" g="0" b="0"/></colortable>
<fonttable><font id="3" charset="iso-8859-1" name="Arial"/></fonttable>
<page id="1">${body}</page>
</CDXML>
`;
}

// ------------------------------------------------------------------ Ketcher KET

export function isKet(s: string) { const t = s.trim(); return t.startsWith("{") && t.includes('"root"'); }

interface KetAtom { label?: string; type?: string; location?: number[]; charge?: number; isotope?: number; implicitHCount?: number; alias?: string; $refs?: unknown }
interface KetBond { type: number; atoms: number[]; stereo?: number }
interface KetMol { type: string; atoms?: KetAtom[]; bonds?: KetBond[] }
interface KetNode { $ref?: string; type?: string; location?: number[]; data?: { pos?: Array<{ x: number; y: number; z?: number }>; mode?: string; content?: string; position?: { x: number; y: number } } }
interface KetDoc { root?: { nodes: KetNode[] }; [key: string]: unknown }

export function parseKet(text: string): ChemDoc {
  const o = JSON.parse(text) as KetDoc;
  const doc = emptyDoc();
  const nodes: KetNode[] = o.root?.nodes ?? [];
  for (const n of nodes) {
    if (n.$ref) {
      const m = o[n.$ref] as KetMol | undefined;
      if (!m || m.type !== "molecule") continue;
      const ids: number[] = [];
      for (const a of m.atoms ?? []) {
        const loc = a.location ?? [0, 0, 0];
        const isLabel = a.type === "rg-label" || a.type === "atom-list" || !a.label;
        const at = addAtom(doc, isLabel ? "*" : a.label === "D" ? "H" : a.label ?? "C", loc[0], -loc[1], { charge: a.charge ?? 0 });
        if (isLabel) at.label = "R";
        if (a.isotope) at.isotope = a.isotope;
        if (a.implicitHCount !== undefined) at.hCount = a.implicitHCount;
        if (a.alias) { at.label = a.alias; at.el = "*"; const ex = lookupAbbreviation(a.alias); if (ex) at.expand = ex; }
        ids.push(at.id);
      }
      for (const b of m.bonds ?? []) {
        const st: BondStereo = b.stereo === 1 ? 1 : b.stereo === 6 ? 6 : b.stereo === 4 ? 4 : 0;
        addBond(doc, ids[b.atoms[0]], ids[b.atoms[1]], b.type >= 1 && b.type <= 4 ? b.type : 1, st);
      }
    } else if (n.type === "arrow") {
      const pos = n.data?.pos ?? [];
      if (pos.length >= 2) {
        const mode: string = n.data?.mode ?? "open-angle";
        const kind: ArrowKind = mode.includes("equilibrium") ? "equilibrium" : mode.includes("retrosynthetic") ? "retro" : mode.includes("both-ends") ? "resonance" : mode.includes("dashed") ? "dashed" : "forward";
        doc.arrows.push({ id: newId(doc), x1: pos[0].x, y1: -pos[0].y, x2: pos[1].x, y2: -pos[1].y, kind });
      }
    } else if (n.type === "plus") {
      const loc = n.location ?? [0, 0, 0];
      doc.pluses.push({ id: newId(doc), x: loc[0], y: -loc[1] });
    } else if (n.type === "text") {
      try {
        const c = JSON.parse(n.data?.content ?? "{}") as { blocks?: Array<{ text?: string }> };
        const t = (c.blocks ?? []).map((b) => b.text ?? "").join("\n");
        const p = n.data?.position ?? { x: 0, y: 0 };
        if (t) doc.texts.push({ id: newId(doc), x: p.x + t.length * 0.15, y: -p.y, text: t });
      } catch { /* */ }
    }
  }
  const arom = new Set<number>();
  for (const b of doc.bonds) if (b.order === 4) { arom.add(b.a); arom.add(b.b); }
  if (arom.size) kekulize(doc, buildGraph(doc), arom);
  normaliseScale(doc);
  return doc;
}

export function writeKet(src: ChemDoc): string {
  const doc = expandAbbreviations(src);
  const g = buildGraph(doc);
  const nodesOut: KetNode[] = [];
  const out: KetDoc = { root: { nodes: nodesOut } };
  components(doc, g).forEach((comp, i) => {
    const idx = new Map<number, number>();
    const atoms = comp.map((id, k) => {
      idx.set(id, k);
      const a = g.atomById.get(id)!;
      const o: KetAtom = { label: a.el === "*" ? "C" : a.el, location: [+a.x.toFixed(4), +(-a.y).toFixed(4), 0] };
      if (a.charge) o.charge = a.charge;
      if (a.isotope) o.isotope = a.isotope;
      return o;
    });
    const bonds = doc.bonds.filter((b) => idx.has(b.a)).map((b) => {
      const o: KetBond = { type: b.order, atoms: [idx.get(b.a) ?? 0, idx.get(b.b) ?? 0] };
      if (b.stereo) o.stereo = b.stereo;
      return o;
    });
    out[`mol${i}`] = { type: "molecule", atoms, bonds } satisfies KetMol;
    nodesOut.push({ $ref: `mol${i}` });
  });
  for (const r of doc.arrows) {
    const mode = r.kind === "equilibrium" ? "equilibrium-filled-half-bow" : r.kind === "retro" ? "retrosynthetic" : r.kind === "resonance" ? "filled-triangle-both-ends" : r.kind === "dashed" ? "dashed-open-angle" : "open-angle";
    nodesOut.push({ type: "arrow", data: { mode, pos: [{ x: r.x1, y: -r.y1, z: 0 }, { x: r.x2, y: -r.y2, z: 0 }] } });
  }
  for (const p of doc.pluses) nodesOut.push({ type: "plus", location: [p.x, -p.y, 0] });
  return JSON.stringify(out, null, 1);
}
