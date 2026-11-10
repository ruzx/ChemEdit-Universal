// Safe DOM helpers — no innerHTML / insertAdjacentHTML anywhere in the plugin.
// SVG strings produced by our own renderer are parsed with DOMParser (as XML) and
// imported as nodes; rich text uses a tiny allow-list sanitiser.

const SVGNS = "http://www.w3.org/2000/svg";

/** Remove all children. */
export function clearEl(el: Element) { while (el.firstChild) el.removeChild(el.firstChild); }

/** Parse a standalone `<svg>…</svg>` string into an element owned by `doc`. Returns null on parse errors. */
export function parseSvg(svg: string, doc: Document = document): SVGSVGElement | null {
  if (!svg) return null;
  svg = svg.trim();
  // icon strings are often written without a namespace; XML parsing needs it to produce real SVG elements
  if (!/^<svg\b[^>]*\sxmlns=/.test(svg)) svg = svg.replace(/^<svg\b/, `<svg xmlns="${SVGNS}"`);
  if (!/\sxmlns:xlink=/.test(svg) && /xlink:/.test(svg)) svg = svg.replace(/^<svg\b/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  const x = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = x.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || x.getElementsByTagName("parsererror").length) return null;
  stripScripts(root);
  return doc.importNode(root, true) as unknown as SVGSVGElement;
}

/** Replace the content of `el` with the parsed SVG string. Returns true when something was drawn. */
export function setSvg(el: Element, svg: string): boolean {
  clearEl(el);
  const node = parseSvg(svg, el.ownerDocument);
  if (node) el.appendChild(node);
  return !!node;
}

/** Append a parsed SVG string (e.g. an icon) to `el`. */
export function appendSvg(el: Element, svg: string) {
  const node = parseSvg(svg, el.ownerDocument);
  if (node) el.appendChild(node);
  return node;
}

/** Set the children of an SVG element (`<g>`, `<svg>`) from SVG markup fragments. */
export function setSvgChildren(el: Element, markup: string) {
  clearEl(el);
  if (!markup) return;
  const x = new DOMParser().parseFromString(`<svg xmlns="${SVGNS}">${markup}</svg>`, "image/svg+xml");
  if (x.getElementsByTagName("parsererror").length) return;
  stripScripts(x.documentElement);
  const doc = el.ownerDocument;
  for (const c of Array.from(x.documentElement.childNodes)) el.appendChild(doc.importNode(c, true));
}

/** Serialise an element (instead of reading outerHTML). */
export const serializeEl = (el: Element) => new XMLSerializer().serializeToString(el);

function stripScripts(root: Element) {
  root.querySelectorAll("script,foreignObject").forEach((n) => n.remove());
  const walk = (e: Element) => { for (const a of Array.from(e.attributes)) if (/^on/i.test(a.name) || /javascript:/i.test(a.value)) e.removeAttribute(a.name); for (const c of Array.from(e.children)) walk(c); };
  walk(root);
}

const RICH_TAGS = new Set(["B", "I", "EM", "STRONG", "SUB", "SUP", "KBD", "SPAN", "H4", "BR", "CODE"]);
/** Append a small, trusted rich-text snippet (sub/sup/b/kbd/h4…) using an allow-list. */
export function appendRich(el: HTMLElement, html: string) {
  const x = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const doc = el.ownerDocument;
  const copy = (src: Node, dst: Node) => {
    for (const n of Array.from(src.childNodes)) {
      if (n.nodeType === 3) dst.appendChild(doc.createTextNode(n.textContent ?? ""));
      else if (n.nodeType === 1) {
        const e = n as Element;
        if (!RICH_TAGS.has(e.tagName)) { copy(e, dst); continue; }
        const c = doc.createElementNS(XHTML, e.tagName.toLowerCase());
        const cls = e.getAttribute("class"); if (cls) c.className = cls;
        dst.appendChild(c); copy(e, c);
      }
    }
  };
  copy(x.body, el);
}
export function setRich(el: HTMLElement, html: string) { clearEl(el); appendRich(el, html); }

/** Inline styles without touching `el.style.x = …` (uses Obsidian's setCssStyles when present). */
export function setStyles(el: HTMLElement, s: Partial<CSSStyleDeclaration>) {
  if (typeof el.setCssStyles === "function") { el.setCssStyles(s); return; }
  for (const [k, v] of Object.entries(s)) if (typeof v === "string") el.style.setProperty(k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()), v);
}

const XHTML = "http://www.w3.org/1999/xhtml";
/** Create an HTML element in `doc` (works in pop-out windows and outside Obsidian). */
export function htmlEl<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, parent?: Element): HTMLElementTagNameMap[K] {
  const e = doc.createElementNS(XHTML, tag) as HTMLElementTagNameMap[K];
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}
