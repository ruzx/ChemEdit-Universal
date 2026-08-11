import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

esbuild.build({
    entryPoints: ["main.ts"],
    bundle: true,
    format: "cjs",
    target: "es2018",
    external: [
        "obsidian",
        "electron",
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
    ],
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile: "main.js",
}).catch(() => process.exit(1));