// SVG -> PNG (browser only).
export async function svgToPngBlob(svg: string, scale = 3, background: string | null = "#ffffff"): Promise<Blob> {
  const m = /width="([\d.]+)"\s+height="([\d.]+)"/.exec(svg);
  const w = m ? parseFloat(m[1]) : 300, h = m ? parseFloat(m[2]) : 200;
  const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.replace(/currentColor/g, "#000000"));
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("SVG rasterisation failed")); img.src = src; });
  const c = document.createElement("canvas");
  c.width = Math.ceil(w * scale); c.height = Math.ceil(h * scale);
  const ctx = c.getContext("2d")!;
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("PNG encoding failed"))), "image/png"));
}
