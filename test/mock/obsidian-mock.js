// Tiny Obsidian API mock for browser smoke tests.
(function () {
  const P = HTMLElement.prototype;
  const apply = (el, o) => { if (typeof o === 'string') { el.className = o; return el; } if (!o) return el;
    if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(' ') : o.cls; if (o.text != null) el.textContent = o.text;
    if (o.attr) for (const k in o.attr) el.setAttribute(k, o.attr[k]); if (o.type) el.type = o.type; if (o.value != null) el.value = o.value; if (o.placeholder) el.placeholder = o.placeholder; return el; };
  P.createEl = function (tag, o, cb) { const e = document.createElement(tag); apply(e, o); this.appendChild(e); cb && cb(e); return e; };
  P.createDiv = function (o) { return this.createEl('div', o); };
  P.createSpan = function (o) { return this.createEl('span', o); };
  P.empty = function () { this.innerHTML = ''; };
  P.addClass = function (...c) { this.classList.add(...c); };
  P.removeClass = function (...c) { this.classList.remove(...c); };
  P.toggleClass = function (c, v) { this.classList.toggle(c, v); };
  P.setText = function (t) { this.textContent = t; };
  window.createEl = (tag, o, cb) => { const e = document.createElement(tag); apply(e, o); cb && cb(e); return e; };
  window.createDiv = (o, cb) => window.createEl('div', o, cb); window.createSpan = (o, cb) => window.createEl('span', o, cb);
  class Events { constructor() { this._h = {}; } on(n, cb) { (this._h[n] ||= []).push(cb); return { n, cb }; } trigger(n, ...a) { (this._h[n] || []).forEach(f => f(...a)); } }
  class Component { constructor() { this._c = []; } load() {} onload() {} unload() { this._c.forEach(f => f()); } onunload() {} addChild(c) { return c; } register(cb) { this._c.push(cb); } registerEvent() {} registerDomEvent(el, t, cb, o) { el.addEventListener(t, cb, o); } registerInterval(i) { return i; } }
  class TAbstractFile {} class TFile extends TAbstractFile { constructor(path, data) { super(); this.path = path; this.name = path.split('/').pop(); this.basename = this.name.replace(/\.[^.]+$/, ''); this.extension = this.name.split('.').pop(); this.data = data; this.stat = { mtime: Date.now() }; } }
  class TFolder extends TAbstractFile {}
  const files = new Map();
  const vault = Object.assign(new Events(), {
    adapter: { exists: async (p) => files.has(p) },
    getAbstractFileByPath: (p) => files.get(p) || null,
    read: async (f) => f.data, cachedRead: async (f) => f.data,
    modify: async (f, d) => { f.data = d; vault.trigger('modify', f); },
    process: async (f, fn) => { f.data = fn(f.data); vault.trigger('modify', f); return f.data; },
    create: async (p, d) => { const f = new TFile(p, d); files.set(p, f); return f; },
    createFolder: async (p) => { const f = new TFolder(); f.path = p; files.set(p, f); return f; },
    getName: () => 'TestVault', _files: files,
    getMarkdownFiles: () => [...files.values()].filter(f => f instanceof TFile && f.extension === 'md'),
    createBinary: async (p, d) => { const f = new TFile(p, d); files.set(p, f); return f; },
  });
  class Scope { constructor() { this.keys = []; } register(m, k, fn) { this.keys.push({ m, k, fn }); } }
  class Modal { constructor(app) { this.app = app; this.scope = new Scope(); this.containerEl = document.createElement('div'); this.containerEl.className = 'modal-container';
      this.modalEl = this.containerEl.createDiv({ cls: 'modal' }); this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' }); this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' }); }
    open() { document.body.appendChild(this.containerEl); window.__modal = this; this.onOpen(); }
    close() { this.onClose(); this.containerEl.remove(); window.__modal = null; } onOpen() {} onClose() {} setTitle(t) { this.titleEl.textContent = t; return this; } }
  class Notice { constructor(m) { (window.__notices ||= []).push(String(m)); } hide() {} }
  class MenuItem { setTitle(t) { this.title = t; return this; } setIcon() { return this; } onClick(cb) { this.cb = cb; return this; } }
  class Menu { constructor() { this.items = []; } addItem(cb) { const i = new MenuItem(); cb(i); this.items.push(i); return this; } addSeparator() { return this; } showAtMouseEvent() { window.__menu = this; return this; } showAtPosition() { window.__menu = this; return this; } }
  class View extends Component {} class ItemView extends View { constructor(leaf) { super(); this.leaf = leaf; this.containerEl = document.createElement('div'); this.contentEl = this.containerEl.createDiv(); } }
  class FileView extends ItemView {} class TextFileView extends FileView { constructor(l) { super(l); this.requestSave = () => { window.__saved = this.getViewData(); }; } }
  class MarkdownView extends TextFileView {}
  class Plugin extends Component { constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this.processors = {}; this.post = []; this.commands = []; }
    addRibbonIcon(i, t, cb) { const b = document.createElement('button'); b.className = 'ribbon'; b.title = t; b.onclick = cb; document.body.appendChild(b); return b; }
    addCommand(c) { this.commands.push(c); } addSettingTab() {} registerMarkdownCodeBlockProcessor(l, fn) { this.processors[l] = fn; } registerMarkdownPostProcessor(fn) { this.post.push(fn); }
    registerView() {} registerExtensions() {} async loadData() { return {}; } async saveData() {} }
  class PluginSettingTab { constructor(app) { this.app = app; this.containerEl = document.createElement('div'); } }
  class Setting { constructor() {} setName() { return this; } setDesc() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addSlider() { return this; } addButton() { return this; } setHeading() { return this; } }
  const workspace = Object.assign(new Events(), { getActiveViewOfType: () => null, getActiveFile: () => null, onLayoutReady: (cb) => cb(), getLeaf: () => ({ openFile: async () => {} }) });
  window.__app = { vault, workspace, metadataCache: Object.assign(new Events(), { getFirstLinkpathDest: (l) => files.get(l) || null, getFileCache: () => null }), fileManager: {} };
  window.__obsidian = { Plugin, Modal, Notice, Menu, MenuItem, Component, TFile, TFolder, TAbstractFile, View, ItemView, FileView, TextFileView, MarkdownView, PluginSettingTab, Setting, Scope,
    MarkdownRenderChild: Component, parseYaml: (t) => JSON.parse(t), stringifyYaml: (o) => JSON.stringify(o, null, 2) + '\n', requestUrl: async () => ({ status: 404, text: '', json: null }), setIcon: (el, i) => { el.textContent = i[0].toUpperCase(); },
    normalizePath: (p) => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, ''), debounce: (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }, Platform: { isMobile: false, isDesktop: true } };
})();
