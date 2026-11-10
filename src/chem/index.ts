// High-level chemistry API (no DOM, no Obsidian).

import { ChemDoc, emptyDoc, fromNative, toNative, isEmpty } from "./model";
import { parseSmiles, writeSmiles, isLikelySmiles } from "./smiles";
import { parseMolfile, writeMolfile, isMolfile, hasCoordinates } from "./molfile";
import { layoutDoc } from "./layout";
import { expandAbbreviations } from "./abbrev";
import { computeProperties, substructureMatch } from "./props";
import { isRxn, parseRxn, writeRxn, isSdf, sdfToDoc, docToSdf, isCdxml, parseCdxml, writeCdxml, isKet, parseKet, writeKet } from "./formats";
export * from "./formats";
export * from "./formats3d";
import { isXyz, parseXyz, writeXyz, isPdb, parsePdb, isMol2, parseMol2, writeMol2, isCml, parseCml, writeCml } from "./formats3d";
export { contractAbbreviations, DEFAULT_CONTRACT } from "./abbrev";

export * from "./model";
export { parseSmiles, writeSmiles, isLikelySmiles, reactionRoles } from "./smiles";
export { parseMolfile, writeMolfile, isMolfile } from "./molfile";
export { layoutDoc, cleanComponents, freeDirection } from "./layout";
export { computeProperties, fragmentProperties, substructureMatch } from "./props";
export { expandAbbreviations, lookupAbbreviation, ABBREVIATIONS } from "./abbrev";

export type Format = "smiles" | "mol" | "chemedit" | "rxn" | "sdf" | "cdxml" | "ket" | "cml" | "xyz" | "mol2" | "pdb" | "auto";

export function detectFormat(text: string): Format {
  const t = text.trim();
  if (isKet(t)) return "ket";
  if (t.startsWith("{") && t.includes('"v"')) return "chemedit";
  if (isCdxml(t)) return "cdxml";
  if (isMol2(t)) return "mol2";
  if (isCml(t)) return "cml";
  if (isXyz(t)) return "xyz";
  if (isPdb(t)) return "pdb";
  if (isRxn(t)) return "rxn";
  if (isSdf(t) && (t.match(/\$\$\$\$/g) ?? []).length > 1) return "sdf";
  if (isMolfile(t)) return "mol";
  return "smiles";
}

/** Map a file extension to a format. */
export function formatForExtension(ext: string): Format {
  const e = ext.toLowerCase();
  if (e === "mol" || e === "mdl") return "mol";
  if (e === "sdf" || e === "sd") return "sdf";
  if (e === "rxn") return "rxn";
  if (e === "cdxml") return "cdxml";
  if (e === "ket") return "ket";
  if (e === "chemedit") return "chemedit";
  if (e === "smi" || e === "smiles") return "smiles";
  if (e === "cml") return "cml";
  if (e === "xyz") return "xyz";
  if (e === "mol2") return "mol2";
  if (e === "pdb" || e === "ent") return "pdb";
  return "auto";
}

/** Parse SMILES, Molfile or native JSON into a laid-out document. */
export function parseAny(text: string, format: Format = "auto"): ChemDoc {
  const t = (text ?? "").replace(/^\uFEFF/, "").trim();
  if (!t) return emptyDoc();
  const f = format === "auto" ? detectFormat(t) : format;
  if (f === "chemedit") return fromNative(t);
  if (f === "ket") return parseKet(t);
  if (f === "cdxml") return parseCdxml(t);
  if (f === "cml") return parseCml(t);
  if (f === "xyz") return parseXyz(t);
  if (f === "mol2") return parseMol2(t);
  if (f === "pdb") return parsePdb(t);
  if (f === "rxn") return parseRxn(t);
  if (f === "sdf") return sdfToDoc(t);
  if (f === "mol") {
    const d = parseMolfile(t);
    if (!hasCoordinates(d)) layoutDoc(d);
    return d;
  }
  return smilesToDoc(t);
}

export function smilesToDoc(smiles: string): ChemDoc {
  const lines = smiles.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length > 1) smiles = lines.map((l) => l.split(/\s+/)[0]).join(".");
  const { doc, roles } = parseSmiles(smiles);
  layoutDoc(doc, { roles });
  return doc;
}

export function docToSmiles(doc: ChemDoc, opts: { aromatic?: boolean; stereo?: boolean } = {}): string {
  if (isEmpty(doc)) return "";
  return writeSmiles(expandAbbreviations(doc), opts);
}

export function docToMolfile(doc: ChemDoc, name = ""): string {
  return writeMolfile(expandAbbreviations(doc), name);
}

export function docToNative(doc: ChemDoc): string {
  return toNative(doc);
}

export function serialize(doc: ChemDoc, format: Exclude<Format, "auto">): string {
  if (format === "mol") return docToMolfile(doc);
  if (format === "rxn") return writeRxn(doc);
  if (format === "sdf") return docToSdf(doc);
  if (format === "cdxml") return writeCdxml(doc);
  if (format === "ket") return writeKet(doc);
  if (format === "cml") return writeCml(doc);
  if (format === "xyz") return writeXyz(doc);
  if (format === "mol2") return writeMol2(doc);
  if (format === "pdb") throw new Error("PDB export is not supported — use Mol2, SDF or CML");
  if (format === "chemedit") return docToNative(doc);
  return docToSmiles(doc);
}

/** Convenience: properties from any text input (products if reaction). */
export function propertiesOf(text: string) {
  try { return computeProperties(parseAny(text), "products"); } catch { return null; }
}

export function isSubstructure(targetText: string, queryText: string): boolean {
  try {
    const t = parseAny(targetText), q = parseAny(queryText);
    return substructureMatch(t, q);
  } catch { return false; }
}

export { isLikelySmiles as looksLikeSmiles, hasCoordinates };
