import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceIndex = process.argv.indexOf("--source");
const manifestIndex = process.argv.indexOf("--approved-manifest");
if (sourceIndex < 0 || manifestIndex < 0 || !process.argv[sourceIndex + 1] || !process.argv[manifestIndex + 1]) {
  throw new Error("Vero import needs the original brand folder and approved manifest. Pass --source <Vero> --approved-manifest <manifest.json>.");
}
const source = resolve(process.argv[sourceIndex + 1]);
const manifest = JSON.parse(readFileSync(resolve(process.argv[manifestIndex + 1]), "utf8"));
const output = fileURLToPath(new URL("../assets/vero/", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const guide = readFileSync(resolve(source, "Vero Brand System/Vero.pdf"));
if (hash(guide) !== manifest.brandGuideSha256) {
  throw new Error("Vero guide does not match the approved manifest. Use the approved source archive.");
}
const keys = new Set(["pixel", "rich", "working", "review", "blocked", "done"]);
const selected = manifest.assets.filter((asset) => keys.has(asset.key));
if (selected.length !== keys.size || new Set(selected.map((asset) => asset.key)).size !== keys.size) {
  throw new Error("Vero manifest does not contain each required pose once. Restore the approved manifest.");
}
const assets = selected.map((asset) => {
  const svg = readFileSync(resolve(source, asset.source));
  if (hash(svg) !== asset.sha256) {
    throw new Error(`Vero source "${asset.source}" differs from the approved artwork. Restore the original bytes.`);
  }
  const pngSource = asset.source.replace("/SVG/", "/PNG/").replace(/\.svg$/, ".png");
  const png = readFileSync(resolve(source, pngSource));
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`Vero source "${pngSource}" is not PNG. Use the original artwork.`);
  }
  return {
    key: asset.key, file: `vero-${asset.key}.png`, svgFile: asset.file, source: pngSource,
    sha256: hash(png), bytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
    svgSource: asset.source, svgSha256: asset.sha256, png, svg,
  };
});
mkdirSync(output, { recursive: true });
for (const asset of assets) {
  writeFileSync(resolve(output, asset.file), asset.png);
  writeFileSync(resolve(output, asset.svgFile), asset.svg);
}
writeFileSync(resolve(output, "manifest.json"), `${JSON.stringify({
  version: 1,
  sourceRepository: "getsimpledirect/simpledirect-2026-marketing-website",
  sourceCommit: "ee968ae96f32856ae25925779d2b44ffc5f2f7f8",
  sourceArchive: manifest.sourceArchive,
  sourceArchiveSha256: manifest.sourceArchiveSha256,
  brandGuideSha256: manifest.brandGuideSha256,
  treatment: "Original PNG and SVG bytes, with aspect ratio preserved; no redrawing, recolouring, effects or invented poses.",
  assets: assets.map(({ png, svg, ...asset }) => asset),
}, null, 2)}\n`);
console.log(`Vero import verified ${assets.length} approved SVG sources and preserved their original PNG counterparts.`);
