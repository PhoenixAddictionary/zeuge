#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const exportDir = process.argv[2];
if (!exportDir) {
  console.error("usage: node tools/publish-readiness-sweep.cjs <exportDir>");
  process.exit(2);
}
const root = path.resolve(exportDir);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error("exportDir missing or not a directory:", root);
  process.exit(2);
}

// Patterns built so this file does not match itself.
const FORBIDDEN = [
  { re: new RegExp("polar" + "_oat_", "i"), label: "polar OAT literal" },
  { re: new RegExp("POLAR_ACCESS_" + "TOKEN\\s*=\\s*\\S+", "i"), label: "POLAR_ACCESS_TOKEN assignment" },
  { re: new RegExp("ZEUGE_POLAR_" + "ORG\\s*=\\s*[0-9a-f-]{8,}", "i"), label: "live org id assignment" },
  { re: /"private"\s*:\s*true/i, label: "private:true" },
  { re: new RegExp("CHAIRMAN_" + "WORT", "i"), label: "chairman wort token" },
  { re: /BEGIN (RSA |OPENSSH )?PRIVATE KEY/i, label: "private key PEM" },
];

const SKIP_DIR = new Set(["node_modules", ".git", "dist", "tests", "fixtures", "src"]);
const SKIP_FILE = new Set(["publish-readiness-sweep.cjs", "publish-readiness-sweep.mjs"]);
const hits = [];
function walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    if (SKIP_DIR.has(ent.name)) continue;
    if (ent.isFile() && SKIP_FILE.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.isFile()) {
      let text;
      try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
      for (const f of FORBIDDEN) {
        if (f.re.test(text)) hits.push({ file: path.relative(root, p), label: f.label });
      }
    }
  }
}
walk(root);

const soft = [];
const pkgPath = path.join(root, "package.json");
const pluginPath = path.join(root, ".claude-plugin", "plugin.json");
const marketRoot = path.join(root, ".claude-plugin", "marketplace.json");
const marketNested = path.join(root, "marketplace", ".claude-plugin", "marketplace.json");
if (!fs.existsSync(pkgPath)) soft.push("missing package.json");
else {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (pkg.private === true) hits.push({ file: "package.json", label: "private:true" });
  if (!pkg.name || pkg.name !== "zeuge") soft.push("package name is " + pkg.name);
  if (!pkg.version) soft.push("package.json missing version");
  if (!pkg.license || String(pkg.license).toUpperCase() !== "MIT") soft.push("license not MIT in package.json");
}
if (!fs.existsSync(pluginPath)) hits.push({ file: ".claude-plugin/plugin.json", label: "missing plugin manifest" });
if (!fs.existsSync(marketRoot)) {
  soft.push("missing .claude-plugin/marketplace.json at export root");
  if (fs.existsSync(marketNested)) soft.push("found nested marketplace/.claude-plugin/marketplace.json — relocate before act 2");
}
if (!fs.existsSync(path.join(root, "LICENSE"))) soft.push("missing LICENSE");
if (!fs.existsSync(path.join(root, "README.md"))) soft.push("missing README.md");

console.log("zeuge publish-readiness-sweep");
console.log("export:", root);
console.log("hard_hits:", hits.length);
for (const h of hits) console.log("  HARD", h.file, "-", h.label);
console.log("soft:", soft.length);
for (const s of soft) console.log("  SOFT", s);
console.log("blind_spots:");
console.log("  - does not run tests or verify:dist");
console.log("  - does not prove claim-hook e2e");
console.log("  - does not check payment provider wiring (non-payment path)");
console.log("  - does not create GitHub repo or push");
process.exit(hits.length ? 1 : 0);

