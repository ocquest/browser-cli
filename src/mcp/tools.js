const state = require('../daemon/services/state');
const hyprctl = require('../daemon/services/hyprctl');
const ydotool = require('../daemon/services/ydotool');
const util = require('util');
const execAsync = util.promisify(require('child_process').exec);
const llm = require('../../lib/llm');
const profiles = require('./profiles');

let _browser;

const z = require('zod').z;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function enrich(page, data) {
  try {
    const url = (page && page.url()) || (data && data.url);
    if (url) {
      data.url = url;
      const domain = profiles.getDomainFromUrl(url);
      const tools = profiles.loadTools(domain);
      data.profiles = tools.map(t => ({ name: t.name, description: t.description, inputs: t.inputs }));
    } else {
      data.profiles = [];
    }
  } catch {
    data.profiles = [];
  }
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

async function captureDiff() {
  const page = _browser.getActivePage();
  if (!page) return null;
  const before = await _browser.captureInteractiveState(page).catch(() => null);
  return {
    before,
    async after() {
      const a = await _browser.captureInteractiveState(page).catch(() => null);
      return _browser.diffInteractiveState(before, a);
    }
  };
}

async function execChainSteps(page, stepsStr) {
  const parsedSteps = stepsStr.split('|').map(s => s.trim()).filter(Boolean).map(s => {
    const parts = s.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const action = parts[0];
    const rawArgs = parts.slice(1).map(a => a.replace(/^"(.*)"$/, '$1'));
    const flags = {};
    const args = rawArgs.filter(a => {
      if (a === '--submit') { flags.submit = true; return false; }
      if (a === '--precise') { flags.precise = true; return false; }
      if (a.startsWith('--')) return false;
      return true;
    });
    if (action === 'observe') {
      if (rawArgs.includes('minimal') || rawArgs.includes('--minimal')) flags.mode = 'minimal';
      if (rawArgs.includes('full') || rawArgs.includes('--full')) flags.mode = 'full';
    }
    return { action, args, flags };
  });
  const results = [];
  for (const step of parsedSteps) {
    const { action, args, flags } = step;
    const entry = { action, args: [...args], flags };
    try {
      switch (action) {
        case 'goto': await page.goto(args[0], { timeout: 30000 }); break;
        case 'fill': {
          const { element } = await _browser.findElement(args[0]);
          await element.fill(args.slice(1).join(' '));
          if (flags.submit) await page.keyboard.press('Enter');
          break;
        }
        case 'press': await page.keyboard.press(args[0]); entry.key = args[0]; break;
        case 'click': {
          const { element } = await _browser.findElement(args[0]);
          await element.click();
          break;
        }
        case 'yclick':
          await _browser.ensureClickable(args[0]);
          const ypos = await _browser.getElementScreenPos(args[0]);
          await hyprctl.focusBrowserWindow();
          await sleep(50);
          await ydotool.naturalMouseMove(ypos.screenX, ypos.screenY, hyprctl.getCursorPos);
          await sleep(60 + Math.round(Math.random() * 30));
          await execAsync('ydotool click C0');
          entry.x = ypos.screenX; entry.y = ypos.screenY;
          break;
        case 'type': {
          const { element } = await _browser.findElement(args[0]);
          await element.evaluate(el => { el.value = ''; el.focus(); });
          const typeText = args.slice(1).join(' ');
          if (flags.precise) { for (const ch of typeText) { await page.keyboard.type(ch); await sleep(10 + Math.random() * 20); } }
          else { await _browser.humanType(page, args[0], typeText); }
          if (flags.submit) await page.keyboard.press('Enter');
          break;
        }
        case 'eval': entry.result = String(await page.evaluate(args.join(' '))).substring(0, 500); break;
        case 'wait':
          if (args[0] === 'networkidle') await page.waitForLoadState('networkidle', { timeout: 30000 });
          else if (args[0] === 'stable') await _browser.waitForStableDOM(5000);
          else if (args[0] === 'selector' && args[1]) await page.waitForSelector(args[1], { timeout: 30000 });
          else await sleep(parseInt(args[0]) || 1000);
          break;
        case 'observe': entry.observe = await _browser.observe(page, { mode: flags.mode || 'normal' }); break;
        case 'screenshot': entry.screenshotBase64 = (await page.screenshot({ type: 'png' })).toString('base64'); break;
        case 'scrollIntoView': { const { element } = await _browser.findElement(args[0]); if (element) await element.scrollIntoViewIfNeeded(); } break;
        case 'scrollTo': await page.evaluate((pct) => window.scrollTo(0, document.body.scrollHeight * parseInt(pct) / 100), args[0]); break;
        case 'scrollNext': await page.evaluate(() => window.scrollBy(0, window.innerHeight)); break;
        case 'scrollPrev': await page.evaluate(() => window.scrollBy(0, -window.innerHeight)); break;
        case 'ydrag':
          const dFromPos = await _browser.getElementScreenPos(args[0]);
          const dToPos = await _browser.getElementScreenPos(args[1]);
          await hyprctl.focusBrowserWindow();
          await sleep(50);
          await ydotool.naturalMouseMove(dFromPos.screenX, dFromPos.screenY, hyprctl.getCursorPos);
          await sleep(80);
          await execAsync('ydotool click 0x40');
          await sleep(120);
          await ydotool.naturalMouseMove(dToPos.screenX, dToPos.screenY, hyprctl.getCursorPos);
          await sleep(80);
          await execAsync('ydotool click 0x80');
          entry.fromX = dFromPos.screenX; entry.fromY = dFromPos.screenY;
          entry.toX = dToPos.screenX; entry.toY = dToPos.screenY;
          break;
        default: throw new Error('Unknown action: ' + action);
      }
    } catch (e) {
      entry.error = e.message;
    }
    results.push(entry);
  }
  return results;
}

const CALIBRATION_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>br calibration</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: monospace; user-select: none; }
  .grid { display: grid; grid-template-columns: repeat(5, 80px); gap: 6px; }
  .cell { width: 80px; height: 80px; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: bold; color: #fff; border: 3px solid rgba(255,255,255,0.5); border-radius: 8px; cursor: pointer; transition: transform 0.1s; }
  .cell.hit { border-color: #fff; box-shadow: 0 0 20px rgba(255,255,255,0.6); transform: scale(1.1); }
  #status { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); color: #aaa; font-size: 14px; text-align: center; }
</style>
</head>
<body>
<div class="grid" id="grid"></div>
<div id="status">Calibration grid ready</div>
<script>
  const colors = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#3498db','#9b59b6','#1abc9c','#e84393','#6c5ce7','#00b894','#fd79a8','#0984e3','#fdcb6e','#e17055','#00cec9','#d63031','#636e72','#b2bec3','#dfe6e9','#55efc4','#81ecec','#ff7675','#74b9ff','#a29bfe','#ffeaa7'];
  let idx = 0;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const div = document.createElement('div');
      div.className = 'cell';
      div.id = 'cell-' + r + '-' + c;
      div.style.background = colors[idx++];
      div.textContent = r + ',' + c;
      div.addEventListener('click', function handler() {
        document.querySelectorAll('.cell.hit').forEach(el => el.classList.remove('hit'));
        this.classList.add('hit');
        document.getElementById('status').textContent = 'Hit: cell (' + r + ',' + c + ') at ' + new Date().toLocaleTimeString();
        window.__brCalibrationHit = { row: r, col: c };
      });
      document.getElementById('grid').appendChild(div);
    }
  }
</script>
</body>
</html>`;

function register(server, browser) {
  _browser = browser;

  // ── Navigation ──────────────────────────────────────────
  server.registerTool(
    'browser_navigate',
    {
      description: 'Navigate the browser to a URL. Returns URL, title, viewport info, and "changed" diff. For SPAs (Mercadona, React apps), prefer using browser_fill on the search box with --submit instead of navigating to URLs.',
      inputSchema: z.object({ url: z.string().describe('The URL to navigate to') })
    },
    async ({ url }) => {
      const diff = await captureDiff();
      const page = browser.getActivePage();
      if (!page) throw new Error('No active page');
      await page.goto(url, { timeout: 30000 });
      state.record('navigate', { url });
      const info = await browser.getPageInfo(page);
      const changed = await diff.after();
      return enrich(page, { ...info, changed });
    }
  );

  server.registerTool(
    'browser_go_back',
    {
      description: 'Navigate back in browser history',
      inputSchema: z.object({})
    },
    async () => {
      const diff = await captureDiff();
      const page = browser.getActivePage();
      await page.goBack();
      state.record('go-back');
      const changed = await diff.after();
      return enrich(page, { ok: true, action: 'go-back', changed });
    }
  );

  server.registerTool(
    'browser_go_forward',
    {
      description: 'Navigate forward in browser history',
      inputSchema: z.object({})
    },
    async () => {
      const diff = await captureDiff();
      const page = browser.getActivePage();
      await page.goForward();
      state.record('go-forward');
      const changed = await diff.after();
      return enrich(page, { ok: true, action: 'go-forward', changed });
    }
  );

  server.registerTool(
    'browser_reload',
    {
      description: 'Reload the current page',
      inputSchema: z.object({})
    },
    async () => {
      const diff = await captureDiff();
      const page = browser.getActivePage();
      await page.reload();
      state.record('reload');
      const changed = await diff.after();
      return enrich(page, { ok: true, action: 'reload', changed });
    }
  );

  // ── Clicks ──────────────────────────────────────────────
  server.registerTool(
    'browser_click',
    {
      description: 'PREFERRED click method — uses ydotool (system-level mouse, undetectable by anti-bot). Accepts numeric IDs (from observe/view_tree) or CSS selectors. Returns "changed" with added/removed elements. If error "element covered" or "covered by", use browser_press("Escape") first to dismiss modals. If error "Browser window not found", use browser_click_pw instead (Playwright fallback, works without visible window). Set wait_until="networkidle" for clicks that navigate to a new page.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector or numeric element ID'),
        wait_until: z.enum(['none', 'networkidle']).optional().default('none').describe('If "networkidle", waits for page to finish loading after click')
      })
    },
    async ({ selector, wait_until }) => {
      const diff = await captureDiff();
      await browser.ensureClickable(selector);
      const pos = await browser.getElementScreenPos(selector);
      await hyprctl.focusBrowserWindow();
      await sleep(50);
      await ydotool.naturalMouseMove(pos.screenX, pos.screenY, hyprctl.getCursorPos);
      await sleep(60 + Math.round(Math.random() * 30));
      await execAsync('ydotool click C0');
      const clickPage = browser.getActivePage();
      if (wait_until === 'networkidle') {
        await clickPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      }
      state.record('yclick', { selector, x: pos.screenX, y: pos.screenY });
      const changed = await diff.after();
      return enrich(clickPage, { ok: true, x: pos.screenX, y: pos.screenY, changed });
    }
  );

  server.registerTool(
    'browser_click_at',
    {
      description: 'Click at absolute screen pixel coordinates using ydotool (system-level, undetectable). Use when elements are inside cross-origin iframes (e.g. reCAPTCHA) where CSS selectors cannot reach. Get coordinates via browser_evaluate + getBoundingClientRect().',
      inputSchema: z.object({
        x: z.number().describe('Absolute screen X coordinate'),
        y: z.number().describe('Absolute screen Y coordinate'),
        wait_until: z.enum(['none', 'networkidle']).optional().default('none').describe('If "networkidle", waits for page to finish loading after click')
      })
    },
    async ({ x, y, wait_until }) => {
      const diff = await captureDiff();
      await hyprctl.focusBrowserWindow();
      await sleep(50);
      await ydotool.naturalMouseMove(x, y, hyprctl.getCursorPos);
      await sleep(60 + Math.round(Math.random() * 30));
      await execAsync('ydotool click C0');
      const clickPage = browser.getActivePage();
      if (wait_until === 'networkidle') {
        await clickPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      }
      state.record('yclick-at', { x, y });
      const changed = await diff.after();
      return enrich(clickPage, { ok: true, x, y, changed });
    }
  );

  server.registerTool(
    'browser_click_pw',
    {
      description: 'FALLBACK click — uses Playwright (detectable by anti-bot, but works without visible browser window). Use when browser_click fails with "Chrome window not found". Accepts numeric IDs or CSS selectors. Returns "changed" with added/removed elements. Set wait_until="networkidle" for navigation clicks.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector or numeric element ID'),
        wait_until: z.enum(['none', 'networkidle']).optional().default('none').describe('If "networkidle", waits for page to finish loading after click')
      })
    },
    async ({ selector, wait_until }) => {
      const diff = await captureDiff();
      const page = browser.getActivePage();
      const modals = await browser.detectModals(page);
      if (modals.length) await browser.autoDismissBlockers(page);
      const { element } = await browser.findElement(selector);
      if (!element) throw new Error('Element not found: ' + selector);
      await element.click();
      if (wait_until === 'networkidle') {
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      }
      state.record('click', { selector });
      const changed = await diff.after();
      return enrich(page, { ok: true, changed });
    }
  );

  server.registerTool(
    'browser_drag',
    {
      description: 'Drag and drop using ydotool (system-level mouse, undetectable). Provide source and target as numeric IDs or selectors. Uses natural mouse movement. Returns "changed" diff.',
      inputSchema: z.object({
        from: z.string().describe('CSS selector or numeric ID of the element to drag'),
        to: z.string().describe('CSS selector or numeric ID of the drop target')
      })
    },
    async ({ from, to }) => {
      const diff = await captureDiff();
      const fromPos = await browser.getElementScreenPos(from);
      const toPos = await browser.getElementScreenPos(to);
      await hyprctl.focusBrowserWindow();
      await sleep(50);
      await ydotool.naturalMouseMove(fromPos.screenX, fromPos.screenY, hyprctl.getCursorPos);
      await sleep(80);
      await execAsync('ydotool click 0x40');
      await sleep(120);
      await ydotool.naturalMouseMove(toPos.screenX, toPos.screenY, hyprctl.getCursorPos);
      await sleep(80);
      await execAsync('ydotool click 0x80');
      state.record('ydrag', { from, to });
      const changed = await diff.after();
      return enrich(browser.getActivePage(), { ok: true, changed });
    }
  );

  // ── Forms ───────────────────────────────────────────────
  server.registerTool(
    'browser_fill',
    {
      description: 'Fill a form field (fast, detectable). USE THIS for search boxes, text inputs, textareas. Accepts numeric IDs or CSS selectors. Set submit=true to type+Enter in one call (essential for search bars). For password/sensitive fields use browser_type (human-like). Returns "changed" diff. Pattern: fill(4, "cebolla", submit:true) → search results load.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector or numeric element ID of the input/textarea'),
        text: z.string().describe('Text to fill'),
        submit: z.boolean().optional().default(false).describe('If true, presses Enter after filling (useful for search boxes)')
      })
    },
    async ({ selector, text, submit }) => {
      const diff = await captureDiff();
      const page = browser.getActivePage();
      const modals = await browser.detectModals(page);
      if (modals.length) await browser.autoDismissBlockers(page);
      const { element } = await browser.findElement(selector);
      if (!element) throw new Error('Element not found: ' + selector);
      await element.fill(text);
      if (submit) await page.keyboard.press('Enter');
      state.record('fill', { selector, submit: !!submit });
      const changed = await diff.after();
      return enrich(page, { ok: true, submit, changed });
    }
  );

  server.registerTool(
    'browser_fill_secret',
    {
      description: 'Fill a form field with a secret value. The value is masked in all HTML outputs.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector of the input'),
        secret: z.string().describe('The secret value to fill')
      })
    },
    async ({ selector, secret }) => {
      const diff = await captureDiff();
      const page = browser.getActivePage();
      await page.fill(selector, secret);
      state.addSecret(secret);
      state.record('fill-secret', { selector });
      const changed = await diff.after();
      return enrich(page, { ok: true, changed });
    }
  );

  server.registerTool(
    'browser_type',
    {
      description: 'Human-like typing (typos, bursts, pauses). SLOWER but undetectable. Use for passwords, sensitive fields, or when bot detection is aggressive. For fast input (search bars, forms) use browser_fill instead. Accepts numeric IDs or CSS selectors. Set submit=true for type+Enter. Returns "changed" diff.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector or numeric element ID of the input'),
        text: z.string().describe('Text to type'),
        precise: z.boolean().optional().describe('If true, type without human-like errors'),
        submit: z.boolean().optional().default(false).describe('If true, presses Enter after typing')
      })
    },
    async ({ selector, text, precise, submit }) => {
      const diff = await captureDiff();
      const page = browser.getActivePage();
      const { element } = await browser.findElement(selector);
      if (!element) throw new Error('Element not found: ' + selector);
      await element.evaluate(el => { el.value = ''; el.focus(); });
      if (precise) {
        for (const ch of text) {
          await page.keyboard.type(ch);
          await sleep(browser.randInt(10, 30));
        }
      } else {
        await browser.humanType(page, selector, text);
      }
      if (submit) await page.keyboard.press('Enter');
      state.record('type', { selector, precise: !!precise, submit: !!submit });
      const changed = await diff.after();
      return enrich(page, { ok: true, changed });
    }
  );

  server.registerTool(
    'browser_press',
    {
      description: 'Press a keyboard key. KEY PATTERNS: Escape → dismiss modals/overlays (use before every click if modals may be present). Enter → submit forms. Tab → move focus. ArrowDown/ArrowUp → navigate dropdowns. Returns "changed" diff.',
      inputSchema: z.object({
        key: z.string().describe('Key to press (e.g., Enter, Tab, Escape, ArrowDown)')
      })
    },
    async ({ key }) => {
      const diff = await captureDiff();
      const page = browser.getActivePage();
      const modals = await browser.detectModals(page);
      if (modals.length) await browser.autoDismissBlockers(page);
      await page.keyboard.press(key);
      state.record('press', { key });
      const changed = await diff.after();
      return enrich(page, { ok: true, key, changed });
    }
  );

  server.registerTool(
    'browser_select',
    {
      description: 'Select an option in a dropdown. Works with <select> elements and custom dropdowns. Accepts numeric IDs or CSS selectors. For custom dropdowns, clicks the element then finds the option by text. Returns "changed" diff.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector or numeric element ID of the select element'),
        value: z.string().describe('Value or label of the option to select')
      })
    },
    async ({ selector, value }) => {
      const diff = await captureDiff();
      const page = browser.getActivePage();
      const { element } = await browser.findElement(selector);
      if (!element) throw new Error('Element not found: ' + selector);
      const tag = await element.evaluate(el => el.tagName.toLowerCase());
      if (tag === 'select') {
        await element.selectOption(value);
      } else {
        await element.click();
        await sleep(300);
        const opt = await page.$(`option[value="${value}"], option:has-text("${value}")`);
        if (opt) await opt.click();
        else throw new Error('Option not found: ' + value);
      }
      state.record('select', { selector, value });
      const changed = await diff.after();
      return enrich(page, { ok: true, changed });
    }
  );

  // ── Observation ─────────────────────────────────────────
  server.registerTool(
    'browser_observe',
    {
      description: 'OBSERVE the page — returns URL, title, interactive elements (with numeric IDs), visible text, and modals. MODES: "normal" (default, 20K chars), "minimal" (only headings+buttons+links, ~500 chars, TOKEN-SAVING), "full" (unlimited text). TOKEN TIP: Use mode:"minimal" for large pages (Mercadona, Amazon) — you still get all interactive element IDs for clicking. Use maxChars to cap text length. Elements have numeric IDs — use these for click/fill/type. AFTER any action, check the "changed" field in the response instead of calling observe again.',
      inputSchema: z.object({
        mode: z.enum(['normal', 'minimal', 'full']).optional().default('normal').describe('"minimal" for low-token snapshot (headings+buttons+links only), "normal" for default (up to maxChars), "full" for all text'),
        maxChars: z.number().optional().default(20000).describe('Maximum characters of text to return (default 20000, only used in normal mode)'),
        maxInteractive: z.number().optional().default(400).describe('Maximum interactive elements to return (default 400)')
      })
    },
    async ({ mode, maxChars, maxInteractive }) => {
      const page = browser.getActivePage();
      const result = await browser.observe(page, { mode, maxChars, maxInteractive });
      state.record('observe', { mode });
      return enrich(page, result);
    }
  );

  server.registerTool(
    'browser_view_tree',
    {
      description: 'Get the DOM tree with numeric IDs and CSS selectors (e.g., button[aria-label="Add to cart"]). TOKEN TIP: Use section="#container" to scope to a specific area (e.g., "#product-grid"). Default max_depth=5 — set max_depth=3 for overview, max_depth=10 for full detail. Nodes include css="..." with real selectors (aria-label, data-testid, class-based). Use when browser_observe does not show enough interactive elements.',
      inputSchema: z.object({
        role: z.string().optional().describe('Filter by ARIA role (e.g., "button,link")'),
        tag: z.string().optional().describe('Filter by tag name (e.g., "button,input,a")'),
        match: z.string().optional().describe('Filter by text content match'),
        max_depth: z.number().optional().describe('Maximum tree depth (default 5)'),
        section: z.string().optional().describe('CSS selector to scope the tree to a specific container (e.g. "#product-grid", ".main")'),
        only_matches: z.boolean().optional().describe('Only show nodes matching filters')
      })
    },
    async ({ role, tag, match, max_depth, section, only_matches }) => {
      const page = browser.getActivePage();
      const treeText = await browser.viewTree(page, { role, tag, match, maxDepth: max_depth, section, onlyMatches: only_matches });
      state.record('view-tree', { role, tag, match, maxDepth: max_depth, section });
      return enrich(page, { tree: treeText });
    }
  );

  server.registerTool(
    'browser_screenshot',
    {
      description: 'Take a full page screenshot. Returns a base64-encoded PNG.',
      inputSchema: z.object({})
    },
    async () => {
      const page = browser.getActivePage();
      const buffer = await page.screenshot({ type: 'png' });
      state.record('screenshot');
      return {
        content: [{
          type: 'resource',
          resource: {
            uri: 'screenshot://current',
            mimeType: 'image/png',
            blob: buffer.toString('base64')
          }
        }]
      };
    }
  );

  server.registerTool(
    'browser_screenshot_element',
    {
      description: 'Take a screenshot of a specific element with optional margin.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector or numeric ID of the element'),
        margin: z.number().optional().default(10).describe('Margin in pixels around the element (default: 10)')
      })
    },
    async ({ selector, margin }) => {
      const page = browser.getActivePage();
      const { element } = await browser.findElement(selector);
      if (!element) throw new Error('Element not found');
      const box = await element.boundingBox();
      if (!box) throw new Error('Element not visible');
      const clip = {
        x: Math.max(0, box.x - margin),
        y: Math.max(0, box.y - margin),
        width: box.width + 2 * margin,
        height: box.height + 2 * margin
      };
      const buffer = await page.screenshot({ clip, type: 'png' });
      state.record('screenshot-element', { selector, margin });
      return {
        content: [{
          type: 'resource',
          resource: {
            uri: 'screenshot://element',
            mimeType: 'image/png',
            blob: buffer.toString('base64')
          }
        }]
      };
    }
  );

  server.registerTool(
    'browser_get_html',
    {
      description: 'Get the full HTML source of the current page.',
      inputSchema: z.object({})
    },
    async () => {
      const page = browser.getActivePage();
      const html = await page.content();
      state.record('get-html');
      return { content: [{ type: 'text', text: html }] };
    }
  );

  server.registerTool(
    'browser_get_page_status',
    {
      description: 'Get current page status: URL, title, scroll position, and detected modals.',
      inputSchema: z.object({})
    },
    async () => {
      const page = browser.getActivePage();
      const info = await browser.getPageInfo(page);
      return enrich(page, info);
    }
  );

  // ── Advanced Observation ────────────────────────────────
  server.registerTool(
    'browser_snapshot',
    {
      description: 'Extract structured DATA from a container (grid, list, table, product listings). Pass a CSS selector for the container (e.g., "#product-grid", ".product-list", "main"). Returns array of items with text, href, tag, and classes. Use when you need product names, prices, or links from a listing. For best results, combine with browser_view_tree(section:"#container") first to find the right container selector.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector of the container element (e.g. "#product-grid", ".product-list")')
      })
    },
    async ({ selector }) => {
      const page = browser.getActivePage();
      const result = await browser.snapshot(page, selector);
      state.record('snapshot', { selector, count: result.itemCount });
      return enrich(page, result);
    }
  );

  server.registerTool(
    'browser_diff',
    {
      description: 'DIFF — compare current page with last browser_observe snapshot. Returns URL changes, new/removed interactive elements. USE INSTEAD of a full observe() when you just need to check if something changed. Example: after click, call diff() to confirm a modal appeared or the URL changed. First call browser_observe() to set a baseline.',
      inputSchema: z.object({})
    },
    async () => {
      const result = await browser.diff();
      state.record('diff');
      return enrich(browser.getActivePage(), { changes: result.changes });
    }
  );

  // ── Site Profiles ─────────────────────────────────────────
  function replacePlaceholders(template, inputs) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => inputs[key] !== undefined ? String(inputs[key]) : '{{' + key + '}}');
  }

  server.registerTool(
    'browser_profile_create',
    {
      description: 'Create a reusable custom tool for a specific website. Define steps (pipe-delimited chain commands) with {{input_name}} placeholders. Steps run in sequence via browser_chain. Stored per domain in ~/.config/browser-cli/profiles/.',
      inputSchema: z.object({
        domain: z.string().describe('Domain or URL (e.g., "mercadona.es" or "https://mercadona.es")'),
        name: z.string().describe('Tool name (e.g., "add-to-cart", "search-product")'),
        description: z.string().describe('Description the AI will see when using this tool'),
        steps: z.string().describe('Pipe-delimited chain steps. Use {{input}} for variables. E.g.: "click {{product}} | press Escape | click 7 | press Escape"'),
        inputs: z.array(z.object({
          name: z.string().describe('Input variable name (without {{}} )'),
          type: z.string().optional().default('string').describe('Type hint: string, number, boolean'),
          description: z.string().optional().describe('Description of this input')
        })).optional().default([]).describe('List of input variables used in steps')
      })
    },
    async ({ domain, name, description, steps, inputs }) => {
      const domainKey = profiles.getDomainFromUrl(domain);
      const tools = profiles.loadTools(domainKey);
      if (tools.some(t => t.name === name)) throw new Error(`Tool "${name}" already exists for ${domainKey}. Use browser_profile_edit to modify it.`);
      tools.push({ name, description, steps, inputs, created: new Date().toISOString() });
      profiles.saveTools(domainKey, tools);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, domain: domainKey, name, toolCount: tools.length }) }] };
    }
  );

  server.registerTool(
    'browser_profile_list',
    {
      description: 'List custom tools defined for the current page domain (or a specific domain). Each tool shows name, description, inputs, and steps.',
      inputSchema: z.object({
        domain: z.string().optional().describe('Domain to list tools for. Omit to auto-detect from current page URL.')
      })
    },
    async ({ domain }) => {
      const page = _browser.getActivePage();
      const targetDomain = domain ? profiles.getDomainFromUrl(domain) : (page ? profiles.getDomainFromUrl(page.url()) : '');
      if (!targetDomain) throw new Error('No domain specified and no active page to detect domain');
      const tools = profiles.loadTools(targetDomain);
      const allDomains = profiles.listDomains();
      return {
        content: [{ type: 'text', text: JSON.stringify({
          domain: targetDomain,
          toolCount: tools.length,
          tools: tools.map(t => ({ name: t.name, description: t.description, inputs: t.inputs, steps: t.steps })),
          allDomains
        }) }]
      };
    }
  );

  server.registerTool(
    'browser_profile_edit',
    {
      description: 'Edit a custom tool for a domain: rename, change steps, update description, or modify inputs. Specify which field to change.',
      inputSchema: z.object({
        domain: z.string().describe('Domain or URL'),
        name: z.string().describe('Current tool name'),
        field: z.enum(['name', 'description', 'steps', 'inputs']).describe('Field to edit: name, description, steps, or inputs'),
        value: z.any().describe('New value for the field')
      })
    },
    async ({ domain, name, field, value }) => {
      const domainKey = profiles.getDomainFromUrl(domain);
      const tools = profiles.loadTools(domainKey);
      const idx = tools.findIndex(t => t.name === name);
      if (idx === -1) throw new Error(`Tool "${name}" not found for ${domainKey}`);
      if (field === 'inputs') {
        tools[idx].inputs = value;
      } else {
        tools[idx][field] = String(value);
      }
      profiles.saveTools(domainKey, tools);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, domain: domainKey, name, field, toolCount: tools.length }) }] };
    }
  );

  server.registerTool(
    'browser_profile_delete',
    {
      description: 'Delete a custom tool from a domain profile.',
      inputSchema: z.object({
        domain: z.string().describe('Domain or URL'),
        name: z.string().describe('Tool name to delete')
      })
    },
    async ({ domain, name }) => {
      const domainKey = profiles.getDomainFromUrl(domain);
      const tools = profiles.loadTools(domainKey);
      const idx = tools.findIndex(t => t.name === name);
      if (idx === -1) throw new Error(`Tool "${name}" not found for ${domainKey}`);
      tools.splice(idx, 1);
      profiles.saveTools(domainKey, tools);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, domain: domainKey, deleted: name, toolCount: tools.length }) }] };
    }
  );

  server.registerTool(
    'browser_profile_run',
    {
      description: 'Execute a custom tool defined via browser_profile_create for the current domain. Replaces {{inputs}} and runs the chain steps. Returns the observe result after execution.',
      inputSchema: z.object({
        name: z.string().describe('Tool name to run (e.g., "add-to-cart")'),
        domain: z.string().optional().describe('Domain or URL. Omit to auto-detect from current page.'),
        inputs: z.record(z.string(), z.string()).optional().default({}).describe('Input values to replace {{placeholders}} in steps. E.g.: {"product":"15", "quantity":"2"}')
      })
    },
    async ({ name, domain, inputs }) => {
      const page = _browser.getActivePage();
      if (!page) throw new Error('No active page');
      const targetDomain = domain ? profiles.getDomainFromUrl(domain) : profiles.getDomainFromUrl(page.url());
      const tools = profiles.loadTools(targetDomain);
      const tool = tools.find(t => t.name === name);
      if (!tool) throw new Error(`Tool "${name}" not found for ${targetDomain}. Use browser_profile_list to see available tools.`);
      let steps = tool.steps;
      for (const [key, val] of Object.entries(inputs || {})) {
        steps = steps.replace(new RegExp('\\{\\{' + key + '\\}\\}', 'g'), String(val));
      }
      const pageBefore = await _browser.captureInteractiveState(page).catch(() => null);
      const chainResult = await execChainSteps(page, steps);
      const pageAfter = await _browser.captureInteractiveState(page).catch(() => null);
      const changed = _browser.diffInteractiveState(pageBefore, pageAfter);
      return enrich(page, { ok: true, domain: targetDomain, tool: name, changed, steps: chainResult });
    }
  );

  server.registerTool(
    'browser_wait_for',
    {
      description: 'Wait for a specific element to appear. Accepts numeric IDs or CSS selectors. Polls every 200ms until found or timeout. Use after navigation or actions that trigger async content loading. For complex waits (multiple conditions), use browser_wait_for_any instead.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector or numeric element ID to wait for'),
        timeout: z.number().optional().default(30000).describe('Maximum time to wait in ms (default 30000)')
      })
    },
    async ({ selector, timeout }) => {
      await browser.waitForElement(selector, timeout);
      state.record('wait-for', { selector, timeout });
      return enrich(browser.getActivePage(), { ok: true, action: 'wait-for', selector });
    }
  );

  server.registerTool(
    'browser_wait_for_any',
    {
      description: 'SMART WAIT — wait until ANY condition triggers. Conditions: selector (CSS element appears), url_match (URL includes text), text (page text found), modal (modal with text), removed (element disappears). Returns which condition won. USE AFTER uncertain actions: "did a modal appear or did the page navigate?" Pass multiple conditions and the first one met wins. Example: [{type:"text",arg:"Añadido"},{type:"modal",arg:"error"},{type:"url_match",arg:"/cart"}]',
      inputSchema: z.object({
        conditions: z.array(z.object({
          type: z.enum(['selector', 'url_match', 'text', 'modal', 'removed']).describe('Type of condition to check'),
          arg: z.string().describe('Argument: CSS selector, URL substring, text to find, modal text, or element to wait for removal')
        })).describe('Array of conditions. First one met wins.'),
        timeout: z.number().optional().default(10000).describe('Timeout in ms (default 10000)')
      })
    },
    async ({ conditions, timeout }) => {
      const result = await browser.waitForAny(conditions, timeout);
      state.record('wait-for-any', { count: conditions.length, result: result.type });
      return enrich(browser.getActivePage(), result);
    }
  );

  server.registerTool(
    'browser_hover',
    {
      description: 'Hover over an element. Useful for triggering dropdown menus, tooltips, or hover effects. Accepts numeric IDs or CSS selectors.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector or numeric element ID to hover over')
      })
    },
    async ({ selector }) => {
      await browser.hover(selector);
      state.record('hover', { selector });
      return enrich(browser.getActivePage(), { ok: true });
    }
  );

  // ── Text Search ─────────────────────────────────────────
  server.registerTool(
    'browser_find_text',
    {
      description: 'TEXT SEARCH — find all elements containing specific text. Returns up to 50 matches with tag, text sample, CSS selector, and viewport status. Use to locate elements by their text content when numeric IDs are not available. Example: find_text("Añadir al carro") returns the add-to-cart button even if you don\'t have its ID.',
      inputSchema: z.object({
        query: z.string().describe('Text to search for (case-insensitive)')
      })
    },
    async ({ query }) => {
      const page = browser.getActivePage();
      const results = await page.evaluate((q) => {
        const matches = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
          const text = node.textContent.trim();
          if (text.length > 0 && text.toLowerCase().includes(q.toLowerCase())) {
            const parent = node.parentNode;
            if (!parent) continue;
            const rect = parent.getBoundingClientRect();
            const tag = parent.tagName.toLowerCase();
            const id = parent.id || '';
            const classes = parent.className || '';
            const cssSel = id ? '#' + id : tag + (classes ? '.' + classes.split(' ').filter(Boolean).join('.') : '');
            matches.push({
              tag,
              text: text.substring(0, 200),
              cssSelector: cssSel,
              inViewport: rect.y < window.innerHeight && rect.x < window.innerWidth && rect.y + rect.height > 0
            });
          }
        }
        return matches.slice(0, 50);
      }, query);
      state.record('find-text', { query, count: results.length });
      return enrich(page, { query, count: results.length, results });
    }
  );

  // ── Scrolling ───────────────────────────────────────────
  server.registerTool(
    'browser_scroll_into_view',
    {
      description: 'Scroll an element into the visible area.',
      inputSchema: z.object({ selector: z.string().describe('CSS selector or numeric ID') })
    },
    async ({ selector }) => {
      const page = browser.getActivePage();
      const { element } = await browser.findElement(selector);
      if (element) await element.scrollIntoViewIfNeeded();
      return enrich(page, { ok: true, action: 'scroll-into-view' });
    }
  );

  server.registerTool(
    'browser_scroll_to',
    {
      description: 'Scroll to a percentage of the page height (0-100).',
      inputSchema: z.object({ percentage: z.number().describe('Scroll percentage (0-100)') })
    },
    async ({ percentage }) => {
      const page = browser.getActivePage();
      const pct = Math.max(0, Math.min(100, percentage));
      await page.evaluate((p) => window.scrollTo(0, document.body.scrollHeight * p / 100), pct);
      return enrich(page, { ok: true, scrolledTo: `${percentage}%` });
    }
  );

  server.registerTool(
    'browser_scroll_next',
    {
      description: 'Scroll down by one viewport height.',
      inputSchema: z.object({})
    },
    async () => {
      const page = browser.getActivePage();
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      return enrich(page, { ok: true, action: 'scroll-next' });
    }
  );

  server.registerTool(
    'browser_scroll_prev',
    {
      description: 'Scroll up by one viewport height.',
      inputSchema: z.object({})
    },
    async () => {
      const page = browser.getActivePage();
      await page.evaluate(() => window.scrollBy(0, -window.innerHeight));
      return enrich(page, { ok: true, action: 'scroll-prev' });
    }
  );

  // ── Tab Management ──────────────────────────────────────
  server.registerTool(
    'browser_list_tabs',
    {
      description: 'List all open tabs with their titles and indices.',
      inputSchema: z.object({})
    },
    async () => {
      const tabs = browser.listTabs();
      return enrich(browser.getActivePage(), { tabs });
    }
  );

  server.registerTool(
    'browser_switch_tab',
    {
      description: 'Switch to a tab by its index.',
      inputSchema: z.object({ index: z.number().describe('Tab index (0-based)') })
    },
    async ({ index }) => {
      await browser.switchTab(index);
      return enrich(browser.getActivePage(), { ok: true, action: 'switch-tab', index });
    }
  );

  server.registerTool(
    'browser_close_tab',
    {
      description: 'Close a tab by its index.',
      inputSchema: z.object({ index: z.number().describe('Tab index (0-based)') })
    },
    async ({ index }) => {
      await browser.closeTab(index);
      const page = browser.getActivePage();
      return enrich(page, { ok: true, action: 'close-tab', index });
    }
  );

  // ── Execution / Control ─────────────────────────────────
  server.registerTool(
    'browser_evaluate',
    {
      description: 'Execute JavaScript in the page context. Use for advanced DOM queries, extracting specific data, or triggering custom behavior. Returns the result of the expression. Examples: "document.title", "document.querySelectorAll(\'.price\').length", "JSON.parse(localStorage.getItem(\'cart\'))"',
      inputSchema: z.object({ code: z.string().describe('JavaScript code to execute') })
    },
    async ({ code }) => {
      const page = browser.getActivePage();
      const result = await page.evaluate(code);
      state.record('evaluate');
      return enrich(page, { result });
    }
  );

  server.registerTool(
    'browser_wait',
    {
      description: 'Legacy wait. Use browser_wait_for or browser_wait_for_any instead. Types: "networkidle" (wait for network), "selector" (wait for CSS element), "ms" (timeout in ms).',
      inputSchema: z.object({
        type: z.enum(['networkidle', 'selector', 'ms']).describe('Type of wait condition'),
        arg: z.string().optional().describe('CSS selector (if type=selector) or ms (if type=ms)'),
        ms: z.number().optional().describe('Milliseconds to wait (if type=ms)')
      })
    },
    async ({ type, arg, ms }) => {
      const page = browser.getActivePage();
      if (type === 'selector') {
        await page.waitForSelector(arg, { timeout: 30000 });
      } else if (type === 'networkidle') {
        await page.waitForLoadState('networkidle', { timeout: 30000 });
      } else if (type === 'ms') {
        await sleep(ms || parseInt(arg) || 1000);
      }
      return enrich(page, { ok: true, action: 'wait' });
    }
  );

  server.registerTool(
    'browser_fullscreen',
    {
      description: 'Toggle fullscreen mode using requestFullscreen API with F11 fallback.',
      inputSchema: z.object({})
    },
    async () => {
      const page = browser.getActivePage();
      const isFullscreen = await page.evaluate(() => !!document.fullscreenElement);
      if (isFullscreen) return enrich(page, { ok: true, fullscreen: true });
      const result = await page.evaluate(`document.documentElement.requestFullscreen().then(() => 'ok').catch(e => e.message)`);
      if (result !== 'ok') {
        await hyprctl.focusBrowserWindow();
        await sleep(200);
        await page.keyboard.press('F11');
        await sleep(500);
      }
      return enrich(page, { ok: true, fullscreen: true });
    }
  );

  server.registerTool(
    'browser_calibrate',
    {
      description: 'Auto-calibrate ydotool click offset by clicking test points on a calibration grid.',
      inputSchema: z.object({})
    },
    async () => {
      const page = browser.getActivePage();
      const windowPos = await hyprctl.getBrowserWindowPos();
      if (!windowPos) throw new Error('No browser window found via hyprctl');

      await page.setContent(CALIBRATION_HTML);
      await sleep(500);
      await page.evaluate(`document.documentElement.requestFullscreen().catch(() => {})`);
      await sleep(500);

      const viewport = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight
      }));
      let estOffsetY = Math.max(0, viewport.outerHeight - viewport.innerHeight);
      let estOffsetX = Math.max(0, viewport.outerWidth - viewport.innerWidth);

      const testPoints = [
        { row: 0, col: 0, label: 'top-left' },
        { row: 0, col: 4, label: 'top-right' },
        { row: 4, col: 0, label: 'bottom-left' },
        { row: 4, col: 4, label: 'bottom-right' },
        { row: 2, col: 2, label: 'center' },
      ];

      const errors = [];
      for (const tp of testPoints) {
        const cell = await page.$(`#cell-${tp.row}-${tp.col}`);
        if (!cell) continue;
        const box = await cell.boundingBox();
        if (!box) continue;
        await page.evaluate(() => { window.__brCalibrationHit = null; });
        const targetX = Math.round(windowPos.x + estOffsetX + box.x + box.width / 2);
        const targetY = Math.round(windowPos.y + estOffsetY + box.y + box.height / 2);
        await hyprctl.focusBrowserWindow();
        await sleep(50);
        await ydotool.naturalMouseMove(targetX, targetY, hyprctl.getCursorPos);
        await sleep(60 + Math.round(Math.random() * 30));
        await execAsync('ydotool click C0');
        await sleep(200);
        const hit = await page.evaluate(() => window.__brCalibrationHit);
        if (hit) {
          errors.push({ expected: tp, actual: hit, errX: hit.col - tp.col, errY: hit.row - tp.row, targetX, targetY });
        }
      }

      let avgErrX = 0, avgErrY = 0;
      if (errors.length > 0) {
        avgErrX = Math.round(errors.reduce((s, e) => s + e.errX, 0) / errors.length);
        avgErrY = Math.round(errors.reduce((s, e) => s + e.errY, 0) / errors.length);
      }

      const cellPitch = 86;
      const newCalibrationOffset = {
        x: estOffsetX + avgErrX * cellPitch,
        y: estOffsetY + avgErrY * cellPitch
      };
      state.setCalibrationOffset(newCalibrationOffset);
      state.record('calibrate', { windowPos, viewport, estimatedOffset: { x: estOffsetX, y: estOffsetY }, errors, avgErrX, avgErrY, calibrationOffset: newCalibrationOffset });

      return enrich(page, { windowPos, viewport, estimatedOffset: { x: estOffsetX, y: estOffsetY }, errors, avgErrX, avgErrY, calibrationOffset: newCalibrationOffset });
    }
  );

  server.registerTool(
    'browser_chain',
    {
      description: 'MULTI-STEP pipeline in one call. Pipe-delimited. E.g.: "fill 5 cebolla --submit | wait stable | observe minimal". All selectors accept numeric IDs. Supports --submit (Enter after fill/type), --precise (no typos for type). Auto-waits for DOM stable after fill--submit and click on <a> tags. Available commands: goto, fill, type, click, yclick, press, eval, wait (networkidle/stable/ms/selector), observe (normal/minimal/full), screenshot, scrollIntoView, scrollTo, scrollNext, scrollPrev, ydrag. SAVES ROUND-TRIPS: 3-5 tool calls in 1.',
      inputSchema: z.object({
        steps: z.string().describe('Pipe-delimited pipeline. E.g.: "fill 5 lasaña --submit | observe minimal | click 3 | wait networkidle"')
      })
    },
    async ({ steps }) => {
      const page = browser.getActivePage();
      if (!page) throw new Error('No active page');
      const stepResults = await execChainSteps(page, steps);
      const finalObserve = await browser.observe(page, { mode: 'minimal' });
      finalObserve.steps = stepResults;
      return enrich(page, finalObserve);
    }
  );

  // ── Help System ─────────────────────────────────────────
  const HELP_DOCS = {
    'chain': 'browser_chain — multi-step pipeline\nPipe-delimited: "fill 4 cebolla --submit | wait stable | observe"\n\nCommands: goto, fill, type, click, yclick, press, eval, wait (networkidle/stable/ms/selector), observe (normal/minimal/full), screenshot, scrollIntoView, scrollTo, scrollNext, scrollPrev, ydrag\n\nFlags: --submit (Enter after fill/type), --precise (no typos on type)\n\nAuto-waits for DOM stable after fill--submit and click on <a> tags.\n\nExample: "fill 4 lasaña --submit | observe minimal" → search + observe in 1 call',
    'selectors': 'SELECTOR TYPES — all tools accept both:\n1. NUMERIC IDs (from browser_observe or browser_view_tree)\n   Example: click(selector:"5"), fill(selector:"3", text:"hola")\n   Pros: stable within a page, easy, no CSS knowledge needed\n   Cons: change after navigation, need fresh observe()\n\n2. CSS SELECTORS (standard CSS syntax)\n   Example: click(selector:".search-box"), fill(selector:"#main-input", text:"hola")\n   Pros: work across page loads, reusable\n   Cons: complex for deep DOM, fragile if site redesigns\n\nGUIDE: use numeric IDs from observe() for regular interaction. Use CSS selectors when you need to target the same element across page loads (e.g., the search box is always "#search")',
    'wait': 'WAITING STRATEGIES:\n1. browser_click with wait_until:"networkidle" — click + wait for network in 1 call\n2. browser_wait_for(selector) — wait for specific element to appear\n3. browser_wait_for_any(conditions) — wait for multiple possible outcomes\n   Conditions: selector (element), url_match (URL text), text (page text), modal (modal), removed (element gone)\n4. browser_wait(type:"ms", ms:2000) — simple timeout\n5. browser_chain "wait stable" — MutationObserver, waits until DOM stops changing for 300ms\n\nGUIDE: After fill--submit, use browser_wait_for_any to detect whether results loaded or error appeared. After click on product, wait_for_any detects modal or navigation.',
    'diff': 'AUTO-DIFF SYSTEM:\nEvery modifying tool (click, fill, type, press, select, navigate, etc.) returns a "changed" field:\n{\n  "ok": true,\n  "changed": {\n    "added": [{"id":12, "tag":"button", "label":"Añadir"}],   // new elements\n    "removed": [{"id":5, "tag":"input", "label":"Buscar"}],    // removed elements\n    "new_modals": [{"type":"dialog", "text":"Aceptar cookies"}],\n    "url_changed": true\n  }\n}\n\nIf changed is null, nothing changed — no need to call observe().\nUse browser_diff() to compare with an explicit baseline observe.',
    'observe': 'browser_observe MODES:\n- mode:"minimal" (TOKEN SAVER) — only headings, buttons, links. ~500 chars. You still get all interactive element IDs.\n- mode:"normal" (default) — up to maxChars (default 20000). Full page text.\n- mode:"full" — unlimited text.\n- maxChars: override text limit (e.g., maxChars:5000)\n- maxInteractive: limit element count (default 400)\n\nGUIDE: Start with minimal for large pages. Switch to normal/full when you need product descriptions or prices. Use browser_snapshot for structured product data.',
    'snapshot': 'browser_snapshot(selector) — Extract structured data from a container.\n\nBest selectors: "#root", "main", ".product-grid", "[class*=\"product\"]", "section"\n\nReturns: array of items with text, href, tag, classes, viewport status.\n\nGUIDE: Use browser_view_tree(section:"#container", max_depth:3) first to discover container selectors. Then snapshot(container) to get structured data.',
    'profiles': 'SITE PROFILES — Custom tools per domain.\n\nStore reusable tool definitions per website domain. Each domain has a JSON file at ~/.config/browser-cli/profiles/<domain>.json.\n\nTools:\n  browser_profile_create(domain, name, description, steps, inputs)\n    — Define a new tool. Use {{input_name}} placeholders in steps.\n    — inputs is an array of {name, type?, description?}.\n    — Steps use chain syntax: "click {{product}} | press Escape | click 7 | press Escape"\n\n  browser_profile_list(domain?)\n    — List tools for a domain (omit to auto-detect current page URL).\n\n  browser_profile_edit(domain, name, field, value)\n    — Edit a tool field: name, description, steps, or inputs.\n\n  browser_profile_delete(domain, name)\n    — Delete a tool.\n\n  browser_profile_run(name, inputs?)\n    — Execute a tool. Replaces {{placeholders}} with inputs, runs as chain steps.\n    — Returns diff + observe info.\n\nPATTERN: Define "search-product" for mercadona.es:\n  profile_create(domain:"mercadona.es", name:"search-product",\n    description:"Search a product and observe results",\n    steps:"fill 4 {{query}} --submit | wait stable | observe minimal",\n    inputs:[{name:"query", description:"Product to search for"}])\n\nThen run: profile_run(name:"search-product", inputs:{query:"lasaña"})'
  };

  server.registerTool(
    'browser_help',
    {
      description: 'Get detailed documentation and usage patterns for browser-cli tools. Topics: chain, selectors, wait, diff, observe, snapshot, profiles. Call with no topic to get a summary.',
      inputSchema: z.object({
        topic: z.string().optional().describe('Help topic: "chain", "selectors", "wait", "diff", "observe", "snapshot", "profiles". Omit for topic list.')
      })
    },
    async ({ topic }) => {
      if (!topic) {
        return { content: [{ type: 'text', text: 'Available topics: chain, selectors, wait, diff, observe, snapshot, profiles. Call browser_help({topic:"topic-name"}) for details.' }] };
      }
      const doc = HELP_DOCS[topic];
      if (!doc) return { content: [{ type: 'text', text: `Unknown topic "${topic}". Available: chain, selectors, wait, diff, observe, snapshot, profiles.` }] };
      return { content: [{ type: 'text', text: doc }] };
    }
  );

  // ── LLM / Captcha ──────────────────────────────────────
  server.registerTool(
    'browser_llm_chat',
    {
      description: 'Send a prompt to the configured LLM. Useful for reasoning or vision tasks.',
      inputSchema: z.object({
        system: z.string().optional().describe('System prompt'),
        messages: z.array(z.string()).describe('Array of message strings'),
        images: z.array(z.string()).optional().describe('Optional array of base64-encoded images for vision')
      })
    },
    async ({ system, messages, images }) => {
      if (!messages || !messages.length) throw new Error('missing messages');
      const result = await llm.chat({ system, messages, images });
      return { content: [{ type: 'text', text: result }] };
    }
  );
}

module.exports = { register };
