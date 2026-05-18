// Builds per-browser extension directories under dist/.
// Reads src/manifest.base.json + src/manifest.<target>.json, deep-merges,
// stamps version from package.json, and copies shared JS/CSS into dist/<target>/.
//
// Usage:
//   node build.mjs                  # build both targets
//   node build.mjs chrome           # build one target
//   node build.mjs chrome firefox   # build several
//   node build.mjs --watch          # initial build, then rebuild on src/ changes

import { readFile, writeFile, mkdir, rm, cp, watch as fsWatch } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');
const SHARED_FILES = ['background.js', 'content.js', 'styles.css'];
const ALL_TARGETS = ['chrome', 'firefox'];

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const explicit = args.filter(a => !a.startsWith('--'));
const targets = explicit.length ? explicit : ALL_TARGETS;

for (const t of targets) {
  if (!ALL_TARGETS.includes(t)) {
    console.error(`unknown target: ${t} (expected one of: ${ALL_TARGETS.join(', ')})`);
    process.exit(1);
  }
}

// Deep-merge semantics: plain object keys recurse; arrays and primitives in the
// override replace the base wholesale. Sufficient for current manifests. If an
// array-concat semantic is ever needed, change it here intentionally.
function deepMerge(base, override) {
  const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

async function buildTarget(target, version) {
  const outDir = path.join(DIST, target);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const base = await readJson(path.join(SRC, 'manifest.base.json'));
  const override = await readJson(path.join(SRC, `manifest.${target}.json`));
  const manifest = { ...deepMerge(base, override), version };

  await writeFile(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  for (const f of SHARED_FILES) {
    await cp(path.join(SRC, f), path.join(outDir, f));
  }
  console.log(`built dist/${target}`);
}

async function buildAll() {
  const pkg = await readJson(path.join(__dirname, 'package.json'));
  for (const t of targets) await buildTarget(t, pkg.version);
}

await buildAll();

if (watchMode) {
  let timer = null;
  console.log(`watching src/ for changes (targets: ${targets.join(', ')})`);
  const watcher = fsWatch(SRC, { recursive: true });
  for await (const _event of watcher) {
    clearTimeout(timer);
    timer = setTimeout(() => buildAll().catch(err => console.error(err)), 50);
  }
}
