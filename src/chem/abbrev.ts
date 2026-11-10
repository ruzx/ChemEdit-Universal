// Common abbreviations / functional-group labels. First atom of the SMILES attaches.

import { ChemDoc, addBond, addAtom, emptyDoc, buildGraph, cloneDoc, removeAtom, mergeInto } from "./model";
import { findRings } from "./rings";
import { parseSmiles, writeSmiles } from "./smiles";
import { layoutDoc } from "./layout";

export const ABBREVIATIONS: Record<string, string> = {
  Me: "C", Et: "CC", Pr: "CCC", nPr: "CCC", iPr: "C(C)C", Bu: "CCCC", nBu: "CCCC", tBu: "C(C)(C)C", sBu: "C(C)CC",
  iBu: "CC(C)C", Ph: "c1ccccc1", Bn: "Cc1ccccc1", Bz: "C(=O)c1ccccc1", Ac: "C(C)=O", Cy: "C1CCCCC1",
  Vinyl: "C=C", Allyl: "CC=C", OMe: "OC", OEt: "OCC", OiPr: "OC(C)C", OtBu: "OC(C)(C)C", OAc: "OC(C)=O", OPh: "Oc1ccccc1",
  OBn: "OCc1ccccc1", OBz: "OC(=O)c1ccccc1", OH: "O", SH: "S", SMe: "SC", SPh: "Sc1ccccc1", NH2: "N", NHMe: "NC",
  NMe2: "N(C)C", NEt2: "N(CC)CC", NHAc: "NC(C)=O", NHBoc: "NC(=O)OC(C)(C)C", NHCbz: "NC(=O)OCc1ccccc1",
  NO2: "[N+](=O)[O-]", CN: "C#N", NC: "[N+]#[C-]", N3: "N=[N+]=[N-]", CF3: "C(F)(F)F", CCl3: "C(Cl)(Cl)Cl",
  OCF3: "OC(F)(F)F", CHO: "C=O", COOH: "C(=O)O", CO2H: "C(=O)O", CO2Me: "C(=O)OC", CO2Et: "C(=O)OCC",
  CO2tBu: "C(=O)OC(C)(C)C", COMe: "C(C)=O", COCl: "C(=O)Cl", CONH2: "C(N)=O", CH2OH: "CO",
  Boc: "C(=O)OC(C)(C)C", Cbz: "C(=O)OCc1ccccc1", Fmoc: "C(=O)OCC1c2ccccc2-c2ccccc12", Piv: "C(=O)C(C)(C)C",
  Ts: "S(=O)(=O)c1ccc(C)cc1", Ms: "S(=O)(=O)C", Tf: "S(=O)(=O)C(F)(F)F", Ns: "S(=O)(=O)c1ccc(cc1)[N+](=O)[O-]",
  OTs: "OS(=O)(=O)c1ccc(C)cc1", OMs: "OS(=O)(=O)C", OTf: "OS(=O)(=O)C(F)(F)F", SO3H: "S(=O)(=O)O",
  SO2Cl: "S(=O)(=O)Cl", TMS: "[Si](C)(C)C", TES: "[Si](CC)(CC)CC", TBS: "[Si](C)(C)C(C)(C)C",
  TBDMS: "[Si](C)(C)C(C)(C)C", TIPS: "[Si](C(C)C)(C(C)C)C(C)C", TBDPS: "[Si](c1ccccc1)(c1ccccc1)C(C)(C)C",
  OTMS: "O[Si](C)(C)C", OTBS: "O[Si](C)(C)C(C)(C)C", OTIPS: "O[Si](C(C)C)(C(C)C)C(C)C",
  PMB: "Cc1ccc(OC)cc1", Tr: "C(c1ccccc1)(c1ccccc1)c1ccccc1", Trt: "C(c1ccccc1)(c1ccccc1)c1ccccc1",
  Mes: "c1c(C)cc(C)cc1C", Bpin: "B1OC(C)(C)C(C)(C)O1", BPin: "B1OC(C)(C)C(C)(C)O1", "B(OH)2": "B(O)O",
  Py: "c1ccccn1", PPh2: "P(c1ccccc1)c1ccccc1", PPh3: "[P+](c1ccccc1)(c1ccccc1)c1ccccc1", MOM: "COCOC" , OMOM: "OCOC",
  THP: "C1CCCCO1", OTHP: "OC1CCCCO1", Ad: "C12CC3CC(CC(C3)C1)C2",
};

const REVERSED: Record<string, string> = {
  OMe: "MeO", OEt: "EtO", OiPr: "iPrO", OtBu: "tBuO", OAc: "AcO", OPh: "PhO", OBn: "BnO", OBz: "BzO", OH: "HO",
  SH: "HS", SMe: "MeS", SPh: "PhS", NH2: "H2N", NHMe: "MeHN", NMe2: "Me2N", NEt2: "Et2N", NHAc: "AcHN",
  NHBoc: "BocHN", NHCbz: "CbzHN", NO2: "O2N", CN: "NC", NC: "CN", CF3: "F3C", CCl3: "Cl3C", OCF3: "F3CO",
  CHO: "OHC", COOH: "HOOC", CO2H: "HO2C", CO2Me: "MeO2C", CO2Et: "EtO2C", CO2tBu: "tBuO2C", COMe: "MeOC",
  COCl: "ClOC", CONH2: "H2NOC", CH2OH: "HOH2C", OTs: "TsO", OMs: "MsO", OTf: "TfO", SO3H: "HO3S",
  SO2Cl: "ClO2S", OTMS: "TMSO", OTBS: "TBSO", OTIPS: "TIPSO", Bpin: "pinB", BPin: "pinB", "B(OH)2": "(HO)2B",
  PPh2: "Ph2P", PPh3: "Ph3P", OMOM: "MOMO", OTHP: "THPO", N3: "N3",
};

export function lookupAbbreviation(label: string): string | null {
  if (ABBREVIATIONS[label]) return ABBREVIATIONS[label];
  const k = Object.keys(ABBREVIATIONS).find((x) => x.toLowerCase() === label.toLowerCase());
  return k ? ABBREVIATIONS[k] : null;
}

/** Label text as drawn when the attachment bond comes from the right. */
export function reversedLabel(label: string): string {
  if (REVERSED[label]) return REVERSED[label];
  return label;
}

/** Replace abbreviation atoms by their full structures (coordinates approximated). */
export function expandAbbreviations(src: ChemDoc, only?: Set<number>): ChemDoc {
  if (!src.atoms.some((a) => a.label && a.expand && (!only || only.has(a.id)))) return src;
  const doc = cloneDoc(src);
  for (const lab of doc.atoms.filter((a) => a.label && a.expand && (!only || only.has(a.id)))) {
    let frag;
    try { frag = parseSmiles(lab.expand!).doc; } catch { continue; }
    if (!frag.atoms.length) continue;
    const g = buildGraph(doc);
    const nbs = g.adj.get(lab.id)!.map((x) => ({ nb: x.nb, order: x.bond.order, stereo: x.bond.stereo, fromNb: x.bond.a === x.nb }));
    // simple coordinates: fragment laid out along the attachment direction
    const nb0 = nbs[0] ? g.atomById.get(nbs[0].nb)! : null;
    let dx = 1, dy = 0;
    if (nb0) { const L = Math.hypot(lab.x - nb0.x, lab.y - nb0.y) || 1; dx = (lab.x - nb0.x) / L; dy = (lab.y - nb0.y) / L; }
    layoutDoc(frag);
    const f0 = frag.atoms[0];
    // orient: fragment first atom at label position, rest pointing away
    let cx = 0, cy = 0;
    for (const a of frag.atoms) { cx += a.x; cy += a.y; }
    cx /= frag.atoms.length; cy /= frag.atoms.length;
    const v = { x: cx - f0.x, y: cy - f0.y };
    const ang = Math.atan2(dy, dx) - Math.atan2(v.y, v.x || 1e-9);
    const scale = 1;
    for (const a of frag.atoms) {
      const rx = (a.x - f0.x) * scale, ry = (a.y - f0.y) * scale;
      a.x = lab.x + rx * Math.cos(ang) - ry * Math.sin(ang);
      a.y = lab.y + rx * Math.sin(ang) + ry * Math.cos(ang);
    }
    frag.arrows = []; frag.pluses = [];
    const map = mergeInto(doc, frag);
    const first = map.get(f0.id)!;
    for (const { nb, order, stereo, fromNb } of nbs) {
      // keep wedge/hash direction (narrow end stays on the same atom)
      if (fromNb) addBond(doc, nb, first, order, stereo); else addBond(doc, first, nb, order, stereo);
    }
    // carry charge from label onto first atom
    const fa = doc.atoms.find((a) => a.id === first)!;
    if (lab.charge) fa.charge += lab.charge;
    removeAtom(doc, lab.id);
  }
  return doc;
}

/** Groups contracted by default ("Abbreviate groups"). Order irrelevant: largest match wins. */
export const DEFAULT_CONTRACT = ["OAc", "Ac", "OMe", "OEt", "CO2Me", "CO2Et", "CO2tBu", "Boc", "NHBoc", "Cbz", "NHCbz", "Fmoc", "Ts", "OTs",
  "Ms", "OMs", "Tf", "OTf", "TMS", "OTMS", "TBS", "OTBS", "TIPS", "OTIPS", "TBDPS", "TES", "NO2", "CF3", "OCF3", "tBu", "Bz", "OBz", "Piv", "Bpin", "OBn", "PMB", "MOM", "OMOM", "THP", "OTHP", "Tr", "SO2Cl", "N3"];

const keyCache = new Map<string, string>();
function patternKey(smi: string): string | null {
  if (keyCache.has(smi)) return keyCache.get(smi)!;
  try {
    const d = parseSmiles("*" + smi).doc;
    const k = writeSmiles(d, { stereo: false });
    keyCache.set(smi, k);
    return k;
  } catch { return null; }
}

/**
 * Replace recognised terminal groups by abbreviation labels (e.g. -OC(=O)CH3 -> OAc).
 * Only groups smaller than the remaining skeleton are contracted.
 */
export function contractAbbreviations(src: ChemDoc, names: string[] = DEFAULT_CONTRACT, onlyAtoms?: Set<number>): ChemDoc {
  const doc = cloneDoc(src);
  const g = buildGraph(doc);
  const ri = findRings(doc, g);
  const table = new Map<string, string>();
  for (const n of names) { const smi = ABBREVIATIONS[n]; if (!smi) continue; const k = patternKey(smi); if (k && !table.has(k)) table.set(k, n); }
  const maxSize = 22;
  type Match = { u: number; v: number; side: Set<number>; name: string; order: number };
  const matches: Match[] = [];
  for (const b of doc.bonds) {
    if (ri.ringBonds.has(b.id)) continue;
    for (const [u, v] of [[b.a, b.b], [b.b, b.a]]) {
      const side = new Set<number>([v]);
      const st = [v];
      let ok = true;
      while (st.length && ok) {
        const x = st.pop()!;
        for (const { nb } of g.adj.get(x)!) {
          if (x === v && nb === u) continue;
          if (nb === u) { ok = false; break; }
          if (!side.has(nb)) { side.add(nb); st.push(nb); if (side.size > maxSize) { ok = false; break; } }
        }
      }
      if (!ok) continue;
      if (onlyAtoms && ![...side].some((id) => onlyAtoms.has(id))) continue;
      const rest = doc.atoms.length - side.size;
      if (rest < 2) continue;
      if ([...side].some((id) => g.atomById.get(id)!.label)) continue;
      // fragment with a dummy attachment atom
      const frag = emptyDoc();
      const map = new Map<number, number>();
      const star = addAtom(frag, "*", 0, 0);
      for (const id of side) { const a = g.atomById.get(id)!; const n = addAtom(frag, a.el, a.x, a.y, { charge: a.charge, isotope: a.isotope, hCount: a.hCount }); map.set(id, n.id); }
      addBond(frag, star.id, map.get(v)!, b.order);
      for (const bb of doc.bonds) if (side.has(bb.a) && side.has(bb.b)) addBond(frag, map.get(bb.a)!, map.get(bb.b)!, bb.order);
      let key: string;
      try { key = writeSmiles(frag, { stereo: false }); } catch { continue; }
      const name = table.get(key);
      if (name) matches.push({ u, v, side, name, order: b.order });
    }
  }
  matches.sort((x, y) => y.side.size - x.side.size);
  const used = new Set<number>();
  for (const m of matches) {
    if ([...m.side].some((id) => used.has(id)) || used.has(m.u)) continue;
    const va = g.atomById.get(m.v)!;
    for (const id of m.side) used.add(id);
    // keep v as the label atom, delete the rest of the group
    for (const id of m.side) if (id !== m.v) removeAtom(doc, id);
    va.el = "*"; va.label = m.name; va.expand = ABBREVIATIONS[m.name]; va.charge = 0; delete va.hCount; delete va.isotope;
  }
  return doc;
}
