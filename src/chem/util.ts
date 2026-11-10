// Small helpers for values that come from YAML / front matter (typed as unknown).

/** Text of a scalar value; objects/arrays/null become "". */
export function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return "";
}
/** Finite number or null. */
export function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "" || typeof v === "boolean") return null;
  const x = typeof v === "number" ? v : parseFloat(str(v).replace(",", "."));
  return isFinite(x) ? x : null;
}
/** Plain object check for YAML maps. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Message of a caught error. */
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : str(e) || "unknown error");
