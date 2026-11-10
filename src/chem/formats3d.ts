// Extra formats: CML (read/write), XYZ (read/write), Tripos Mol2 (read/write), PDB (read HETATM/ATOM + CONECT),
// multi-line SMILES / CSV lists (read → records).
// 3D formats are converted to clean 2D drawings: bonds are perceived from covalent radii (if missing),
// bond orders from valence/hydrogen deficit (when H are present) or bond lengths, then a fresh 2D layout.

import { ChemDoc, emptyDoc, addAtom, addBond, buildGraph } from "./model";
import { parseXml, XNode, SdfRecord } from "./formats";
import { layoutDoc } from "./layout";
import { implicitHydrogens } from "./elements";

const COV: Record<string, number> = { H: 0.31, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Br: 1.2, I: 1.39, Se: 1.2, Li: 1.28, Na: 1.66, K: 2.03, Mg: 1.41, Al: 1.21, Zn: 1.22, Cu: 1.32, Fe: 1.32, Pd: 1.39, Pt: 1.36, Sn: 1.39, Ni: 1.24, Co: 1.26, Ru: 1.46, Rh: 1.42, Ir: 1.41, Au: 1.36, Ag: 1.45, Hg: 1.32, Ti: 1.6, B_: 0.84 };
const VAL: Record<string, number> = { H: 1, C: 4, N: 3, O: 2, S: 2, P: 3, B: 3, Si: 4, F: 1, Cl: 1, Br: 1, I: 1, Se: 2 };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

interface A3 { el: string; x: number; y: number; z: number; charge?: number }
interface B3 { a: number; b: number; order: number }

/** Build a 2D ChemDoc from 3D atoms (+ optional bonds). */
export function docFrom3D(atoms: A3[], bonds: B3[] | null, opts: { keepH?: boolean } = {}): ChemDoc {
  const n = atoms.length;
  let bs: B3[] = bonds ? bonds.slice() : [];
  if (!bonds) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = atoms[i], b = atoms[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const lim = (COV[a.el] ?? 1.5) + (COV[b.el] ?? 1.5) + 0.45;
      if (d > 0.4 && d < lim && !(a.el === "H" && b.el === "H")) bs.push({ a: i, b: j, order: 1 });
    }
    // H: keep only its nearest partner
    const hb = new Map<number, B3>();
    const dist = (x: B3) => { const p = atoms[x.a], q = atoms[x.b]; return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z); };
    for (const x of bs) for (const h of [x.a, x.b]) if (atoms[h].el === "H") { const o = hb.get(h); if (!o || dist(x) < dist(o)) hb.set(h, x); }
    bs = bs.filter((x) => [x.a, x.b].every((h) => atoms[h].el !== "H" || hb.get(h) === x));
    assignOrders(atoms, bs);
  }
  const doc = emptyDoc();
  const ids: number[] = [];
  const drop = new Set<number>();
  atoms.forEach((a, i) => {
    if (a.el === "H" && !opts.keepH) {
      const partner = bs.find((x) => x.a === i || x.b === i);
      if (partner && atoms[partner.a === i ? partner.b : partner.a].el !== "H") { drop.add(i); ids.push(-1); return; }
    }
    ids.push(addAtom(doc, a.el, a.x, -a.y, { charge: a.charge ?? 0 }).id);
  });
  for (const b of bs) if (!drop.has(b.a) && !drop.has(b.b)) addBond(doc, ids[b.a], ids[b.b], Math.min(3, Math.max(1, b.order)));
  layoutDoc(doc);
  return doc;
}

/** Bond orders from hydrogen deficit (H present) or bond lengths (heavy atoms only). */
function assignOrders(atoms: A3[], bs: B3[]) {
  const hasH = atoms.some((a) => a.el === "H");
  const len = (b: B3) => { const p = atoms[b.a], q = atoms[b.b]; return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z); };
  const sum = new Array(atoms.length).fill(0);
  for (const b of bs) { sum[b.a] += b.order; sum[b.b] += b.order; }
  const deficit = (i: number) => {
    const v = VAL[atoms[i].el];
    if (v === undefined) return 0;
    if (hasH) return v - sum[i];
    // heavy-atom only: assume unsaturation only where bonds are short (handled below)
    return v - sum[i];
  };
  const short = (b: B3, f: number) => len(b) < f * ((COV[atoms[b.a].el] ?? 1) + (COV[atoms[b.b].el] ?? 1));
  // candidate multiple bonds, shortest first
  const cand = bs.filter((b) => (hasH ? VAL[atoms[b.a].el] !== undefined && VAL[atoms[b.b].el] !== undefined : short(b, 0.93))).sort((p, q) => len(p) / ((COV[atoms[p.a].el] ?? 1) + (COV[atoms[p.b].el] ?? 1)) - len(q) / ((COV[atoms[q.a].el] ?? 1) + (COV[atoms[q.b].el] ?? 1)));
  // maximum matching of unsaturated atoms over candidate bonds (augmenting paths) → double bonds
  const inc = new Map<number, B3[]>();
  for (const x of cand) for (const i of [x.a, x.b]) { if (!inc.has(i)) inc.set(i, []); inc.get(i)!.push(x); }
  const mate = new Map<number, B3>();
  const other = (x: B3, i: number) => (x.a === i ? x.b : x.a);
  const free = (i: number) => deficit(i) > 0 && !mate.has(i);
  const augment = (i: number, seen: Set<number>): boolean => {
    for (const x of inc.get(i) ?? []) {
      const j = other(x, i);
      if (seen.has(j) || deficit(j) <= 0) continue;
      seen.add(j);
      const mj = mate.get(j);
      if (!mj) { mate.set(i, x); mate.set(j, x); return true; }
      const k = other(mj, j);
      mate.delete(k);
      if (augment(k, seen)) { mate.set(i, x); mate.set(j, x); return true; }
      mate.set(k, mj);
    }
    return false;
  };
  for (const i of inc.keys()) if (free(i)) augment(i, new Set([i]));
  for (const x of new Set(mate.values())) { x.order = 2; sum[x.a]++; sum[x.b]++; }
  // triple bonds: remaining deficit on very short bonds
  for (const x of cand) if (x.order === 2 && deficit(x.a) > 0 && deficit(x.b) > 0 && (hasH || short(x, 0.88))) { x.order = 3; sum[x.a]++; sum[x.b]++; }
}

// ---------------------------------------------------------------- XYZ

export function isXyz(s: string) { const l = s.trim().split(/\r?\n/); return l.length >= 3 && /^\d+\s*$/.test(l[0]) && /^\s*[A-Z][a-z]?\s+-?\d/.test(l[2]); }

export function parseXyz(text: string): ChemDoc {
  const lines = text.trim().split(/\r?\n/);
  const n = parseInt(lines[0]);
  const atoms: A3[] = [];
  for (let i = 2; i < 2 + n && i < lines.length; i++) {
    const p = lines[i].trim().split(/\s+/);
    if (p.length < 4) continue;
    atoms.push({ el: cap(p[0].replace(/\d+$/, "")), x: +p[1], y: +p[2], z: +p[3] });
  }
  return docFrom3D(atoms, null);
}

export function writeXyz(doc: ChemDoc, title = "ChemEdit"): string {
  const s = 1.5; // drawing px → Å (bond ≈ 1.5 Å)
  const g = buildGraph(doc);
  const lines: string[] = [];
  for (const a of doc.atoms) {
    lines.push(`${a.el === "*" ? "X" : a.el} ${(a.x * s).toFixed(4)} ${(-a.y * s).toFixed(4)} 0.0000`);
    const bsum = (g.adj.get(a.id) ?? []).reduce((t, x) => t + x.bond.order, 0);
    const h = a.hCount ?? implicitHydrogens(a.el, a.charge, bsum);
    let vx = 0, vy = 0;
    for (const { nb } of g.adj.get(a.id) ?? []) { const o = g.atomById.get(nb)!; const d = Math.hypot(o.x - a.x, o.y - a.y) || 1; vx += (o.x - a.x) / d; vy += (o.y - a.y) / d; }
    const base = vx || vy ? Math.atan2(-vy, -vx) : 0;
    for (let k = 0; k < h; k++) {
      const ang = base + (h === 1 ? 0 : ((k - (h - 1) / 2) * 1.6) / Math.max(1, h - 1));
      lines.push(`H ${((a.x + Math.cos(ang) * 0.7) * s).toFixed(4)} ${(-(a.y + Math.sin(ang) * 0.7) * s).toFixed(4)} ${(h > 1 ? (k % 2 ? 0.5 : -0.5) : 0).toFixed(4)}`);
    }
  }
  return `${lines.length}\n${title}\n${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- PDB (small molecules / ligands)

export function isPdb(s: string) { return /^(HETATM|ATOM {2}|HEADER|COMPND)/m.test(s) && /^(HETATM|ATOM {2})/m.test(s); }

export function parsePdb(text: string, opts: { ligandsOnly?: boolean } = {}): ChemDoc {
  const atoms: A3[] = [];
  const serial = new Map<number, number>();
  const lines = text.split(/\r?\n/);
  const het = lines.some((l) => l.startsWith("HETATM") && !/HOH|WAT/.test(l.slice(17, 20)));
  for (const l of lines) {
    const rec = l.slice(0, 6);
    if (rec !== "HETATM" && rec !== "ATOM  ") continue;
    if ((opts.ligandsOnly ?? het) && rec === "ATOM  ") continue;
    if (/HOH|WAT/.test(l.slice(17, 20))) continue;
    let el = l.slice(76, 78).trim() || l.slice(12, 16).trim().replace(/[^A-Za-z]/g, "").slice(0, 2);
    el = cap(el);
    const chg = l.slice(78, 80).trim();
    serial.set(parseInt(l.slice(6, 11)), atoms.length);
    atoms.push({ el, x: +l.slice(30, 38), y: +l.slice(38, 46), z: +l.slice(46, 54), charge: chg ? (chg.endsWith("-") ? -1 : 1) * (parseInt(chg) || 1) : 0 });
  }
  if (!atoms.length) throw new Error("PDB: no atoms");
  if (atoms.length > 600) throw new Error("PDB: structure too large for 2D drawing (use a ligand / HETATM file)");
  const conect: B3[] = [];
  for (const l of lines) {
    if (!l.startsWith("CONECT")) continue;
    const a = serial.get(parseInt(l.slice(6, 11)));
    if (a === undefined) continue;
    for (let k = 11; k + 5 <= Math.max(l.length, 31); k += 5) {
      const b = serial.get(parseInt(l.slice(k, k + 5)));
      if (b === undefined || b === a) continue;
      const ex: B3 | undefined = conect.find((x: B3) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
      if (ex) { if (ex.a === a) ex.order++; } // repeated CONECT = higher order (PDB convention)
      else conect.push({ a, b, order: 1 });
    }
  }
  if (conect.length) {
    for (const c of conect) c.order = Math.max(1, Math.min(3, c.order));
    if (conect.every((c) => c.order === 1)) assignOrders(atoms, conect);
    return docFrom3D(atoms, conect);
  }
  return docFrom3D(atoms, null);
}

// ---------------------------------------------------------------- Mol2

export function isMol2(s: string) { return /@<TRIPOS>MOLECULE/.test(s); }

export function parseMol2(text: string): ChemDoc {
  const sec = (name: string) => { const m = new RegExp(`@<TRIPOS>${name}\\s*\\n([\\s\\S]*?)(?=@<TRIPOS>|$)`).exec(text); return m ? m[1].trim().split(/\r?\n/).filter((l) => l.trim()) : []; };
  const atoms: A3[] = [];
  const idx = new Map<string, number>();
  for (const l of sec("ATOM")) {
    const p = l.trim().split(/\s+/);
    idx.set(p[0], atoms.length);
    const type = p[5] ?? p[1];
    atoms.push({ el: cap(type.split(".")[0]), x: +p[2], y: +p[3], z: +p[4] });
  }
  const bonds: B3[] = [];
  const arom: B3[] = [];
  for (const l of sec("BOND")) {
    const p = l.trim().split(/\s+/);
    const a = idx.get(p[1]), b = idx.get(p[2]);
    if (a === undefined || b === undefined) continue;
    const t = (p[3] ?? "1").toLowerCase();
    const bo: B3 = { a, b, order: t === "2" ? 2 : t === "3" ? 3 : 1 };
    bonds.push(bo);
    if (t === "ar") arom.push(bo);
  }
  if (arom.length) kekulizeBonds(atoms, bonds, arom);
  const allZero = atoms.every((a) => a.z === 0);
  const doc = docFrom3D(atoms, bonds);
  if (allZero) { /* 2D mol2: layoutDoc already applied — acceptable */ }
  return doc;
}

/** Greedy alternating double bonds on aromatic bonds (fallback for Mol2 "ar"). */
function kekulizeBonds(atoms: A3[], all: B3[], arom: B3[]) {
  const used = new Set<number>();
  const sumOther = (i: number) => all.filter((b) => (b.a === i || b.b === i)).reduce((t, b) => t + b.order, 0);
  const need = (i: number) => atoms[i].el === "C" ? sumOther(i) < 4 : atoms[i].el === "N" ? sumOther(i) < 3 && all.filter((b) => b.a === i || b.b === i).length < 3 : false;
  for (let pass = 0; pass < 3; pass++) for (const b of arom) {
    if (b.order !== 1 || used.has(b.a) || used.has(b.b)) continue;
    if (need(b.a) && need(b.b)) { b.order = 2; used.add(b.a); used.add(b.b); }
  }
}

export function writeMol2(doc: ChemDoc, name = "ChemEdit"): string {
  const s = 1.5;
  const g = buildGraph(doc);
  const num = new Map<number, number>();
  doc.atoms.forEach((a, i) => num.set(a.id, i + 1));
  const type = (id: number) => {
    const a = doc.atoms.find((x) => x.id === id)!;
    const bs = doc.bonds.filter((b) => b.a === id || b.b === id);
    const maxO = Math.max(1, ...bs.map((b) => b.order));
    if (a.el === "C") return maxO === 3 ? "C.1" : maxO === 2 ? "C.2" : "C.3";
    if (a.el === "N") return maxO === 3 ? "N.1" : maxO === 2 ? "N.2" : (g.adj.get(id)?.length ?? 0) === 4 ? "N.4" : "N.3";
    if (a.el === "O") return maxO === 2 ? "O.2" : "O.3";
    if (a.el === "S") return maxO === 2 ? "S.2" : "S.3";
    if (a.el === "P") return "P.3";
    return a.el === "*" ? "Du" : a.el;
  };
  const at = doc.atoms.map((a, i) => `${String(i + 1).padStart(7)} ${(a.el + (i + 1)).padEnd(6)} ${(a.x * s).toFixed(4).padStart(10)} ${(-a.y * s).toFixed(4).padStart(10)} ${"0.0000".padStart(10)} ${type(a.id).padEnd(6)} 1 UNL ${a.charge.toFixed(4)}`);
  const bd = doc.bonds.map((b, i) => `${String(i + 1).padStart(6)} ${String(num.get(b.a)).padStart(5)} ${String(num.get(b.b)).padStart(5)} ${b.order}`);
  return `@<TRIPOS>MOLECULE\n${name}\n${doc.atoms.length} ${doc.bonds.length} 1 0 0\nSMALL\nUSER_CHARGES\n\n@<TRIPOS>ATOM\n${at.join("\n")}\n@<TRIPOS>BOND\n${bd.join("\n")}\n`;
}

// ---------------------------------------------------------------- CML

export function isCml(s: string) { return /<(cml|molecule)[\s>]/.test(s) && /<atom[\s>]/.test(s); }

export function parseCml(text: string): ChemDoc {
  const root = parseXml(text);
  const all: XNode[] = [];
  const walk = (n: XNode) => { all.push(n); n.children.forEach(walk); };
  walk(root);
  const local = (t: string) => t.replace(/^.*:/, "");
  const doc = emptyDoc();
  const ids = new Map<string, number>();
  let has2d = false, has3d = false;
  const raw: A3[] = [];
  const atomNodes = all.filter((n) => local(n.tag) === "atom");
  for (const n of atomNodes) {
    const a = n.attr;
    const x = parseFloat(a.x2 ?? a.x3 ?? "0"), y = parseFloat(a.y2 ?? a.y3 ?? "0"), z = parseFloat(a.z3 ?? "0");
    if (a.x2 !== undefined) has2d = true; else if (a.x3 !== undefined) has3d = true;
    raw.push({ el: a.elementType ?? "C", x, y, z, charge: parseInt(a.formalCharge ?? "0") || 0 });
  }
  const bondNodes = all.filter((n) => local(n.tag) === "bond");
  const bonds: B3[] = [];
  const idList = atomNodes.map((n) => n.attr.id);
  for (const n of bondNodes) {
    const refs = (n.attr.atomRefs2 ?? "").trim().split(/\s+/);
    const a = idList.indexOf(refs[0]), b = idList.indexOf(refs[1]);
    if (a < 0 || b < 0) continue;
    const o = (n.attr.order ?? "1").toUpperCase();
    bonds.push({ a, b, order: o === "2" || o === "D" ? 2 : o === "3" || o === "T" ? 3 : o === "A" ? 1 : 1 });
  }
  if (has3d && !has2d) return docFrom3D(raw, bonds.length ? bonds : null);
  const k = 1 / 1.5; // Å-ish units → px
  raw.forEach((a, i) => ids.set(idList[i], addAtom(doc, a.el, a.x * k, -a.y * k, { charge: a.charge ?? 0 }).id));
  for (const b of bonds) addBond(doc, ids.get(idList[b.a])!, ids.get(idList[b.b])!, b.order);
  if (!has2d) layoutDoc(doc);
  return doc;
}

export function writeCml(doc: ChemDoc, title = ""): string {
  const s = 1.5;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const at = doc.atoms.map((a) => `      <atom id="a${a.id}" elementType="${a.el === "*" ? "R" : a.el}" x2="${(a.x * s).toFixed(4)}" y2="${(-a.y * s).toFixed(4)}"${a.charge ? ` formalCharge="${a.charge}"` : ""}${a.isotope ? ` isotopeNumber="${a.isotope}"` : ""}/>`);
  const bd = doc.bonds.map((b) => `      <bond id="b${b.id}" atomRefs2="a${b.a} a${b.b}" order="${b.order}"${b.stereo === 1 ? '><bondStereo>W</bondStereo></bond' : b.stereo === 6 ? '><bondStereo>H</bondStereo></bond' : "/"}>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<cml xmlns="http://www.xml-cml.org/schema">\n  <molecule id="m1"${title ? ` title="${esc(title)}"` : ""}>\n    <atomArray>\n${at.join("\n")}\n    </atomArray>\n    <bondArray>\n${bd.join("\n")}\n    </bondArray>\n  </molecule>\n</cml>\n`;
}

// ---------------------------------------------------------------- lists (multi-line SMILES, CSV/TSV with a SMILES column)

export function parseSmilesList(text: string, smilesToDoc: (s: string) => ChemDoc): SdfRecord[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (!lines.length) return [];
  const sep = lines[0].includes("\t") ? "\t" : lines[0].includes(";") && !lines[0].includes(",") ? ";" : lines[0].includes(",") ? "," : null;
  const out: SdfRecord[] = [];
  if (sep) {
    const split = (l: string) => l.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
    const head = split(lines[0]);
    let col = head.findIndex((h) => /^(smiles|canonical_smiles|smi|structure)$/i.test(h));
    const hasHeader = col >= 0;
    if (col < 0) col = 0;
    const nameCol = head.findIndex((h) => /^(name|id|compound|title)$/i.test(h));
    for (const l of lines.slice(hasHeader ? 1 : 0)) {
      const c = split(l);
      try {
        const fields: Record<string, string> = {};
        if (hasHeader) head.forEach((h, i) => { if (i !== col && c[i]) fields[h] = c[i]; });
        out.push({ doc: smilesToDoc(c[col]), name: (nameCol >= 0 ? c[nameCol] : "") || `#${out.length + 1}`, fields });
      } catch { /* skip bad row */ }
    }
  } else {
    for (const l of lines) {
      const [smi, ...rest] = l.trim().split(/\s+/);
      try { out.push({ doc: smilesToDoc(smi), name: rest.join(" ") || `#${out.length + 1}`, fields: {} }); } catch { /* skip */ }
    }
  }
  return out;
}
