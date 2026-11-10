import { parseAny, docToSmiles, docToMolfile, computeProperties, parseMolfile, isSubstructure, smilesToDoc, writeRxn, writeSdf, parseSdf, writeCdxml, writeKet, contractAbbreviations, detectFormat } from "../src/chem/index";
import { calculateEln } from "../src/chem/eln";
import { analyse } from "../src/chem/analysis";
import { predictNmr, acsText, SOLVENTS, spectrumSvg } from "../src/chem/nmr/spectrum";
import { parsePlan, layoutPlan } from "../src/chem/plan";

let fails = 0;
const eq = (name: string, got: any, exp: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (!ok) { fails++; console.log("FAIL", name, "got", got, "expected", exp); } else console.log("ok  ", name, got);
};
const near = (name: string, got: number, exp: number, tol = 0.02) => {
  const ok = Math.abs(got - exp) <= tol;
  if (!ok) { fails++; console.log("FAIL", name, got, "expected", exp); } else console.log("ok  ", name, got.toFixed(3));
};

const cases: Array<[string, string, number]> = [
  ["ethanol", "CCO", 46.069],
  ["benzene", "c1ccccc1", 78.114],
  ["aspirin", "CC(=O)Oc1ccccc1C(=O)O", 180.159],
  ["caffeine", "Cn1cnc2c1c(=O)n(C)c(=O)n2C", 194.194],
  ["pyrrole", "c1cc[nH]c1", 67.091],
  ["indole", "c1ccc2[nH]ccc2c1", 117.151],
  ["naphthalene", "c1ccc2ccccc2c1", 128.174],
  ["pyridinium", "C[n+]1ccccc1", 94.137],
  ["acetate", "CC(=O)[O-]", 59.044],
  ["NaCl", "[Na+].[Cl-]", 58.44],
  ["thiophene", "c1ccsc1", 84.14],
  ["azulene", "c1ccc2cccc2cc1", 128.174],
  ["ibuprofen", "CC(C)Cc1ccc(cc1)C(C)C(=O)O", 206.285],
  ["cholesterol", "C[C@H](CCCC(C)C)[C@H]1CC[C@@H]2[C@@]1(CC[C@H]3[C@H]2CC=C4[C@@]3(CC[C@@H](C4)O)C)C", 386.664],
  ["adamantane", "C1C2CC3CC1CC(C2)C3", 136.238],
  ["norbornane", "C1CC2CCC1C2", 96.173],
  ["spiro", "C1CCC2(C1)CCCC2", 124.227],
  ["cubane", "C12C3C4C1C5C2C3C45", 104.152],
  ["paclitaxel-core-ish", "CC1=C2C(C(=O)C3(C(CC4C(C3C(C(C2(C)C)(CC1O)O)OC(=O)C5=CC=CC=C5)(CO4)OC(=O)C)O)C)O", 544.597],
];
for (const [name, smi, mw] of cases) {
  const d = parseAny(smi);
  const p = computeProperties(d)!;
  near(`MW ${name} (${p.formula})`, p.mw, mw, 0.05);
  // round trip
  const out = docToSmiles(d);
  const p2 = computeProperties(parseAny(out))!;
  eq(`roundtrip formula ${name} -> ${out}`, p2.formula, p.formula);
  // bonds length sanity
  const bad = d.bonds.filter((b) => { const A = d.atoms.find((a) => a.id === b.a)!, B = d.atoms.find((a) => a.id === b.b)!; const L = Math.hypot(A.x - B.x, A.y - B.y); return L < 0.7 || L > 1.4; });
  if (["adamantane", "cubane", "paclitaxel-core-ish"].includes(name)) { if (bad.length) console.log("   note: distorted bonds in cage", name, bad.length); }
  else eq(`bond lengths ${name}`, bad.length, 0);
  // atom clashes
  let clash = 0;
  for (let i = 0; i < d.atoms.length; i++) for (let j = i + 1; j < d.atoms.length; j++) if (Math.hypot(d.atoms[i].x - d.atoms[j].x, d.atoms[i].y - d.atoms[j].y) < 0.5) clash++;
  if (clash) console.log("   note: clashes", name, clash);
}

// stereo round trips
const stereo: Array<[string, string]> = [
  ["L-Ala", "N[C@@H](C)C(=O)O"],
  ["D-Ala", "N[C@H](C)C(=O)O"],
  ["trans-2-butene", "C/C=C/C"],
  ["cis-2-butene", "C/C=C\\C"],
  ["E-stilbene", "c1ccccc1/C=C/c1ccccc1"],
  ["(R)-CHFClBr", "F[C@H](Cl)Br"],
  ["(S)-CHFClBr", "F[C@@H](Cl)Br"],
  ["quaternary", "C[C@](N)(O)CC"],
];
for (const [name, smi] of stereo) {
  const d = parseAny(smi);
  const out = docToSmiles(d);
  console.log("     ", name, smi, "->", out, " wedges:", d.bonds.filter((b) => b.stereo).length);
}

// Molfile round trip
const mol = docToMolfile(parseAny("CC(=O)Oc1ccccc1C(=O)O"));
const back = parseMolfile(mol);
eq("mol roundtrip formula", computeProperties(back)!.formula, "C9H8O4");
eq("mol charge", computeProperties(parseMolfile(docToMolfile(parseAny("C[N+](C)(C)C.[Cl-]"))))!.formula, "C4H12ClN");

// reaction
const rx = parseAny("CC(=O)O.OCC>>CC(=O)OCC.O");
eq("reaction arrows", rx.arrows.length, 1);
eq("reaction pluses", rx.pluses.length, 2);
eq("reaction smiles", docToSmiles(rx).includes(">"), true);
console.log("     reaction ->", docToSmiles(rx));

// substructure
eq("sub benzene in aspirin", isSubstructure("CC(=O)Oc1ccccc1C(=O)O", "c1ccccc1"), true);
eq("sub kekule benzene", isSubstructure("c1ccc2ccccc2c1", "C1=CC=CC=C1"), true);
eq("sub not N in aspirin", isSubstructure("CC(=O)Oc1ccccc1C(=O)O", "CN"), false);
eq("sub carboxylic", isSubstructure("CC(C)Cc1ccc(cc1)C(C)C(=O)O", "C(=O)O"), true);

// abbreviations
const d = smilesToDoc("CC");
d.atoms[1].label = "OMe"; d.atoms[1].el = "*"; d.atoms[1].expand = "OC";
eq("abbrev expand", docToSmiles(d), "COC");
eq("abbrev formula", computeProperties(d)!.formula, "C2H6O");

// non-stereogenic centre with a wedge must not get @/@@
{
  const d = smilesToDoc("CC(C)(N)C(=O)O");
  const c = d.atoms.find((a) => a.el === "C" && d.bonds.filter((b) => b.a === a.id || b.b === a.id).length === 4)!;
  const nb = d.bonds.find((b) => (b.a === c.id || b.b === c.id) && d.atoms.find((a) => a.id === (b.a === c.id ? b.b : b.a))!.el === "N")!;
  if (nb.a !== c.id) { const t = nb.a; nb.a = nb.b; nb.b = t; }
  nb.stereo = 1;
  eq("no chirality on symmetric centre", docToSmiles(d).includes("@"), false);
}
// stereo idempotence
for (const s of ["N[C@@H](C)C(=O)O", "C[C@H](CCCC(C)C)[C@H]1CC[C@@H]2[C@@]1(CC[C@H]3[C@H]2CC=C4[C@@]3(CC[C@@H](C4)O)C)C", "C/C=C/C=C/C(=O)OC", "CC1(C)S[C@@H]2[C@H](NC(=O)Cc3ccccc3)C(=O)N2[C@H]1C(=O)O"]) {
  const o1 = docToSmiles(parseAny(s)), o2 = docToSmiles(parseAny(o1));
  eq("stereo stable " + s.slice(0, 18), o1, o2);
  eq("stereo count kept " + s.slice(0, 18), (o1.match(/@/g) ?? []).length > 0 || !s.includes("@"), true);
}

// v2.1: canonical aromatic SMILES
eq("aromatic aspirin", docToSmiles(parseAny("CC(Oc1c(C(O)=O)cccc1)=O")), "CC(=O)Oc1ccccc1C(=O)O");
eq("canonical independent of input order", docToSmiles(parseAny("OC(=O)c1ccccc1OC(C)=O")), docToSmiles(parseAny("CC(=O)Oc1ccccc1C(=O)O")));
eq("kekule option", docToSmiles(parseAny("c1ccccc1"), { aromatic: false }), "C1=CC=CC=C1");
// formats
for (const [fmt, w] of [["rxn", writeRxn], ["cdxml", writeCdxml], ["ket", writeKet]] as const) {
  const src = parseAny("CC(=O)O.OCC>>CC(=O)OCC");
  const txt = (w as any)(src);
  eq(`${fmt} detect`, detectFormat(txt), fmt);
  eq(`${fmt} roundtrip`, docToSmiles(parseAny(txt)), docToSmiles(src));
}
{
  const sdf = writeSdf([{ doc: parseAny("CCO"), name: "ethanol", fields: { CAS: "64-17-5" } }, { doc: parseAny("C[C@H](N)C(=O)O"), name: "Ala" }]);
  const r = parseSdf(sdf);
  eq("sdf records", r.map((x) => [x.name, docToSmiles(x.doc)]), [["ethanol", "CCO"], ["Ala", "C[C@H](N)C(=O)O"]]);
  eq("sdf fields", r[0].fields.CAS, "64-17-5");
}
// abbreviations contract/expand
{
  const d = parseAny("CC(C)(C)[Si](C)(C)OCc1ccc([N+](=O)[O-])cc1C(F)(F)F");
  const c = contractAbbreviations(d);
  eq("contract labels", c.atoms.filter((a) => a.label).map((a) => a.label).sort(), ["CF3", "NO2", "OTBS"]);
  eq("contract preserves smiles", docToSmiles(c), docToSmiles(d));
}
// analysis
{
  const an = analyse(parseAny("CC(=O)Oc1ccccc1C(=O)O"))!;
  near("[M+H]+ aspirin", an.adducts[0].mz, 181.0495, 0.0005);
  near("EA C aspirin", an.ea.find((x) => x.el === "C")!.pct, 60.0, 0.01);
  eq("DBE aspirin", an.dbe, 6);
  eq("stereocentres alanine", analyse(parseAny("CC(N)C(=O)O"))!.stereo, 1);
}
// ELN stoichiometry (ChemEdit 1.x format)
{
  const c = calculateEln({ reactants: [{ smiles: "OC(=O)c1ccccc1O", mass: 1380, is_limiting: true }, { smiles: "CC(=O)OC(C)=O", eq: 3, density: 1.08 }], products: [{ smiles: "CC(=O)Oc1ccccc1C(=O)O", mass_isolated: 1530 }] });
  near("eln ref mmol", c.refMmol!, 9.991, 0.01);
  near("eln Ac2O volume", c.rows[1].volume!, 2.833, 0.01);
  near("eln yield", c.products[0].yieldPct!, 85.0, 0.2);
}

// NMR prediction (increment tables; ±0.3 ppm 1H)
{
  const ea = predictNmr(parseAny("CCOC(C)=O"));
  eq("EtOAc 1H signals", ea.h.map((s) => [s.mult, s.n]), [["q", 2], ["s", 3], ["t", 3]]);
  near("EtOAc OCH2", ea.h[0].shift, 4.12, 0.3);
  near("EtOAc C=O", ea.c[0].shift, 171.1, 3);
  const an = predictNmr(parseAny("COc1ccccc1"));
  near("anisole OMe", an.h.find((s) => s.n === 3)!.shift, 3.80, 0.2);
  eq("anisole 13C count", an.c.length, 5);
  eq("ACS text", acsText(ea.h, "1H", 400, SOLVENTS[0]).startsWith("¹H NMR (400 MHz, CDCl₃) δ 4.25 (q, J = 7.0 Hz, 2H)"), true);
  eq("pyridine H2", predictNmr(parseAny("c1ccncc1")).h[0].shift > 8.3, true);
  eq("kekulé pyrrole NH kept", predictNmr(parseAny("C1=CNC=C1")).h.some((s) => s.exch), true);
  eq("spectrum svg", spectrumSvg(an.h, { nucleus: "1H", mhz: 400 }).includes("ce-nmr-sig"), true);
}
// synthesis-plan parser
{
  const g = parsePlan("[[EXP-001]] -> [[EXP-002]] -> [[EXP-003]]\n[[EXP-005]] -> [[EXP-002]]\nC1=CC=CC=C1 -> Intermediate Step -> [[EXP-005]]\nNode A -> Node B\n\nNode B -> Node A\nCCO -[PCC]-> CC=O".split("\n"), (t) => { try { return parseAny(t, "smiles").atoms.length > 0; } catch { return false; } });
  eq("plan nodes", [...g.nodes.values()].map((n) => n.kind[0]).join(""), "llllsttts s".replace(" ", ""));
  eq("plan edges", g.edges.length, 8);
  eq("plan label", g.edges.find((e) => e.label)?.label, "PCC");
  const l = layoutPlan(g);
  eq("plan cycle → back edge", g.edges.filter((e) => e.back).length, 1);
  eq("plan EXP-002 after EXP-001", l.pos.get("link:exp-002")!.layer > l.pos.get("link:exp-001")!.layer, true);
}

console.log(fails ? `\n${fails} FAILURES` : "\nALL OK");
process.exit(fails ? 1 : 0);
