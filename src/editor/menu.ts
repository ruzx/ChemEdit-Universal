// Lightweight context / dropdown menu with submenus, check marks and shortcuts.
import { appendRich, setStyles } from "../render/dom";

export type MenuEntry =
  | "-"
  | { label: string; action?: () => void; checked?: boolean; disabled?: boolean; shortcut?: string; submenu?: MenuEntry[]; danger?: boolean; html?: string };

export class PopupMenu {
  private els: HTMLElement[] = [];
  private onDocDown = (e: PointerEvent) => { if (!this.els.some((el) => el.contains(e.target as Node))) this.close(); };
  private onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); this.close(); } };
  onClose: (() => void) | null = null;

  constructor(private host: HTMLElement) {}

  get open() { return this.els.length > 0; }

  show(items: MenuEntry[], x: number, y: number) {
    this.close();
    this.level(items, x, y, 0);
    window.setTimeout(() => {
      this.host.ownerDocument.addEventListener("pointerdown", this.onDocDown, true);
      this.host.ownerDocument.addEventListener("keydown", this.onKey, true);
    }, 0);
  }

  private level(items: MenuEntry[], x: number, y: number, depth: number, parentItem?: HTMLElement) {
    // drop deeper levels
    while (this.els.length > depth) this.els.pop()!.remove();
    const doc = this.host.ownerDocument;
    const m = doc.createElement("div");
    m.className = "ce-menu";
    for (const it of items) {
      if (it === "-") { const s = doc.createElement("div"); s.className = "ce-menu-sep"; m.appendChild(s); continue; }
      const row = doc.createElement("div");
      row.className = "ce-menu-item" + (it.disabled ? " ce-disabled" : "") + (it.danger ? " ce-danger" : "");
      const sp = (cls: string) => { const e = doc.createElement("span"); e.className = cls; row.appendChild(e); return e; };
      sp("ce-menu-check").textContent = it.checked ? "✓" : "";
      const lab = sp("ce-menu-label"); if (it.html) appendRich(lab, it.html); else lab.textContent = it.label;
      sp("ce-menu-sc").textContent = it.submenu ? "▸" : it.shortcut ?? "";
      if (!it.disabled) {
        const openSub = () => {
          const r = row.getBoundingClientRect(), hr = this.host.getBoundingClientRect();
          this.level(it.submenu!, r.right - hr.left - 2, r.top - hr.top - 4, depth + 1, row);
        };
        if (it.submenu) {
          row.addEventListener("pointerenter", (e) => { if ((e as PointerEvent).pointerType === "mouse") openSub(); });
          row.addEventListener("click", (e) => { e.stopPropagation(); openSub(); });
        } else {
          row.addEventListener("pointerenter", () => { while (this.els.length > depth + 1) this.els.pop()!.remove(); });
          row.addEventListener("click", (e) => { e.stopPropagation(); this.close(); it.action?.(); });
        }
      }
      m.appendChild(row);
    }
    m.addEventListener("contextmenu", (e) => e.preventDefault());
    this.host.appendChild(m);
    this.els.push(m);
    // keep inside host
    const hr = this.host.getBoundingClientRect();
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let px = x, py = y;
    if (px + mw > hr.width - 4) px = parentItem ? x - mw - (parentItem.offsetWidth - 4) : hr.width - mw - 4;
    if (py + mh > hr.height - 4) py = Math.max(4, hr.height - mh - 4);
    setStyles(m, { left: Math.max(4, px) + "px", top: Math.max(4, py) + "px" });
  }

  close() {
    if (!this.els.length) return;
    for (const e of this.els) e.remove();
    this.els = [];
    this.host.ownerDocument.removeEventListener("pointerdown", this.onDocDown, true);
    this.host.ownerDocument.removeEventListener("keydown", this.onKey, true);
    this.onClose?.();
  }
}

