#!/usr/bin/env node
/**
 * Detect how to run/preview the current project.
 *
 *   node detect-project.mjs
 *   node detect-project.mjs --project ../my-app --json
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PORTS = {
  next: 3000,
  nuxt: 3000,
  remix: 3000,
  vite: 5173,
  sveltekit: 5173,
  astro: 4321,
  angular: 4200,
  storybook: 6006,
  gatsby: 8000,
};

const COMMON_PORTS = [3000, 3001, 3002, 3007, 4200, 4321, 5173, 5174, 6006, 8000, 8080];

function args() {
  const out = { json: false, project: process.cwd() };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "--project") out.project = path.resolve(argv[++i]);
    else if (argv[i] === "--help") out.help = true;
  }
  return out;
}

async function probe(port) {
  for (const host of ["localhost", "127.0.0.1"]) {
    try {
      const response = await fetch(`http://${host}:${port}`, {
        signal: AbortSignal.timeout(800),
      });
      const type = response.headers.get("content-type") ?? "";
      if (response.status < 500 && (type.includes("text/html") || type === "")) {
        return `http://${host}:${port}`;
      }
    } catch {
      // not running
    }
  }
  return null;
}

async function main() {
  const options = args();
  if (options.help) {
    console.log("Usage: node detect-project.mjs [--project <dir>] [--json]");
    return;
  }

  const dir = options.project;
  let pkg = {};
  try {
    pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    // no package.json
  }

  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const framework =
    ("next" in deps && "next") ||
    ("nuxt" in deps && "nuxt") ||
    ("@sveltejs/kit" in deps && "sveltekit") ||
    ("astro" in deps && "astro") ||
    ("@remix-run/react" in deps && "remix") ||
    ("vite" in deps && "vite") ||
    ("react-scripts" in deps && "create-react-app") ||
    ("@angular/core" in deps && "angular") ||
    ("gatsby" in deps && "gatsby") ||
    ("@storybook/react" in deps && "storybook") ||
    ("storybook" in deps && "storybook") ||
    null;
  const manager = existsSync(path.join(dir, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(path.join(dir, "yarn.lock"))
      ? "yarn"
      : existsSync(path.join(dir, "bun.lockb")) || existsSync(path.join(dir, "bun.lock"))
        ? "bun"
        : "npm";
  const scripts = pkg.scripts ?? {};
  const script = ["dev", "start", "develop", "serve"].find((name) => scripts[name]) ?? null;
  const expectedPort = PORTS[framework] ?? null;
  const ports = [...new Set([...(expectedPort ? [expectedPort] : []), ...COMMON_PORTS])];
  const running = [];
  for (const port of ports) {
    const url = await probe(port);
    if (url) running.push(url);
  }

  const report = {
    project: dir,
    name: pkg.name ?? null,
    framework,
    packageManager: manager,
    devScript: script,
    devCommand: script ? `${manager} run ${script}` : null,
    likelyPort: expectedPort,
    runningUrls: running,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Project: ${report.name ?? path.basename(dir)} (${dir})`);
  console.log(`Framework: ${framework ?? "unknown"}`);
  console.log(`Package manager: ${manager}`);
  console.log(`Dev command: ${report.devCommand ?? "not detected"}`);
  console.log(`Likely port: ${expectedPort ?? "unknown"}`);
  console.log(
    `Running: ${running.length ? running.join(", ") : "none detected — start the dev server"}`,
  );
  if (running[0]) console.log(`\nPreview: node preview.mjs --url ${running[0]} --full`);
}

main().catch((error) => {
  console.error(`detect-project failed: ${error.message}`);
  process.exitCode = 1;
});
