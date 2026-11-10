import EDITOR_CSS from "./editor.css";

export { EDITOR_CSS };

/** Inject editor styles (used when running outside Obsidian; the plugin ships styles.css instead). */
export function injectEditorCss(doc: Document = document) {
  if (doc.getElementById("chemedit-editor-css")) return;
  const st = doc.createElementNS("http://www.w3.org/1999/xhtml", "style") as HTMLStyleElement;
  st.id = "chemedit-editor-css";
  st.textContent = EDITOR_CSS;
  doc.head.appendChild(st);
}
