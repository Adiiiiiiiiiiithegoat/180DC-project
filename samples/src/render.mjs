// Regenerates every sample from the HTML beside this file: node samples/src/render.mjs
// Windows + Edge headless for rendering (print-to-pdf keeps a real text layer), sharp to roughen the "photos".
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, "..", "delivery-notes");
const test = join(here, "..", "test-documents");
const tmp = join(here, ".tmp");
for (const d of [demo, test, tmp]) mkdirSync(d, { recursive: true });

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const url = (f) => pathToFileURL(join(here, f)).href;
const edge = (...args) => execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", ...args], { stdio: "ignore" });
const shot = (html, w, h) => {
  const out = join(tmp, `${html}.png`);
  edge(`--screenshot=${out}`, `--window-size=${w},${h}`, url(html));
  return out;
};
const pdf = (html, out) => edge(`--print-to-pdf=${out}`, "--no-pdf-header-footer", url(html));

// Demo samples: three layouts.
pdf("kaveri-wholesale.html", join(demo, "kaveri-wholesale-DN-4471.pdf"));
pdf("kaveri-wholesale-2.html", join(demo, "kaveri-wholesale-DN-4502.pdf"));
pdf("kaveri-wholesale-3.html", join(demo, "kaveri-wholesale-DN-4530.pdf"));
pdf("kaveri-wholesale-4.html", join(demo, "kaveri-wholesale-DN-4560.pdf"));
pdf("kaveri-wholesale-5.html", join(demo, "kaveri-wholesale-DN-4575.pdf"));
await sharp(shot("sharma-traders.html", 920, 640))
  .rotate(1.2, { background: "#6b5b4b" }).blur(0.8).modulate({ brightness: 0.93, saturation: 0.85 })
  .jpeg({ quality: 58 }).toFile(join(demo, "sharma-traders-challan.jpg"));
await sharp(shot("coastal-fmcg.html", 950, 400)).png().toFile(join(demo, "coastal-fmcg-invoice-2291.png"));

// Test documents: prompt injection (both paths), a cat, a blank page, and bytes that are not a document.
await sharp(shot("injection.html", 870, 520)).png().toFile(join(test, "injection-delivery-note.png"));
pdf("injection.html", join(test, "injection-delivery-note.pdf"));
await sharp(shot("long-note.html", 870, 900)).png().toFile(join(test, "long-delivery-note-25-lines.png"));
pdf("long-note.html", join(test, "long-delivery-note-25-lines.pdf"));
await sharp(shot("cat.html", 900, 700)).jpeg({ quality: 80 }).toFile(join(test, "cat.jpg"));
await sharp({ create: { width: 1240, height: 1754, channels: 3, background: "#ffffff" } }).png().toFile(join(test, "blank-page.png"));
writeFileSync(join(test, "garbage.pdf"), randomBytes(40_000));

rmSync(tmp, { recursive: true, force: true });
console.log("samples rendered");
