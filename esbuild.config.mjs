import esbuild from "esbuild";
import { readFileSync, writeFileSync } from "fs";

const prod = process.argv[2] === "production";
const banner = "/* ChemEdit — lightweight chemical structure editor for Obsidian. Generated bundle; see src/ for sources. */";

// styles.css = editor + plugin chrome
writeFileSync("styles.css", readFileSync("src/editor/editor.css", "utf8") + "\n" + readFileSync("src/plugin/plugin.css", "utf8"));

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/plugin/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2020",
  loader: { ".css": "text" },
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
});
if (prod) { await ctx.rebuild(); process.exit(0); } else { await ctx.watch(); }
