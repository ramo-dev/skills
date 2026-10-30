#!/usr/bin/env node
/**
 * Headless UI preview for coding agents.
 *
 * One-shot Chromium/CDP screenshot + audit tool. No npm dependencies.
 * Requires Node 22+ (global WebSocket/fetch) and a Chromium-based browser.
 *
 *   node preview.mjs --url http://localhost:3000 --out /tmp/home.png --full
 *   node preview.mjs --url http://localhost:3000 --mobile --dark --out /tmp/mobile.png
 *   node preview.mjs --url http://localhost:3000 --selector "#courses" --out /tmp/courses.png
 *   node preview.mjs --url http://localhost:3000 --actions flow.json --out /tmp/end.png
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

const DEVICE_PRESETS = {
  desktop: { width: 1440, height: 900, dpr: 1, mobile: false },
  laptop: { width: 1280, height: 800, dpr: 1, mobile: false },
  "iphone-15": {
    width: 393,
    height: 852,
    dpr: 3,
    mobile: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "iphone-se": {
    width: 375,
    height: 667,
    dpr: 2,
    mobile: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  },
  "pixel-7": {
    width: 412,
    height: 915,
    dpr: 2.625,
    mobile: true,
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  },
  ipad: {
    width: 820,
    height: 1180,
    dpr: 2,
    mobile: true,
    ua: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
};

const FRAMEWORK_PORTS = {
  next: 3000,
  vite: 5173,
  astro: 4321,
  nuxt: 3000,
  remix: 3000,
  sveltekit: 5173,
  angular: 4200,
  storybook: 6006,
  gatsby: 8000,
};

const COMMON_PORTS = [3000, 3001, 3002, 3007, 4200, 4321, 5173, 5174, 6006, 8000, 8080, 8888];

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Arc.app/Contents/MacOS/Arc",
  "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
  "/Applications/Opera.app/Contents/MacOS/Opera",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/usr/bin/brave-browser",
  "/usr/bin/brave",
  "/usr/bin/microsoft-edge",
  "/usr/bin/microsoft-edge-stable",
  "/opt/google/chrome/chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
].filter(Boolean);

async function detectProject(dir = process.cwd()) {
  let pkg = {};
  try {
    pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    return { dir, framework: null, manager: null, script: null, port: null, name: null };
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
    ("storybook" in deps && "storybook") ||
    ("@storybook/react" in deps && "storybook") ||
    null;
  const manager = existsSync(path.join(dir, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(path.join(dir, "yarn.lock"))
      ? "yarn"
      : existsSync(path.join(dir, "bun.lockb")) || existsSync(path.join(dir, "bun.lock"))
        ? "bun"
        : existsSync(path.join(dir, "package-lock.json"))
          ? "npm"
          : "npm";
  const scripts = pkg.scripts ?? {};
  const script = ["dev", "start", "develop", "serve"].find((name) => scripts[name]) ?? null;
  return {
    dir,
    framework,
    manager,
    script,
    port: FRAMEWORK_PORTS[framework] ?? 3000,
    name: pkg.name ?? null,
  };
}

async function discoverUrl(args, timeout) {
  const project = await detectProject(args.project ?? process.cwd());
  if (process.env.UI_PREVIEW_URL) return { url: process.env.UI_PREVIEW_URL, project };
  if (args.port) {
    for (const host of ["localhost", "127.0.0.1"]) {
      const candidate = `http://${host}:${args.port}`;
      try {
        const response = await fetch(candidate, { signal: AbortSignal.timeout(2000) });
        if (response.status < 500) return { url: candidate, project };
      } catch {
        // try next host
      }
    }
  }
  const ports = [
    ...new Set([
      ...(project.port ? [project.port] : []),
      ...COMMON_PORTS,
    ]),
  ];
  for (const port of ports) {
    for (const host of ["localhost", "127.0.0.1"]) {
      const candidate = `http://${host}:${port}`;
      try {
        const response = await fetch(candidate, { signal: AbortSignal.timeout(1200) });
        const type = response.headers.get("content-type") ?? "";
        if (response.status < 500 && (type.includes("text/html") || type === "")) {
          return { url: candidate, project };
        }
      } catch {
        // try next
      }
    }
  }
  const command = project.script ? `${project.manager} run ${project.script}` : "your dev server";
  throw new Error(
    `No running dev server found. Start it with "${command}" or pass --url.` +
      (project.framework ? ` Detected framework: ${project.framework}.` : ""),
  );
}

const BOOLEAN_FLAGS = new Set([
  "full",
  "mobile",
  "dark",
  "dark-class",
  "no-wait",
  "no-final",
  "fail-on-error",
  "disable-animations",
  "reduced-motion",
  "print",
  "json",
  "quiet",
  "help",
  "ignore-certificate-errors",
  "no-sandbox",
]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value == null) throw new Error(`Missing value for --${key}`);
    if (key === "action" || key === "header" || key === "cookie" || key === "click") {
      (args[key] ??= []).push(value);
    } else {
      args[key] = value;
    }
  }
  return args;
}

function usage() {
  return `Headless UI preview

Usage:
  node preview.mjs [--url <url>] [options]

URL:
  --url <url>              Page to open (or pass as the first positional arg)
  --port <port>            Prefer this port when auto-detecting a dev server
  --project <dir>          Project directory used to detect the framework/port
                            (default: current directory)
  Auto-detection scans UI_PREVIEW_URL, then the detected framework port and
  common ports (3000, 3001, 3007, 4200, 4321, 5173, 5174, 6006, 8000...).

Core:
  --out <file>             Screenshot path (default: <tmp>/ui-preview/ui-preview-<ts>.png)
  --full                   Capture the full page instead of the viewport
  --selector <css>         Capture a single element (implies element clip)
  --padding <px>           Padding around --selector (default 0)
  --wait <ms>              Extra settle time after load (default 600)
  --wait-for <css>         Wait for a selector before capturing
  --timeout <ms>           Navigation/CDP timeout (default 60000)
  --no-wait                Do not wait for the URL to return HTTP
  --no-final               Do not take the default final screenshot
  --json                   Print the audit report as JSON
  --json-out <file>        Write the audit report as JSON
  --quiet                  Only print the screenshot path
  --fail-on-error          Exit 1 on console/page/request errors or overflow

Viewport / media:
  --width <px>             Viewport width (default 1440; 390 with --mobile)
  --height <px>            Viewport height (default 900; 844 with --mobile)
  --dpr <n>                Device scale factor (default 1)
  --viewport <w>x<h>       Shorthand viewport, e.g. 1440x900
  --device <name>          desktop, laptop, iphone-15, iphone-se, pixel-7, ipad
  --mobile                 Mobile viewport, touch and iPhone UA
  --ua <string>            Override user agent
  --dark                   Emulate prefers-color-scheme: dark
  --dark-class             Add class="dark" to <html> after load
  --reduced-motion         Emulate prefers-reduced-motion: reduce
  --print                  Emulate print media
  --format <png|jpeg>      Screenshot format (default png)
  --quality <1-100>        JPEG quality
  --wait-until <event>     load (default) or networkidle
  --ignore-certificate-errors  Allow self-signed/local HTTPS certificates
  --no-sandbox             Chromium --no-sandbox (CI/container)
  --locale <locale>        e.g. en-GB
  --timezone <tz>          e.g. Africa/Nairobi
  --disable-animations     Freeze CSS animations/transitions for stable shots

Interaction / auth:
  --click <css>            Click an element (repeatable)
  --type-into <css>        Focus this field before --type
  --type <text>            Insert text into the focused field
  --press <key>            Press a key (Enter, Escape, Tab, ArrowDown, ...)
  --eval <js>              Evaluate JavaScript after load (JSON-safe result)
  --action <json>          One action object (repeatable)
  --actions <file.json>    Array of actions, run in order
  --header "Name: value"   Extra request header (repeatable)
  --cookie "a=b; c=d"      Cookies for the target origin
  --script <file.json>     Alias for --actions

Action objects:
  {"type":"click","selector":"#open"}
  {"type":"type","selector":"input","text":"B2"}
  {"type":"press","key":"Enter"}
  {"type":"waitFor","selector":"[role=listbox]"}
  {"type":"wait","ms":500}
  {"type":"scrollTo","selector":"#courses"}
  {"type":"eval","expression":"document.title"}
  {"type":"screenshot","out":"/tmp/state.png","full":true}
  {"type":"screenshot","out":"/tmp/card.png","selector":".card"}

Environment:
  CHROME_PATH              Browser binary override
  UI_PREVIEW_URL           Default URL when --url is omitted
  UI_PREVIEW_WIDTH         Default viewport width
  UI_PREVIEW_HEIGHT        Default viewport height
  UI_PREVIEW_DPR           Default device scale factor
  UI_PREVIEW_FORMAT        Default screenshot format
  UI_PREVIEW_COOKIE        Cookie string (used when --cookie is omitted)
  UI_PREVIEW_HEADER        One extra header (used when --header is omitted)
`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    "No Chromium-based browser found. Set CHROME_PATH to Chrome, Brave, Chromium or Edge.",
  );
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHttp(url, timeout) {
  if (!/^https?:/i.test(url)) return;
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(10000, timeout)),
      });
      if (response.status < 500) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
  }
  throw new Error(`URL did not become ready within ${timeout}ms: ${lastError?.message ?? url}`);
}

async function waitForCdp(port, timeout) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Chrome DevTools did not start: ${lastError?.message ?? "timeout"}`);
}

class CDP {
  constructor(url, timeout) {
    if (typeof WebSocket === "undefined") {
      throw new Error("This helper requires Node 22+ (global WebSocket).");
    }
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket timeout")), timeout);
      this.socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.socket.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP websocket error: ${event?.message ?? "unknown"}`));
      };
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
        }
        return;
      }
      const handlers = this.listeners.get(message.method) ?? [];
      for (const handler of handlers) handler(message.params);
    };
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) ?? [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  once(method, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeout);
      const handler = (params) => {
        clearTimeout(timer);
        const handlers = this.listeners.get(method) ?? [];
        this.listeners.set(
          method,
          handlers.filter((item) => item !== handler),
        );
        resolve(params);
      };
      this.on(method, handler);
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // ignore
    }
  }
}

async function evaluate(cdp, expression, awaitPromise = false) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return result.value;
}

async function waitForSelector(cdp, selector, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const found = await evaluate(
      cdp,
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    );
    if (found) return;
    await sleep(100);
  }
  throw new Error(`Selector not found within ${timeout}ms: ${selector}`);
}

async function settle(cdp, waitMs) {
  await evaluate(cdp, "document.fonts ? document.fonts.ready.then(() => true) : true", true).catch(
    () => {},
  );
  await evaluate(
    cdp,
    `Promise.race([
      Promise.all(Array.from(document.images).map((img) =>
        img.complete ? Promise.resolve() : new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        })
      )),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ])`,
    true,
  ).catch(() => {});
  await sleep(waitMs);
}

async function clickSelector(cdp, selector) {
  await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    })()`,
  );
  await sleep(120);
  const rect = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
  if (!rect) throw new Error(`Cannot click missing selector: ${selector}`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rect.x,
    y: rect.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
}

const KEY_CODES = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Space: { code: "Space", keyCode: 32, text: " " },
};

async function pressKey(cdp, key) {
  const info = KEY_CODES[key] ?? { code: key, keyCode: 0 };
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
    ...(info.text ? { text: info.text } : {}),
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
  });
}

async function capture(cdp, { out, full = false, selector, padding = 0, format = "png", quality }) {
  let clip = null;
  if (selector) {
    await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        return true;
      })()`,
    );
    await sleep(250);
    const rect = await evaluate(
      cdp,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: r.left + window.scrollX,
          y: r.top + window.scrollY,
          width: r.width,
          height: r.height,
        };
      })()`,
    );
    if (!rect) throw new Error(`Cannot screenshot missing selector: ${selector}`);
    clip = {
      x: Math.max(0, rect.x - padding),
      y: Math.max(0, rect.y - padding),
      width: Math.ceil(rect.width + padding * 2),
      height: Math.ceil(rect.height + padding * 2),
      scale: 1,
    };
  } else if (full) {
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const size = metrics.cssContentSize ?? metrics.contentSize;
    clip = {
      x: 0,
      y: 0,
      width: Math.ceil(size.width),
      height: Math.ceil(size.height),
      scale: 1,
    };
  }

  const { data } = await cdp.send("Page.captureScreenshot", {
    format,
    ...(quality ? { quality } : {}),
    fromSurface: true,
    captureBeyondViewport: Boolean(clip),
    ...(clip ? { clip } : {}),
  });
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, Buffer.from(data, "base64"));
  return { path: path.resolve(out), clip };
}

async function collectAudit(cdp) {
  const data = await evaluate(
    cdp,
    `(() => {
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
      };
      const doc = document.documentElement;
      const overflow = Array.from(document.querySelectorAll('body *'))
        .filter((el) => {
          const style = getComputedStyle(el);
          if (style.position === 'fixed' || style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          return rect.right > viewport.width + 1 || rect.left < -1;
        })
        .slice(0, 25)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            className: typeof el.className === 'string' ? el.className.slice(0, 120) : undefined,
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            text: (el.textContent ?? '').trim().slice(0, 80) || undefined,
          };
        });
      return {
        title: document.title,
        url: location.href,
        viewport,
        document: {
          scrollWidth: doc.scrollWidth,
          scrollHeight: doc.scrollHeight,
          clientWidth: doc.clientWidth,
          clientHeight: doc.clientHeight,
        },
        horizontalOverflow: doc.scrollWidth > viewport.width + 1,
        overflowElements: overflow,
      };
    })()`,
  );
  return data;
}

function parseCookieString(value) {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index <= 0) return null;
      return { name: part.slice(0, index), value: part.slice(index + 1) };
    })
    .filter(Boolean);
}

async function waitForNetworkIdle(state, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (state.inflight === 0 && Date.now() - state.last > 500) return;
    await sleep(100);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const timeout = Number(args.timeout ?? 60000);
  let url = args.url ?? args._[0];
  if (!url) {
    const discovered = await discoverUrl(args, timeout);
    url = discovered.url;
    if (!args.quiet) {
      console.log(
        `Auto-detected ${discovered.url}${discovered.project?.framework ? ` (${discovered.project.framework})` : ""}`,
      );
    }
  }

  const device = args.device ? DEVICE_PRESETS[args.device] : null;
  if (args.device && !device) {
    throw new Error(
      `Unknown --device "${args.device}". Try: ${Object.keys(DEVICE_PRESETS).join(", ")}`,
    );
  }
  const viewport = args.viewport
    ? (() => {
        const match = /^(\d+)x(\d+)$/.exec(args.viewport);
        if (!match) throw new Error("--viewport must look like 1440x900");
        return { width: Number(match[1]), height: Number(match[2]) };
      })()
    : null;
  const mobile = args.mobile ?? device?.mobile ?? false;
  const width = Number(
    args.width ?? process.env.UI_PREVIEW_WIDTH ?? viewport?.width ?? device?.width ?? (mobile ? 390 : 1440),
  );
  const height = Number(
    args.height ?? process.env.UI_PREVIEW_HEIGHT ?? viewport?.height ?? device?.height ?? (mobile ? 844 : 900),
  );
  const dpr = Number(args.dpr ?? process.env.UI_PREVIEW_DPR ?? device?.dpr ?? (mobile ? 3 : 1));
  const format = args.format ?? process.env.UI_PREVIEW_FORMAT ?? "png";
  const quality = args.quality ? Number(args.quality) : undefined;
  const settleMs = Number(args.wait ?? 600);
  const out =
    args.out ??
    path.join(
      tmpdir(),
      "ui-preview",
      `ui-preview-${Date.now()}.${format === "jpeg" ? "jpg" : "png"}`,
    );
  const dark = Boolean(args.dark);
  const headers = {};
  for (const header of args.header ?? []) {
    const index = header.indexOf(":");
    if (index > 0) headers[header.slice(0, index).trim()] = header.slice(index + 1).trim();
  }
  if (process.env.UI_PREVIEW_HEADER && Object.keys(headers).length === 0) {
    const index = process.env.UI_PREVIEW_HEADER.indexOf(":");
    if (index > 0) {
      headers[process.env.UI_PREVIEW_HEADER.slice(0, index).trim()] = process.env.UI_PREVIEW_HEADER
        .slice(index + 1)
        .trim();
    }
  }
  const cookieValue = args.cookie?.join("; ") ?? process.env.UI_PREVIEW_COOKIE;

  const browser = findBrowser();
  const port = await freePort();
  const profile = await mkdtemp(path.join(tmpdir(), "ui-preview-"));
  const stderr = [];
  const child = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      "--safebrowsing-disable-auto-update",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr.push(text);
    if (stderr.length > 30) stderr.shift();
  });

  let cdp;
  const report = {
    url,
    screenshot: null,
    screenshots: [],
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    requestFailures: [],
    httpErrors: [],
    actionResults: [],
  };

  try {
    if (!args["no-wait"]) await waitForHttp(url, timeout);
    const wsUrl = await waitForCdp(port, timeout);
    cdp = new CDP(wsUrl, timeout);
    await cdp.ready;

    cdp.on("Runtime.consoleAPICalled", (event) => {
      const text = (event.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(" ");
      if (event.type === "error") report.consoleErrors.push(text);
      else if (event.type === "warning") report.consoleWarnings.push(text);
    });
    cdp.on("Runtime.exceptionThrown", (event) => {
      report.pageErrors.push(
        event.exceptionDetails?.exception?.description ??
          event.exceptionDetails?.text ??
          "Unknown page exception",
      );
    });
    cdp.on("Log.entryAdded", (event) => {
      if (event.entry?.level === "error") report.consoleErrors.push(event.entry.text);
      else if (event.entry?.level === "warning") report.consoleWarnings.push(event.entry.text);
    });
    cdp.on("Network.loadingFailed", (event) => {
      if (event.errorText !== "net::ERR_ABORTED") {
        report.requestFailures.push(`${event.errorText} ${event.requestId}`);
      }
    });
    cdp.on("Network.responseReceived", (event) => {
      if (event.response?.status >= 400) {
        report.httpErrors.push(`${event.response.status} ${event.response.url}`);
      }
    });
    cdp.on("Page.javascriptDialogOpening", () => {
      cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    });

    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Log.enable"),
      cdp.send("Network.enable"),
    ]);
    if (args["ignore-certificate-errors"]) {
      await cdp.send("Security.enable").catch(() => {});
      await cdp.send("Security.setIgnoreCertificateErrors", { ignore: true }).catch(() => {});
    }

    const networkState = { inflight: 0, last: Date.now() };
    cdp.on("Network.requestWillBeSent", () => {
      networkState.inflight += 1;
      networkState.last = Date.now();
    });
    cdp.on("Network.loadingFinished", () => {
      networkState.inflight = Math.max(0, networkState.inflight - 1);
      networkState.last = Date.now();
    });
    cdp.on("Network.loadingFailed", () => {
      networkState.inflight = Math.max(0, networkState.inflight - 1);
      networkState.last = Date.now();
    });

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: dpr,
      // Keep the layout viewport at the requested width even when the page has
      // no viewport meta tag; `mobile: true` would fall back to a 980px layout.
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: mobile,
      maxTouchPoints: mobile ? 5 : 1,
    });
    const ua = args.ua ?? device?.ua;
    if (ua || mobile) {
      await cdp.send("Emulation.setUserAgentOverride", {
        userAgent:
          ua ??
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      });
    }
    if (args.locale) await cdp.send("Emulation.setLocaleOverride", { locale: args.locale });
    if (args.timezone) await cdp.send("Emulation.setTimezoneOverride", { timezoneId: args.timezone });

    const features = [];
    if (dark) features.push({ name: "prefers-color-scheme", value: "dark" });
    if (args["reduced-motion"]) features.push({ name: "prefers-reduced-motion", value: "reduce" });
    await cdp.send("Emulation.setEmulatedMedia", {
      media: args.print ? "print" : "screen",
      features,
    });

    if (Object.keys(headers).length) {
      await cdp.send("Network.setExtraHTTPHeaders", { headers });
    }
    if (cookieValue) {
      const origin = new URL(url).origin;
      for (const cookie of parseCookieString(cookieValue)) {
        await cdp.send("Network.setCookie", {
          name: cookie.name,
          value: cookie.value,
          url: origin,
        });
      }
    }

    const loaded = cdp.once("Page.loadEventFired", timeout);
    const navigation = await cdp.send("Page.navigate", { url });
    if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
    await loaded;
    await evaluate(cdp, "document.readyState === 'complete' ? true : false").catch(() => {});
    if (args["dark-class"]) {
      await evaluate(cdp, "document.documentElement.classList.add('dark')");
    }
    if (args["disable-animations"]) {
      await evaluate(
        cdp,
        `(() => {
          const style = document.createElement('style');
          style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
          document.head.appendChild(style);
          return true;
        })()`,
      );
    }
    if (args["wait-until"] === "networkidle") {
      await waitForNetworkIdle(networkState, Math.min(timeout, 15000));
    }
    if (args["wait-for"]) await waitForSelector(cdp, args["wait-for"], timeout);
    await settle(cdp, settleMs);

    if (args.eval) {
      const value = await evaluate(cdp, args.eval, true);
      report.actionResults.push({ type: "eval", value });
    }

    const actions = [];
    const actionFile = args.actions ?? args.script;
    if (actionFile) {
      const parsed = JSON.parse(await readFile(actionFile, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("--actions file must contain a JSON array");
      actions.push(...parsed);
    }
    for (const raw of args.action ?? []) actions.push(JSON.parse(raw));

    for (const selector of args.click ?? []) actions.push({ type: "click", selector });
    if (args["type-into"]) actions.push({ type: "focus", selector: args["type-into"] });
    if (args.type != null) actions.push({ type: "type", text: args.type });
    if (args.press) actions.push({ type: "press", key: args.press });

    for (const action of actions) {
      switch (action.type) {
        case "wait":
          await sleep(Number(action.ms ?? 500));
          report.actionResults.push({ type: "wait", ms: Number(action.ms ?? 500) });
          break;
        case "waitFor":
          await waitForSelector(cdp, action.selector, Number(action.timeout ?? timeout));
          report.actionResults.push({ type: "waitFor", selector: action.selector });
          break;
        case "click":
          await clickSelector(cdp, action.selector);
          report.actionResults.push({ type: "click", selector: action.selector });
          break;
        case "focus":
          await evaluate(
            cdp,
            `(() => { const el = document.querySelector(${JSON.stringify(action.selector)}); if (!el) return false; el.focus(); return true; })()`,
          );
          report.actionResults.push({ type: "focus", selector: action.selector });
          break;
        case "type":
          await cdp.send("Input.insertText", { text: String(action.text ?? "") });
          report.actionResults.push({ type: "type", length: String(action.text ?? "").length });
          break;
        case "press":
          await pressKey(cdp, String(action.key));
          report.actionResults.push({ type: "press", key: action.key });
          break;
        case "scrollTo":
          await evaluate(
            cdp,
            `(() => { const el = document.querySelector(${JSON.stringify(action.selector)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`,
          );
          await sleep(250);
          report.actionResults.push({ type: "scrollTo", selector: action.selector });
          break;
        case "eval": {
          const value = await evaluate(cdp, action.expression, true);
          report.actionResults.push({ type: "eval", value });
          break;
        }
        case "reload":
          await cdp.send("Page.reload", { ignoreCache: Boolean(action.ignoreCache) });
          await cdp.once("Page.loadEventFired", timeout);
          await settle(cdp, settleMs);
          report.actionResults.push({ type: "reload" });
          break;
        case "screenshot": {
          const shot = await capture(cdp, {
            out:
              action.out ??
              path.join(
                tmpdir(),
                "ui-preview",
                `ui-preview-${Date.now()}.${(action.format ?? format) === "jpeg" ? "jpg" : "png"}`,
              ),
            full: Boolean(action.full),
            selector: action.selector,
            padding: Number(action.padding ?? 0),
            format: action.format ?? format,
            quality: action.quality ?? quality,
          });
          report.screenshots.push(shot);
          break;
        }
        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }
    }

    if (!args["no-final"]) {
      const shot = await capture(cdp, {
        out,
        full: Boolean(args.full),
        selector: args.selector,
        padding: Number(args.padding ?? 0),
        format,
        quality,
      });
      report.screenshot = shot.path;
      report.screenshots.push(shot);
    }

    const audit = await collectAudit(cdp);
    Object.assign(report, audit);
  } finally {
    cdp?.close();
    child.kill("SIGTERM");
    await sleep(250);
    if (!child.killed) child.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const failures =
    report.consoleErrors.length +
    report.pageErrors.length +
    report.requestFailures.length +
    report.httpErrors.length;
  if (args["fail-on-error"] && (failures > 0 || report.horizontalOverflow)) {
    process.exitCode = 1;
  }

  if (args["json-out"]) {
    await writeFile(args["json-out"], `${JSON.stringify(report, null, 2)}\n`);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (!args.quiet) {
    console.log(`UI preview: ${report.url}`);
    console.log(`Screenshot: ${report.screenshot ?? "(none)"}`);
    console.log(
      `Viewport: ${report.viewport?.width}x${report.viewport?.height} @${report.viewport?.dpr}x · document ${report.document?.scrollWidth}x${report.document?.scrollHeight}`,
    );
    if (report.horizontalOverflow) console.log("⚠ Horizontal overflow detected");
    if (report.overflowElements?.length) {
      console.log("Overflow candidates:");
      for (const el of report.overflowElements.slice(0, 8)) {
        console.log(`  <${el.tag}> ${el.id ? `#${el.id}` : ""}${el.className ? `.${el.className.split(/\s+/).join(".")}` : ""} right=${el.right}`);
      }
    }
    if (report.consoleErrors.length) {
      console.log(`Console errors (${report.consoleErrors.length}):`);
      for (const error of report.consoleErrors.slice(0, 5)) console.log(`  ${error}`);
    }
    if (report.pageErrors.length) {
      console.log(`Page errors (${report.pageErrors.length}):`);
      for (const error of report.pageErrors.slice(0, 5)) console.log(`  ${error}`);
    }
    if (report.httpErrors.length) {
      console.log(`HTTP errors (${report.httpErrors.length}):`);
      for (const error of report.httpErrors.slice(0, 5)) console.log(`  ${error}`);
    }
    if (report.requestFailures.length) {
      console.log(`Request failures (${report.requestFailures.length}):`);
      for (const error of report.requestFailures.slice(0, 5)) console.log(`  ${error}`);
    }
    if (process.exitCode) console.log("Result: FAIL (--fail-on-error)");
  } else {
    console.log(report.screenshot ?? "");
  }
}

main().catch((error) => {
  console.error(`ui-preview failed: ${error.message}`);
  process.exitCode = 1;
});
