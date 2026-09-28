// One scope, many <script> tags: catch a declaration two files both make.
//
// web/js/*.js are CLASSIC scripts, not modules — index.html says so, and it is
// load-bearing: they share one global scope exactly as the single main.js they
// were split out of did. That means every top-level `let`/`const`/`class` lands
// in ONE global lexical environment, so two files declaring the same name is a
// SyntaxError — and the browser throws it while compiling the SECOND file, which
// therefore never runs at all. Lose 13-macros.js that way and `setupInput` never
// binds: no keyboard, no mouse, no chat. A completely dead client.
//
// `node --check`, the gate this sits next to, compiles each file ALONE and is
// structurally blind to it. This compiles them the way the page does: one
// concatenation, in index.html's own order, and only COMPILED — never executed,
// so no DOM, no PixiJS, no network, and nothing to stub.
//
// Usage: node scripts/check-web-globals.mjs   (exit 1 on a collision)

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const PAGE = path.join(ROOT, "web", "index.html");

// index.html is the source of truth for WHICH scripts load and in WHAT ORDER —
// a directory listing would silently disagree with the page the moment a tag is
// added, removed or reordered. `vendor/` is a pre-built PixiJS drop, not ours.
const html = fs.readFileSync(PAGE, "utf8");
const files = [...html.matchAll(/<script\s+src="([^"]+)"\s*>\s*<\/script>/g)]
  .map((m) => m[1].split("?")[0])
  .filter((src) => !src.startsWith("vendor/"));

if (!files.length) {
  console.error("check-web-globals: no <script src> tags found in web/index.html");
  process.exit(1);
}

// Concatenate with a line map, so a compile error can be reported against the
// file and line a human can actually open.
const chunks = [];
const starts = [];                  // [{ rel, firstLine }], firstLine 1-based
let line = 1;
for (const rel of files) {
  let src = fs.readFileSync(path.join(ROOT, "web", rel), "utf8");
  if (!src.endsWith("\n")) src += "\n";
  starts.push({ rel, firstLine: line });
  chunks.push(src);
  line += src.split("\n").length - 1;
}
const combined = chunks.join("");
const locate = (combinedLine) => {
  let hit = starts[0];
  for (const s of starts) if (s.firstLine <= combinedLine) hit = s;
  return { rel: hit.rel, line: combinedLine - hit.firstLine + 1 };
};

// Every top-level declaration in a file, for pointing at BOTH sides of a clash.
// Only used to explain an error V8 has already found, so a miss here costs a
// less helpful message, never a wrong verdict.
function declarationsOf(rel, name) {
  const src = fs.readFileSync(path.join(ROOT, "web", rel), "utf8").split("\n");
  const out = [];
  const re = new RegExp(`^(?:const|let|var|function|class)\\s[^=]*?\\b${name}\\b`);
  src.forEach((text, i) => { if (re.test(text)) out.push(`${rel}:${i + 1}`); });
  return out;
}

try {
  // Compile only. `new vm.Script` never runs the code.
  new vm.Script(combined, { filename: "web/<all scripts, concatenated>" });
} catch (err) {
  const at = /web\/<all scripts, concatenated>:(\d+)/.exec(err.stack || "");
  const where = at ? locate(+at[1]) : null;
  console.error("check-web-globals: web/js/*.js do not compile as one scope");
  console.error(`  ${err.message}`);
  if (where) console.error(`  at web/${where.rel}:${where.line}`);
  const dup = /Identifier '([^']+)' has already been declared/.exec(err.message);
  if (dup) {
    const sites = files.flatMap((rel) => declarationsOf(rel, dup[1])).map((s) => "web/" + s);
    if (sites.length > 1) {
      console.error(`  '${dup[1]}' is declared at:`);
      for (const s of sites) console.error(`    ${s}`);
    }
    console.error(
      "  These files share ONE global scope (classic scripts, see index.html).\n" +
      "  Rename one, or move the value into the file that should own it — as it\n" +
      "  stands the browser aborts the later file entirely."
    );
  }
  process.exit(1);
}

console.log(`web/js: ${files.length} scripts compile as one shared scope`);
