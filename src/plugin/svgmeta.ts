// Embed / extract editable chemistry data inside SVG files.

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlUnesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export const META_TAG = "chemedit";

/** Metadata XML for renderSVG({ metadata }) */
export function metadataXml(data: string, format: string, smiles = ""): string {
  return `<${META_TAG} xmlns="https://github.com/chemedit" format="${format}" smiles="${xmlEsc(smiles).replace(/"/g, "&quot;")}">${xmlEsc(data)}</${META_TAG}>`;
}

/** Add/replace ChemEdit metadata in an arbitrary SVG string. */
export function embedDataInSvg(svg: string, data: string, format = "chemedit", smiles = ""): string {
  const cleaned = svg.replace(/<metadata>\s*<chemedit[\s\S]*?<\/chemedit>\s*<\/metadata>/, "");
  return cleaned.replace(/<svg([^>]*)>/, `<svg$1><metadata>${metadataXml(data, format, smiles)}</metadata>`);
}

/** Returns embedded data (chemedit native JSON, molfile or smiles) or null. */
export function extractDataFromSvg(svg: string): { data: string; format: string } | null {
  const m = new RegExp(`<${META_TAG}[^>]*format="([^"]+)"[^>]*>([\\s\\S]*?)</${META_TAG}>`).exec(svg);
  if (m) return { format: m[1], data: xmlUnesc(m[2]) };
  // legacy / foreign: comments or data attributes holding a molfile or SMILES
  const c = /<!--\s*(?:chemedit|ketcher)[-_ ]?(?:data)?[:\s]+([\s\S]*?)-->/i.exec(svg);
  if (c) return { format: /V2000|V3000/.test(c[1]) ? "mol" : "smiles", data: c[1].trim() };
  const a = /data-(?:chemedit|smiles|molfile)="([^"]+)"/i.exec(svg);
  if (a) { const d = xmlUnesc(a[1]); return { format: /V2000|V3000/.test(d) ? "mol" : "smiles", data: d }; }
  const desc = /<desc[^>]*>([\s\S]*?(?:V2000|V3000)[\s\S]*?M\s+END[\s\S]*?)<\/desc>/.exec(svg);
  if (desc) return { format: "mol", data: xmlUnesc(desc[1]) };
  return null;
}
