// Minimal typings for the (undocumented) Canvas and Excalidraw plugin APIs the bridges use.
import type { App, TFile, View } from "obsidian";

export interface CanvasNode {
  x: number; y: number; width: number; height: number;
  text?: string; file?: unknown; nodeEl?: HTMLElement;
  moveAndResize?: (r: { x: number; y: number; width: number; height: number }) => void;
  render?: () => void;
}
export interface CanvasApi {
  selection: Set<CanvasNode>; x?: number; y?: number; zoom?: number;
  createTextNode(o: { pos: { x: number; y: number }; size: { width: number; height: number }; text: string; save?: boolean }): unknown;
  createFileNode(o: { file: TFile; pos: { x: number; y: number }; size: { width: number; height: number }; save?: boolean }): unknown;
  removeNode(n: CanvasNode): void;
  requestSave(): void;
}
export const canvasOf = (view: View): CanvasApi | undefined => (view as unknown as { canvas?: CanvasApi }).canvas;

export interface ExElement { id: string; type: string; x: number; y: number; width: number; height: number; text?: string; fileId?: string; version: number; versionNonce?: number }
export interface ExcalidrawApi {
  addFiles(files: Array<{ id: string; dataURL: string; mimeType: string; created: number }>): void;
  updateScene(s: { elements: ExElement[] }): void;
}
export interface ExcalidrawAutomate {
  setView(v: View): void;
  getViewSelectedElements(): ExElement[];
  getViewElements(): ExElement[];
  getExcalidrawAPI(): ExcalidrawApi;
  clear(): void;
  addText(x: number, y: number, text: string, o?: Record<string, unknown>): string;
  addImage(x: number, y: number, file: TFile): Promise<string>;
  addElementsToView(reposition?: boolean, save?: boolean): Promise<boolean>;
  deleteViewElements(els: ExElement[]): boolean;
}
export const excalidrawOf = (app: App): ExcalidrawAutomate | undefined =>
  (app as unknown as { plugins?: { plugins?: Record<string, { ea?: ExcalidrawAutomate } | undefined> } }).plugins?.plugins?.["obsidian-excalidraw-plugin"]?.ea;
export const excalidrawFileOf = (view: View, fileId: string): { file?: unknown } | undefined =>
  (view as unknown as { excalidrawData?: { getFile(id: string): { file?: unknown } | undefined } }).excalidrawData?.getFile(fileId);

/** IUPAC name from a PubChem property response. */
export const iupacOf = (json: unknown): string => {
  const p = (json as { PropertyTable?: { Properties?: Array<{ IUPACName?: string }> } } | null)?.PropertyTable?.Properties?.[0]?.IUPACName;
  return typeof p === "string" ? p : "";
};
