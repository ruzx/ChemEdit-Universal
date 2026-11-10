import { parseAny } from "../src/chem/index";
import { renderSVG } from "../src/render/svg";
const mols: Array<[string, string]> = [
  ["Aspirin", "CC(=O)Oc1ccccc1C(=O)O"], ["Caffeine", "Cn1cnc2c1c(=O)n(C)c(=O)n2C"],
  ["Ibuprofen", "CC(C)Cc1ccc(cc1)C(C)C(=O)O"], ["Cholesterol", "C[C@H](CCCC(C)C)[C@H]1CC[C@@H]2[C@@]1(CC[C@H]3[C@H]2CC=C4[C@@]3(CC[C@@H](C4)O)C)C"],
  ["Indole / NH", "c1ccc2[nH]ccc2c1"], ["Salt", "C[N+](C)(C)C.[Cl-]"], ["L-Ala", "N[C@@H](C)C(=O)O"],
  ["Stilbene E", "c1ccccc1/C=C/c1ccccc1"], ["Norbornane", "C1CC2CCC1C2"], ["Spiro", "C1CCC2(C1)CCCC2"],
  ["Esterification", "CC(=O)O.OCC>>CC(=O)OCC.O"], ["Nitrile+nitro", "N#Cc1ccc(cc1)[N+](=O)[O-]"],
  ["Morphine", "CN1CC[C@]23c4c5ccc(O)c4O[C@H]2[C@@H](O)C=C[C@H]3[C@H]1C5"], ["Penicillin G", "CC1(C)S[C@@H]2[C@H](NC(=O)Cc3ccccc3)C(=O)N2[C@H]1C(=O)O"],
  ["Adamantane", "C1C2CC3CC1CC(C2)C3"], ["Azulene", "c1ccc2cccc2cc1"], ["Diene", "C/C=C/C=C/C(=O)OC"], ["Biphenyl", "c1ccc(cc1)-c1ccccc1"], ["Aspirin (user)", "CC(Oc1c(C(O)=O)cccc1)=O"], ["Phthalate", "CCOC(=O)c1ccccc1C(=O)OCC"], ["Boc-Phe-OMe", "COC(=O)[C@H](Cc1ccccc1)NC(=O)OC(C)(C)C"], ["Atorvastatin", "CC(C)c1c(C(=O)Nc2ccccc2)c(-c2ccccc2)c(-c2ccc(F)cc2)n1CC[C@@H](O)C[C@@H](O)CC(=O)O"], ["Sildenafil", "CCCc1nn(C)c2c(=O)[nH]c(-c3cc(S(=O)(=O)N4CCN(C)CC4)ccc3OCC)nc12"], ["2,6-di-tBu-phenol", "CC(C)(C)c1cccc(C(C)(C)C)c1O"],
];
let html = `<html><body style="margin:0;background:#fff;font:12px sans-serif"><div style="display:grid;grid-template-columns:repeat(4,300px);gap:6px;padding:6px">`;
for (const [n, s] of mols) {
  let svg = "";
  try { svg = renderSVG(parseAny(s), { bondLength: 26, maxWidth: 290, maxHeight: 210 }); } catch (e: any) { svg = "ERR " + e.message; }
  html += `<div style="border:1px solid #ddd;height:240px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#000">${svg}<div>${n}</div></div>`;
}
html += `</div></body></html>`;
require("fs").writeFileSync("/tmp/claude-0/out/gallery.html", html);
