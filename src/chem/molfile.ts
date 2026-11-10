// MDL Molfile V2000 reader/writer (V3000 reader for atoms/bonds).

import { BondStereo, ChemDoc, addAtom, addBond, buildGraph, emptyDoc } from "./model";
import { kekulize } from "./smiles";

const CHG_CODE: Record<number, number> = { 1: 3, 2: 2, 3: 1, [-1]: 5, [-2]: 6, [-3]: 7 };
const CODE_CHG: Record<number, number> = { 1: 3, 2: 2, 3: 1, 5: -1, 6: -2, 7: -3 };

const f = (v: number, w: number, p = 4) => v.toFixed(p).padStart(w);
const i3 = (v: number) => String(v).padStart(3);

export function writeMolfile(doc: ChemDoc, name = ""): string {
  const atoms = doc.atoms;
  const idx = new Map<number, number>();
  atoms.forEach((a, i) => idx.set(a.id, i + 1));
  const bonds = doc.bonds.filter((b) => idx.has(b.a) && idx.has(b.b));
  const lines: string[] = [];
  lines.push(name.slice(0, 80));
  lines.push("  ChemEdit          2D");
  lines.push("");
  lines.push(`${i3(atoms.length)}${i3(bonds.length)}  0  0  0  0  0  0  0  0999 V2000`);
  const scale = 1.5;
  for (const a of atoms) {
    const sym = a.el === "*" ? (a.label ? "R" : "*") : a.el;
    const chg = CHG_CODE[a.charge] ?? 0;
    lines.push(`${f(a.x * scale, 10)}${f(-a.y * scale, 10)}${f(0, 10)} ${sym.padEnd(3)} 0${i3(Math.abs(a.charge) <= 3 ? chg : 0)}  0  0  0  0  0  0  0${i3(a.map ?? 0)}  0  0`);
  }
  for (const b of bonds) {
    const st = b.stereo === 1 ? 1 : b.stereo === 6 ? 6 : b.stereo === 4 ? 4 : 0;
    lines.push(`${i3(idx.get(b.a)!)}${i3(idx.get(b.b)!)}${i3(b.order)}${i3(st)}`);
  }
  const charged = atoms.filter((a) => a.charge);
  for (let k = 0; k < charged.length; k += 8) {
    const chunk = charged.slice(k, k + 8);
    lines.push(`M  CHG${i3(chunk.length)}` + chunk.map((a) => ` ${i3(idx.get(a.id)!)} ${i3(a.charge)}`).join(""));
  }
  const iso = atoms.filter((a) => a.isotope);
  for (let k = 0; k < iso.length; k += 8) {
    const chunk = iso.slice(k, k + 8);
    lines.push(`M  ISO${i3(chunk.length)}` + chunk.map((a) => ` ${i3(idx.get(a.id)!)} ${i3(a.isotope!)}`).join(""));
  }
  const rad = atoms.filter((a) => a.radical);
  if (rad.length) lines.push(`M  RAD${i3(rad.length)}` + rad.map((a) => ` ${i3(idx.get(a.id)!)} ${i3(a.radical === 1 ? 2 : a.radical!)}`).join(""));
  const labels = atoms.filter((a) => a.el === "*" && a.label);
  for (const a of labels) lines.push(`A  ${i3(idx.get(a.id)!)}`, a.label!);
  lines.push("M  END");
  return lines.join("\n");
}

export function isMolfile(s: string): boolean {
  return /V2000|V3000/.test(s) && /M\s+END/.test(s);
}

export function parseMolfile(text: string): ChemDoc {
  const block = text.split(/\$\$\$\$/)[0];
  const lines = block.replace(/\r/g, "").split("\n");
  // find counts line
  let ci = lines.findIndex((l) => /V2000|V3000/.test(l));
  if (ci < 0) ci = 3;
  const doc = emptyDoc();
  if (/V3000/.test(lines[ci])) return parseV3000(lines, doc);
  const nA = parseInt(lines[ci].slice(0, 3)), nB = parseInt(lines[ci].slice(3, 6));
  const ids: number[] = [];
  const aromatic = new Set<number>();
  for (let k = 0; k < nA; k++) {
    const l = lines[ci + 1 + k];
    const x = parseFloat(l.slice(0, 10)), y = parseFloat(l.slice(10, 20));
    let sym = l.slice(31, 34).trim();
    const chg = parseInt(l.slice(36, 39)) || 0;
    const hcode = parseInt(l.slice(42, 45)) || 0;
    let label: string | undefined;
    if (sym === "R" || sym === "R#" || sym === "A" || sym === "Q" || sym === "L") { label = sym === "R#" ? "R" : sym; sym = "*"; }
    if (sym === "D") sym = "H";
    const a = addAtom(doc, sym, x, -y, { charge: CODE_CHG[chg] ?? 0 });
    if (label) a.label = label;
    if (hcode > 0) a.hCount = hcode - 1;
    ids.push(a.id);
  }
  for (let k = 0; k < nB; k++) {
    const l = lines[ci + 1 + nA + k];
    const a = parseInt(l.slice(0, 3)) - 1, b = parseInt(l.slice(3, 6)) - 1;
    const order = parseInt(l.slice(6, 9));
    const st = parseInt(l.slice(9, 12)) || 0;
    const stereo: BondStereo = st === 1 ? 1 : st === 6 ? 6 : st === 4 ? 4 : 0;
    const bond = addBond(doc, ids[a], ids[b], order === 4 ? 4 : order >= 1 && order <= 3 ? order : 1, stereo);
    if (order === 4) { aromatic.add(ids[a]); aromatic.add(ids[b]); }
    void bond;
  }
  let chgSeen = false;
  for (let k = ci + 1 + nA + nB; k < lines.length; k++) {
    const l = lines[k];
    if (l.startsWith("M  END")) break;
    if (l.startsWith("M  CHG") || l.startsWith("M  ISO") || l.startsWith("M  RAD")) {
      const n = parseInt(l.slice(6, 9));
      if (l.startsWith("M  CHG") && !chgSeen) { chgSeen = true; for (const a of doc.atoms) a.charge = 0; }
      for (let j = 0; j < n; j++) {
        const ai = parseInt(l.slice(9 + j * 8, 13 + j * 8)) - 1;
        const v = parseInt(l.slice(13 + j * 8, 17 + j * 8));
        const at = doc.atoms[ai];
        if (!at) continue;
        if (l.startsWith("M  CHG")) at.charge = v;
        else if (l.startsWith("M  ISO")) at.isotope = v;
        else at.radical = v === 2 ? 1 : v;
      }
    } else if (l.startsWith("A  ")) {
      const ai = parseInt(l.slice(3, 6)) - 1;
      const txt = (lines[k + 1] ?? "").trim();
      if (doc.atoms[ai] && txt) { doc.atoms[ai].label = txt; doc.atoms[ai].el = "*"; }
      k++;
    }
  }
  if (aromatic.size) kekulize(doc, buildGraph(doc), aromatic);
  normaliseScale(doc);
  return doc;
}

function parseV3000(lines: string[], doc: ChemDoc): ChemDoc {
  const idMap = new Map<string, number>();
  let mode = "";
  const aromatic = new Set<number>();
  // join continuation lines ending with '-'
  const joined: string[] = [];
  for (let k = 0; k < lines.length; k++) {
    let l = lines[k];
    while (l.endsWith("-") && k + 1 < lines.length) { l = l.slice(0, -1) + lines[++k].replace(/^M {2}V30 /, ""); }
    joined.push(l);
  }
  for (const l of joined) {
    if (!l.startsWith("M  V30")) continue;
    const body = l.slice(7).trim();
    if (body.startsWith("BEGIN ATOM")) { mode = "atom"; continue; }
    if (body.startsWith("BEGIN BOND")) { mode = "bond"; continue; }
    if (body.startsWith("END")) { mode = ""; continue; }
    const parts = body.split(/\s+/);
    if (mode === "atom") {
      const [idx, sym0, x, y] = parts;
      let sym = sym0;
      let label: string | undefined;
      if (/^R/.test(sym)) { label = "R"; sym = "*"; }
      const a = addAtom(doc, sym, parseFloat(x), -parseFloat(y));
      if (label) a.label = label;
      for (const p of parts.slice(6)) {
        const [k, v] = p.split("=");
        if (k === "CHG") a.charge = parseInt(v);
        if (k === "MASS") a.isotope = parseInt(v);
        if (k === "HCOUNT" && parseInt(v) > 0) a.hCount = parseInt(v) - 1;
      }
      idMap.set(idx, a.id);
    } else if (mode === "bond") {
      const [, type, a1, a2] = parts;
      const order = parseInt(type);
      let stereo: BondStereo = 0;
      for (const p of parts.slice(4)) {
        const [k, v] = p.split("=");
        if (k === "CFG") stereo = v === "1" ? 1 : v === "3" ? 6 : v === "2" ? 4 : 0;
      }
      const A = idMap.get(a1)!, B = idMap.get(a2)!;
      addBond(doc, A, B, order === 4 ? 4 : order, stereo);
      if (order === 4) { aromatic.add(A); aromatic.add(B); }
    }
  }
  if (aromatic.size) kekulize(doc, buildGraph(doc), aromatic);
  normaliseScale(doc);
  return doc;
}

/** Scale coordinates so the median bond length is 1. */
export function normaliseScale(doc: ChemDoc) {
  const g = buildGraph(doc);
  const L = doc.bonds.map((b) => { const p = g.atomById.get(b.a)!, q = g.atomById.get(b.b)!; return Math.hypot(p.x - q.x, p.y - q.y); }).filter((x) => x > 1e-4).sort((a, b) => a - b);
  if (!L.length) return;
  const med = L[Math.floor(L.length / 2)];
  const s = 1 / med;
  for (const a of doc.atoms) { a.x *= s; a.y *= s; }
}

export function hasCoordinates(doc: ChemDoc): boolean {
  if (doc.atoms.length < 2) return true;
  return doc.atoms.some((a) => Math.abs(a.x) > 1e-4 || Math.abs(a.y) > 1e-4);
}
