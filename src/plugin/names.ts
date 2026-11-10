// Name -> SMILES via OPSIN (IUPAC names) with PubChem fallback (trivial names).
import { requestUrl } from "obsidian";
import { iupacOf } from "./bridges/types";

export async function resolveName(name: string): Promise<string | null> {
  const q = name.trim();
  if (!q) return null;
  try {
    const r = await requestUrl({ url: `https://opsin.ch.cam.ac.uk/opsin/${encodeURIComponent(q)}.smi`, throw: false });
    if (r.status === 200 && r.text.trim()) return r.text.trim();
  } catch { /* offline */ }
  for (const prop of ["SMILES", "IsomericSMILES", "CanonicalSMILES"]) {
    try {
      const r = await requestUrl({ url: `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(q)}/property/${prop}/TXT`, throw: false });
      if (r.status === 200 && r.text.trim()) return r.text.trim().split("\n")[0].trim();
    } catch { /* offline */ }
  }
  return null;
}

export async function iupacName(smiles: string): Promise<string | null> {
  try {
    const r = await requestUrl({ url: `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/${encodeURIComponent(smiles)}/property/IUPACName/JSON`, throw: false });
    if (r.status === 200) return iupacOf(r.json) || null;
  } catch { /* offline */ }
  return null;
}
