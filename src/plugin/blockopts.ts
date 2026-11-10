// Shared helpers for code-block options.
// Options may be written in the block body (`path: Folder`) or on the fence line
// (```` ```chem-gallery path: Folder/ ````) — both are accepted.

import type { MarkdownPostProcessorContext, App } from "obsidian";
import { TFile, parseYaml } from "obsidian";
import { isRecord } from "../chem/util";

const KEY = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;

export interface BlockOpts { opts: Record<string, string>; rest: string[] }

/** Split a block into `key: value` options and the remaining (non-option) lines. Only keys in `known` are options. */
export function blockOptions(src: string, el: HTMLElement | null, ctx: MarkdownPostProcessorContext | null, known: string[]): BlockOpts {
  const opts: Record<string, string> = {};
  const isKnown = (k: string) => known.includes(k.toLowerCase());
  // fence line
  try {
    const info = el && ctx ? ctx.getSectionInfo(el) : null;
    const fence = info?.text.split("\n")[info.lineStart] ?? "";
    const tail = fence.replace(/^\s*(`{3,}|~{3,})\s*[\w-]+\s*/, "");
    for (const m of tail.matchAll(/([A-Za-z_][\w-]*)\s*:\s*("[^"]*"|[^\s]+(?:\s+(?![A-Za-z_][\w-]*\s*:)[^\s]+)*)/g)) if (isKnown(m[1])) opts[m[1].toLowerCase()] = m[2].replace(/^"|"$/g, "").trim();
  } catch { /* reading-view without section info */ }
  const rest: string[] = [];
  for (const line of src.split(/\r?\n/)) {
    const m = KEY.exec(line.trim());
    if (m && isKnown(m[1]) && !/->|→|=>/.test(line)) opts[m[1].toLowerCase()] = m[2].replace(/^"|"$/g, "").trim();
    else rest.push(line);
  }
  return { opts, rest };
}

export const cleanFolder = (f: string | undefined) => (f ?? "").trim().replace(/^\[\[|\]\]$/g, "").replace(/^\/+|\/+$/g, "");

/** Set / replace `key: value` lines inside the code block that produced `el`. */
export async function writeBlockOptions(app: App, el: HTMLElement, ctx: MarkdownPostProcessorContext, set: Record<string, string | null>) {
  const info = ctx.getSectionInfo(el);
  const f = app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!info || !(f instanceof TFile)) return false;
  await app.vault.process(f, (txt) => {
    const L = txt.split("\n");
    const body = L.slice(info.lineStart + 1, info.lineEnd);
    for (const [k, v] of Object.entries(set)) {
      const i = body.findIndex((l) => new RegExp(`^\\s*${k}\\s*:`, "i").test(l));
      if (v === null) { if (i >= 0) body.splice(i, 1); }
      else if (i >= 0) body[i] = `${k}: ${v}`;
      else body.push(`${k}: ${v}`);
    }
    return [...L.slice(0, info.lineStart + 1), ...body, ...L.slice(info.lineEnd)].join("\n");
  });
  return true;
}

/** Insert text after the code block that produced `el`. */
export async function insertAfterBlock(app: App, el: HTMLElement, ctx: MarkdownPostProcessorContext, text: string) {
  const info = ctx.getSectionInfo(el);
  const f = app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!info || !(f instanceof TFile)) return false;
  await app.vault.process(f, (txt) => { const L = txt.split("\n"); L.splice(info.lineEnd + 1, 0, "", text); return L.join("\n"); });
  return true;
}

/** Replace the whole body of the code block that produced `el` (keeps the fence lines). */
export async function writeBlockBody(app: App, el: HTMLElement, ctx: MarkdownPostProcessorContext, body: string) {
  const info = ctx.getSectionInfo(el);
  const f = app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!info || !(f instanceof TFile)) return false;
  await app.vault.process(f, (txt) => {
    const L = txt.split("\n");
    const m = /^(\s*(?:>\s*)*)/.exec(L[info.lineStart] ?? "");
    const prefix = m?.[1] ?? "";
    L.splice(info.lineStart + 1, info.lineEnd - info.lineStart - 1, ...body.split("\n").map((l) => prefix + l));
    return L.join("\n");
  });
  return true;
}

/** parseYaml that always returns a plain object (never throws). */
export function yamlRecord(src: string): Record<string, unknown> {
  try { const v: unknown = parseYaml(src); return isRecord(v) ? v : {}; } catch { return {}; }
}
