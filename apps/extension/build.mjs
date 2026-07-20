import { cpSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

// ---------------------------------------------------------------------------
// build.mjs — bundle the extension into dist/ (what Chrome "load unpacked"s).
//
// Two entry points, two output formats, which is why this is a script and not
// one bundler config:
//   • background.js — MV3 service worker; the manifest declares type:"module",
//     so ESM output is fine.
//   • content.js — injected into arbitrary pages, where import statements
//     don't exist; must be a self-contained IIFE.
// esbuild follows the workspace import to @jobber/shared's TS source and
// bundles it in — the same "one schema, both sides" as web ⇄ api.
// ---------------------------------------------------------------------------

mkdirSync("dist", { recursive: true });

const common = {
	bundle: true,
	target: "chrome120",
	logLevel: "info",
};

await build({
	...common,
	entryPoints: ["src/background.ts"],
	outfile: "dist/background.js",
	format: "esm",
});

await build({
	...common,
	entryPoints: ["src/content.ts"],
	outfile: "dist/content.js",
	format: "iife",
});

cpSync("manifest.json", "dist/manifest.json");
console.log("dist/ ready — load it via chrome://extensions → Load unpacked.");
