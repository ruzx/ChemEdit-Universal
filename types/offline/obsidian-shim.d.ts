// Minimal subset of the Obsidian API used by ChemEdit, for offline type-checking only.
// Real builds can delete this folder and use `npm i -D obsidian` instead (see tsconfig "paths").
declare module "obsidian" {
  export interface EventRef {}
  export class Events { on(name: string, cb: (...a: any[]) => any): EventRef; trigger(name: string, ...a: any[]): void; }
  export class Component {
    load(): void; onload(): void; unload(): void; onunload(): void;
    addChild<T extends Component>(c: T): T; removeChild<T extends Component>(c: T): T; register(cb: () => any): void; registerEvent(e: EventRef): void;
    registerDomEvent<K extends keyof DocumentEventMap>(el: Document | Window | HTMLElement, type: K, cb: (ev: DocumentEventMap[K]) => any, opts?: boolean | AddEventListenerOptions): void;
    registerInterval(id: number): number;
  }
  export class TAbstractFile { vault: Vault; path: string; name: string; parent: TFolder | null; }
  export class TFile extends TAbstractFile { basename: string; extension: string; stat: { mtime: number; ctime: number; size: number }; }
  export class TFolder extends TAbstractFile { children: TAbstractFile[]; isRoot(): boolean; }
  export interface DataAdapter { exists(p: string): Promise<boolean>; }
  export class Vault extends Events {
    adapter: DataAdapter;
    getAbstractFileByPath(p: string): TAbstractFile | null;
    read(f: TFile): Promise<string>; cachedRead(f: TFile): Promise<string>;
    modify(f: TFile, data: string): Promise<void>; process(f: TFile, fn: (data: string) => string): Promise<string>;
    create(p: string, data: string): Promise<TFile>; createFolder(p: string): Promise<TFolder>;
    getResourcePath(f: TFile): string; getName(): string; getMarkdownFiles(): TFile[]; getFiles(): TFile[]; createBinary(p: string, data: ArrayBuffer): Promise<TFile>;
  }
  export interface CachedMetadata { frontmatter?: any; sections?: any[] }
  export class MetadataCache extends Events {
    getFirstLinkpathDest(link: string, source: string): TFile | null;
    getFileCache(f: TFile): CachedMetadata | null;
  }
  export interface EditorPosition { line: number; ch: number }
  export class Editor {
    getCursor(which?: string): EditorPosition; getLine(n: number): string; lineCount(): number; getValue(): string;
    replaceSelection(s: string): void; replaceRange(s: string, from: EditorPosition, to?: EditorPosition): void;
    getSelection(): string; setCursor(p: EditorPosition | number, ch?: number): void; getRange(a: EditorPosition, b: EditorPosition): string;
  }
  export class View extends Component { app: App; containerEl: HTMLElement; leaf: WorkspaceLeaf; getViewType(): string; getDisplayText(): string; getIcon(): string; }
  export class ItemView extends View { contentEl: HTMLElement; constructor(leaf: WorkspaceLeaf); onOpen(): Promise<void>; onClose(): Promise<void>; addAction(icon: string, title: string, cb: (e: MouseEvent) => any): HTMLElement; }
  export class FileView extends ItemView { file: TFile | null; allowNoFile: boolean; }
  export class TextFileView extends FileView {
    data: string; requestSave: () => void;
    getViewData(): string; setViewData(data: string, clear: boolean): void; clear(): void; save(clear?: boolean): Promise<void>;
  }
  export class MarkdownView extends TextFileView { editor: Editor; getMode(): string; }
  export class WorkspaceLeaf { view: View; openFile(f: TFile, s?: any): Promise<void>; setViewState(s: any): Promise<void>; }
  export class Workspace extends Events {
    getActiveViewOfType<T extends View>(t: abstract new (...a: any[]) => T): T | null;
    getActiveFile(): TFile | null; getLeavesOfType(t: string): WorkspaceLeaf[]; revealLeaf(l: WorkspaceLeaf): Promise<void>; getLeaf(newLeaf?: boolean | string): WorkspaceLeaf; activeLeaf: WorkspaceLeaf | null; openLinkText(link: string, src: string, newLeaf?: boolean | string): Promise<void>;
    onLayoutReady(cb: () => any): void;
  }
  export class FileManager { processFrontMatter(f: TFile, fn: (fm: any) => void): Promise<void>; }
  export class App { vault: Vault; workspace: Workspace; metadataCache: MetadataCache; fileManager: FileManager; }
  export class Scope { register(mods: string[], key: string | null, fn: (evt: KeyboardEvent, ctx: any) => any): any; }
  export class Modal {
    app: App; scope: Scope; containerEl: HTMLElement; modalEl: HTMLElement; titleEl: HTMLElement; contentEl: HTMLElement;
    constructor(app: App); open(): void; close(): void; onOpen(): void; onClose(): void; setTitle(t: string): this;
  }
  export interface PluginManifest { id: string; name: string; version: string; dir?: string }
  export class Plugin extends Component {
    app: App; manifest: PluginManifest;
    constructor(app: App, manifest: PluginManifest);
    addRibbonIcon(icon: string, title: string, cb: (e: MouseEvent) => any): HTMLElement;
    addCommand(cmd: { id: string; name: string; callback?: () => any; editorCallback?: (ed: Editor, view: any) => any; checkCallback?: (checking: boolean) => boolean | void }): any;
    addSettingTab(t: PluginSettingTab): void;
    registerMarkdownCodeBlockProcessor(lang: string, fn: (src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => any, sortOrder?: number): any;
    registerMarkdownPostProcessor(fn: (el: HTMLElement, ctx: MarkdownPostProcessorContext) => any, sortOrder?: number): any;
    registerView(type: string, creator: (leaf: WorkspaceLeaf) => View): void;
    registerExtensions(exts: string[], viewType: string): void;
    loadData(): Promise<any>; saveData(d: any): Promise<void>;
  }
  export interface MarkdownSectionInformation { text: string; lineStart: number; lineEnd: number }
  export interface MarkdownPostProcessorContext {
    docId: string; sourcePath: string; frontmatter: any;
    addChild(c: MarkdownRenderChild): void; getSectionInfo(el: HTMLElement): MarkdownSectionInformation | null;
  }
  export class MarkdownRenderChild extends Component { containerEl: HTMLElement; constructor(el: HTMLElement); }
  export class PluginSettingTab { app: App; containerEl: HTMLElement; constructor(app: App, plugin: Plugin); display(): void; hide(): void; }
  export class ValueComponent<T> { getValue(): T; setValue(v: T): this; }
  export class TextComponent extends ValueComponent<string> { inputEl: HTMLInputElement; setPlaceholder(s: string): this; onChange(cb: (v: string) => any): this; }
  export class ToggleComponent extends ValueComponent<boolean> { onChange(cb: (v: boolean) => any): this; }
  export class DropdownComponent extends ValueComponent<string> { addOption(v: string, d: string): this; addOptions(o: Record<string, string>): this; onChange(cb: (v: string) => any): this; }
  export class SliderComponent extends ValueComponent<number> { setLimits(min: number, max: number, step: number): this; setDynamicTooltip(): this; onChange(cb: (v: number) => any): this; }
  export class ButtonComponent { setButtonText(s: string): this; setCta(): this; onClick(cb: () => any): this; }
  export class Setting {
    constructor(el: HTMLElement);
    setName(n: string | DocumentFragment): this; setDesc(d: string | DocumentFragment): this; setHeading(): this;
    addText(cb: (c: TextComponent) => any): this; addToggle(cb: (c: ToggleComponent) => any): this;
    addDropdown(cb: (c: DropdownComponent) => any): this; addSlider(cb: (c: SliderComponent) => any): this; addButton(cb: (c: ButtonComponent) => any): this;
  }
  export class Notice { constructor(msg: string | DocumentFragment, timeout?: number); hide(): void; }
  export class MenuItem { setTitle(t: string): this; setIcon(i: string): this; onClick(cb: (e: MouseEvent | KeyboardEvent) => any): this; setSection?(s: string): this; }
  export abstract class FuzzySuggestModal<T> extends Modal { setPlaceholder(p: string): void; abstract getItems(): T[]; abstract getItemText(i: T): string; abstract onChooseItem(i: T, e: MouseEvent | KeyboardEvent): void; }
  export class Menu { addItem(cb: (i: MenuItem) => any): this; addSeparator(): this; showAtMouseEvent(e: MouseEvent): this; showAtPosition(p: { x: number; y: number }): this; }
  export interface RequestUrlParam { url: string; method?: string; headers?: Record<string, string>; body?: string; throw?: boolean }
  export interface RequestUrlResponse { status: number; text: string; json: any }
  export function requestUrl(p: RequestUrlParam | string): Promise<RequestUrlResponse>;
  export function setIcon(el: HTMLElement, icon: string): void;
  export function parseYaml(s: string): any;
  export function stringifyYaml(o: any): string;
  export function normalizePath(p: string): string;
  export function debounce<T extends (...a: any[]) => any>(fn: T, ms?: number, resetTimer?: boolean): T;
  export const Platform: { isMobile: boolean; isDesktop: boolean };
}

interface DomElementInfo { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean>; title?: string; type?: string; value?: string; placeholder?: string }
interface HTMLElement {
  createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: DomElementInfo | string, cb?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K];
  createDiv(o?: DomElementInfo | string): HTMLDivElement;
  createSpan(o?: DomElementInfo | string): HTMLSpanElement;
  empty(): void; addClass(...c: string[]): void; removeClass(...c: string[]): void; toggleClass(c: string, v: boolean): void; setText(t: string): void; appendText(t: string): void; setAttr(k: string, v: string): void; setCssStyles(s: Partial<CSSStyleDeclaration>): void;
}
interface Window { moment: any }

declare function createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: string | { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean | null>; type?: string; value?: string; placeholder?: string }, cb?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K];
declare function createDiv(o?: string | { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean | null> }, cb?: (el: HTMLDivElement) => void): HTMLDivElement;
declare function createSpan(o?: string | { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean | null> }, cb?: (el: HTMLSpanElement) => void): HTMLSpanElement;

