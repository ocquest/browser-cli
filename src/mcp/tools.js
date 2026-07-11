const state = require('../daemon/services/state');
const hyprctl = require('../daemon/services/hyprctl');
const ydotool = require('../daemon/services/ydotool');
const util = require('util');
const execAsync = util.promisify(require('child_process').exec);
const llm = require('../../lib/llm');

let _browser;

const z = require('zod').z;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
      description: 'Navigate the browser to a URL',
      inputSchema: z.object({ url: z.string().describe('The URL to navigate to') })
    },
    async ({ url }) => {
      const page = browser.getActivePage();
      if (!page) throw new Error('No active page');
      await page.goto(url, { timeout: 30000 });
      state.record('navigate', { url });
      const info = await browser.getPageInfo(page);
      return { content: [{ type: 'text', text: JSON.stringify(info) }] };
    }
  );

  server.registerTool(
    'browser_go_back',
    {
      description: 'Navigate back in browser history',
      inputSchema: z.object({})
    },
    async () => {
      const page = browser.getActivePage();
      await page.goBack();
      state.record('go-back');
      return { content: [{ type: 'text', text: 'Navigated back' }] };
    }
  );

  server.registerTool(
    'browser_go_forward',
    {
      description: 'Navigate forward in browser history',
      inputSchema: z.object({})
    },
    async () => {
      const page = browser.getActivePage();
      await page.goForward();
      state.record('go-forward');
      return { content: [{ type: 'text', text: 'Navigated forward' }] };
    }
  );

  server.registerTool(
    'browser_reload',
    {
      description: 'Reload the current page',
      inputSchema: z.object({})
    },
    async () => {
      const page = browser.getActivePage();
      await page.reload();
      state.record('reload');
      return { content: [{ type: 'text', text: 'Page reloaded' }] };
    }
  );

  // ── Clicks ──────────────────────────────────────────────
  server.registerTool(
    'browser_click',
    {
      description: 'Click an element using ydotool (system-level, undetectable). Provide a CSS selector or numeric ID from view_tree/observe.',
      inputSchema: z.object({ selector: z.string().describe('CSS selector or numeric element ID') })
    },
    async ({ selector }) => {
      await browser.ensureClickable(selector);
      const pos = await browser.getElementScreenPos(selector);
      await hyprctl.focusChromiumWindow();
      await sleep(50);
      await ydotool.naturalMouseMove(pos.screenX, pos.screenY, hyprctl.getCursorPos);
      await sleep(60 + Math.round(Math.random() * 30));
      await execAsync('ydotool click C0');
      state.record('yclick', { selector, x: pos.screenX, y: pos.screenY });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, x: pos.screenX, y: pos.screenY }) }] };
    }
  );

  server.registerTool(
    'browser_click_pw',
    {
      description: 'Click an element using Playwright (detectable by anti-bot systems). Use only if browser_click fails. Also accepts numeric IDs from observe/view_tree.',
      inputSchema: z.object({ selector: z.string().describe('CSS selector or numeric element ID') })
    },
    async ({ selector }) => {
      const page = browser.getActivePage();
      const modals = await browser.detectModals(page);
      if (modals.length) await browser.autoDismissBlockers(page);
      const { element } = await browser.findElement(selector);
      if (!element) throw new Error('Element not found: ' + selector);
      await element.click();
      state.record('click', { selector });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    }
  );

  server.registerTool(
    'browser_drag',
    {
      description: 'Drag and drop using ydotool (system-level). Provide source and target selectors/IDs.',
      inputSchema: z.object({
        from: z.string().describe('CSS selector or numeric ID of the element to drag'),
        to: z.string().describe('CSS selector or numeric ID of the drop target')
      })
    },
    async ({ from, to }) => {
      const fromPos = await browser.getElementScreenPos(from);
      const toPos = await browser.getElementScreenPos(to);
      await hyprctl.focusChromiumWindow();
      await sleep(50);
      await ydotool.naturalMouseMove(fromPos.screenX, fromPos.screenY, hyprctl.getCursorPos);
      await sleep(80);
      await execAsync('ydotool click 0x40');
      await sleep(120);
      await ydotool.naturalMouseMove(toPos.screenX, toPos.screenY, hyprctl.getCursorPos);
      await sleep(80);
      await execAsync('ydotool click 0x80');
      state.record('ydrag', { from, to });
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  );

  // ── Forms ───────────────────────────────────────────────
  server.registerTool(
    'browser_fill',
    {
      description: 'Fill a form field using Playwright (fast, detectable). For stealth use browser_type.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector of the input/textarea'),
        text: z.string().describe('Text to fill')
      })
    },
    async ({ selector, text }) => {
      const page = browser.getActivePage();
      const modals = await browser.detectModals(page);
      if (modals.length) await browser.autoDismissBlockers(page);
      await page.fill(selector, text);
      state.record('fill', { selector });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
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
      const page = browser.getActivePage();
      await page.fill(selector, secret);
      state.addSecret(secret);
      state.record('fill-secret', { selector });
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  );

  server.registerTool(
    'browser_type',
    {
      description: 'Type text into a field with human-like behavior (typos, bursts, pauses). Slower but undetectable.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector of the input'),
        text: z.string().describe('Text to type'),
        precise: z.boolean().optional().describe('If true, type without human-like errors')
      })
    },
    async ({ selector, text, precise }) => {
      const page = browser.getActivePage();
      const found = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) { el.value = ''; el.focus(); return true; }
        return false;
      }, selector);
      if (!found) throw new Error('Element not found: ' + selector);
      if (precise) {
        for (const ch of text) {
          await page.keyboard.type(ch);
          await sleep(browser.randInt(10, 30));
        }
      } else {
        await browser.humanType(page, selector, text);
      }
      state.record('type', { selector, precise: !!precise });
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  );

  server.registerTool(
    'browser_press',
    {
      description: 'Press a keyboard key (e.g. Enter, Tab, Escape, ArrowDown, etc.)',
      inputSchema: z.object({
        key: z.string().describe('Key to press (e.g., Enter, Tab, Escape, ArrowDown)')
      })
    },
    async ({ key }) => {
      const page = browser.getActivePage();
      const modals = await browser.detectModals(page);
      if (modals.length) await browser.autoDismissBlockers(page);
      await page.keyboard.press(key);
      state.record('press', { key });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, key }) }] };
    }
  );

  server.registerTool(
    'browser_select',
    {
      description: 'Select an option in a <select> dropdown',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector of the select element'),
        value: z.string().describe('Value or label of the option to select')
      })
    },
    async ({ selector, value }) => {
      const page = browser.getActivePage();
      await page.selectOption(selector, value);
      state.record('select', { selector, value });
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  );

  // ── Observation ─────────────────────────────────────────
  server.registerTool(
    'browser_observe',
    {
      description: 'Get a structured snapshot of the current page: URL, title, viewport, scroll position, interactive elements (up to 400), text (up to 20000 chars), and detected modals. Set cleanText=true to get deduplicated text from visible elements only.',
      inputSchema: z.object({
        cleanText: z.boolean().optional().default(false).describe('If true, returns deduplicated text from visible headings, paragraphs, list items, buttons, links only (excludes hidden/duplicate text)')
      })
    },
    async ({ cleanText }) => {
      const page = browser.getActivePage();
      const result = await browser.observe(page, cleanText);
      state.record('observe');
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    'browser_view_tree',
    {
      description: 'Get the DOM/accessibility tree with numeric node IDs and CSS selectors. Can filter by role, tag, text match, and max depth.',
      inputSchema: z.object({
        role: z.string().optional().describe('Filter by ARIA role (e.g., "button,link")'),
        tag: z.string().optional().describe('Filter by tag name (e.g., "button,input,a")'),
        match: z.string().optional().describe('Filter by text content match'),
        max_depth: z.number().optional().describe('Maximum tree depth'),
        only_matches: z.boolean().optional().describe('Only show nodes matching filters')
      })
    },
    async ({ role, tag, match, max_depth, only_matches }) => {
      const page = browser.getActivePage();
      const treeText = await browser.viewTree(page, { role, tag, match, maxDepth: max_depth, onlyMatches: only_matches });
      state.record('view-tree', { role, tag, match, maxDepth: max_depth });
      return { content: [{ type: 'text', text: treeText }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(info) }] };
    }
  );

  // ── Text Search ─────────────────────────────────────────
  server.registerTool(
    'browser_find_text',
    {
      description: 'Search the page for elements containing specific text. Returns matching elements with tag, text, and whether they are in the viewport.',
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
      return { content: [{ type: 'text', text: JSON.stringify({ query, count: results.length, results }) }] };
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
      return { content: [{ type: 'text', text: 'ok' }] };
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
      return { content: [{ type: 'text', text: `Scrolled to ${pct}%` }] };
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
      return { content: [{ type: 'text', text: 'ok' }] };
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
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  );

  // ── Tabs ────────────────────────────────────────────────
  server.registerTool(
    'browser_list_tabs',
    {
      description: 'List all open tabs with index, title, URL, and active status.',
      inputSchema: z.object({})
    },
    async () => {
      const tabs = await browser.getTabInfo();
      return { content: [{ type: 'text', text: JSON.stringify(tabs) }] };
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
      return { content: [{ type: 'text', text: `Switched to tab ${index}` }] };
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
      return { content: [{ type: 'text', text: `Closed tab ${index}` }] };
    }
  );

  // ── Execution / Control ─────────────────────────────────
  server.registerTool(
    'browser_evaluate',
    {
      description: 'Execute JavaScript code in the context of the current page.',
      inputSchema: z.object({ code: z.string().describe('JavaScript code to execute') })
    },
    async ({ code }) => {
      const page = browser.getActivePage();
      const result = await page.evaluate(code);
      state.record('evaluate');
      return { content: [{ type: 'text', text: JSON.stringify({ result }) }] };
    }
  );

  server.registerTool(
    'browser_wait',
    {
      description: 'Wait for a condition: network idle, CSS selector, or timeout.',
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
      return { content: [{ type: 'text', text: 'ok' }] };
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
      if (isFullscreen) return { content: [{ type: 'text', text: 'Already fullscreen' }] };
      const result = await page.evaluate(`document.documentElement.requestFullscreen().then(() => 'ok').catch(e => e.message)`);
      if (result !== 'ok') {
        await hyprctl.focusChromiumWindow();
        await sleep(200);
        await page.keyboard.press('F11');
        await sleep(500);
      }
      return { content: [{ type: 'text', text: 'Fullscreen toggled' }] };
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
      const windowPos = await hyprctl.getChromiumWindowPos();
      if (!windowPos) throw new Error('No chromium-browser window found via hyprctl');

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
        await hyprctl.focusChromiumWindow();
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

      return { content: [{ type: 'text', text: JSON.stringify({ windowPos, viewport, estimatedOffset: { x: estOffsetX, y: estOffsetY }, errors, avgErrX, avgErrY, calibrationOffset: newCalibrationOffset }) }] };
    }
  );

  server.registerTool(
    'browser_chain',
    {
      description: 'Execute a multi-step pipeline in a single call. Pipe-delimited syntax: action arg1 arg2 | action arg1 | ...',
      inputSchema: z.object({
        steps: z.string().describe('Pipe-delimited pipeline. E.g.: "goto https://x.com | observe | screenshot"')
      })
    },
    async ({ steps }) => {
      const page = browser.getActivePage();
      const parsedSteps = steps.split('|').map(s => s.trim()).filter(Boolean).map(s => {
        const parts = s.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
        return { action: parts[0], args: parts.slice(1).map(a => a.replace(/^"(.*)"$/, '$1')) };
      });

      if (!parsedSteps.length) throw new Error('no steps');

      const stepResults = [];

      for (const step of parsedSteps) {
        const { action, args } = step;
        const entry = { action, args };
        switch (action) {
          case 'goto':
            await page.goto(args[0]);
            break;
          case 'fill':
            await page.fill(args[0], args.slice(1).join(' '));
            break;
          case 'press':
            await page.keyboard.press(args[0]);
            entry.key = args[0];
            break;
          case 'click':
            await page.click(args[0]);
            break;
          case 'yclick':
            if (!args[0]) throw new Error('yclick requires a selector');
            await browser.ensureClickable(args[0]);
            const ypos = await browser.getElementScreenPos(args[0]);
            await hyprctl.focusChromiumWindow();
            await sleep(50);
            await ydotool.naturalMouseMove(ypos.screenX, ypos.screenY, hyprctl.getCursorPos);
            await sleep(60 + Math.round(Math.random() * 30));
            await execAsync('ydotool click C0');
            entry.x = ypos.screenX;
            entry.y = ypos.screenY;
            break;
          case 'type':
            const typeIdx = args[0] === '--precise' ? 1 : 0;
            const typeSelector = args[typeIdx];
            const typeText = args.slice(typeIdx + 1).join(' ');
            const typePrecise = args[0] === '--precise';
            await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (el) { el.value = ''; el.focus(); }
            }, typeSelector);
            if (typePrecise) {
              for (const ch of typeText) {
                await page.keyboard.type(ch);
                await sleep(browser.randInt(10, 30));
              }
            } else {
              await browser.humanType(page, typeSelector, typeText);
            }
            break;
          case 'eval':
            const evalCode = args.join(' ');
            const evalResult = await page.evaluate(evalCode);
            entry.result = typeof evalResult === 'object' ? JSON.stringify(evalResult).substring(0, 500) : String(evalResult).substring(0, 500);
            break;
          case 'wait':
            if (args[0] === 'networkidle') {
              await page.waitForLoadState('networkidle', { timeout: 30000 });
            } else if (args[0] === 'selector' && args[1]) {
              await page.waitForSelector(args[1], { timeout: 30000 });
            } else {
              await sleep(parseInt(args[0]) || 1000);
            }
            break;
          case 'screenshot':
            const ssBuffer = await page.screenshot({ type: 'png' });
            entry.screenshotBase64 = ssBuffer.toString('base64');
            if (entry.screenshotBase64.length > 100000) {
              entry.screenshotBase64 = entry.screenshotBase64.substring(0, 100000) + '...TRUNCATED';
              entry.truncated = true;
            }
            break;
          case 'observe':
            const observeResult = await browser.observe(page);
            entry.observe = observeResult;
            break;
          case 'scrollIntoView':
            await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ behavior: 'instant', block: 'center' }), args[0]);
            break;
          case 'scrollTo':
            await page.evaluate((pct) => window.scrollTo(0, document.body.scrollHeight * parseInt(pct) / 100), args[0]);
            break;
          case 'scrollNext':
            await page.evaluate(() => window.scrollBy(0, window.innerHeight));
            break;
          case 'scrollPrev':
            await page.evaluate(() => window.scrollBy(0, -window.innerHeight));
            break;
          case 'ydrag':
            if (!args[0] || !args[1]) throw new Error('ydrag requires from and to selectors');
            const dFromPos = await browser.getElementScreenPos(args[0]);
            const dToPos = await browser.getElementScreenPos(args[1]);
            await hyprctl.focusChromiumWindow();
            await sleep(50);
            await ydotool.naturalMouseMove(dFromPos.screenX, dFromPos.screenY, hyprctl.getCursorPos);
            await sleep(80);
            await execAsync('ydotool click 0x40');
            await sleep(120);
            await ydotool.naturalMouseMove(dToPos.screenX, dToPos.screenY, hyprctl.getCursorPos);
            await sleep(80);
            await execAsync('ydotool click 0x80');
            entry.fromX = dFromPos.screenX;
            entry.fromY = dFromPos.screenY;
            entry.toX = dToPos.screenX;
            entry.toY = dToPos.screenY;
            break;
          default:
            throw new Error('Unknown chain action: ' + action);
        }
        stepResults.push(entry);
      }

      const finalObserve = await browser.observe(page);
      finalObserve.steps = stepResults;

      return { content: [{ type: 'text', text: JSON.stringify(finalObserve) }] };
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

  server.registerTool(
    'browser_solve_slide_captcha',
    {
      description: 'Attempt to solve a slide captcha using pixel matching or LLM vision + ydotool drag.',
      inputSchema: z.object({
        background_selector: z.string().optional().default('.gc-picture').describe('CSS selector for captcha background'),
        tile_selector: z.string().optional().default('.gc-tile').describe('CSS selector for captcha tile'),
        track_selector: z.string().optional().default('.gc-drag-slide-bar').describe('CSS selector for slider track'),
        retries: z.number().optional().default(2).describe('Number of retries if solving fails')
      })
    },
    async ({ background_selector, tile_selector, track_selector, retries }) => {
      const page = browser.getActivePage();
      const maxRetries = Math.min(retries || 2, 5);

      const resolveEl = async (sel) => {
        const isNumericId = !isNaN(sel) && !isNaN(parseFloat(sel));
        const resolved = await browser.resolveSelector(sel);
        return isNumericId ? await page.$('xpath=' + resolved) : await page.$(resolved);
      };

      const refreshCaptcha = async (scope) => {
        await page.evaluate((scope) => {
          const w = document.querySelector(scope);
          if (!w) return;
          const iconBlock = w.querySelector('.gc-icon-block');
          if (!iconBlock) return;
          const svgs = iconBlock.querySelectorAll('svg');
          if (svgs.length >= 2) {
            svgs[svgs.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
          }
        }, scope);
        await sleep(2000);
      };

      const scrollToCaptcha = async () => {
        const found = await page.evaluate(() => {
          const h3s = document.querySelectorAll('h3');
          for (const h3 of h3s) {
            if (h3.textContent.includes('Slide')) {
              h3.scrollIntoView({ behavior: 'instant', block: 'center' });
              return true;
            }
          }
          return false;
        });
        await sleep(500);
        return found;
      };

      const detectScope = async () => {
        const wrapperSel = await page.evaluate(() => {
          const wrappers = document.querySelectorAll('.go-captcha, .captcha-wrapper, [class*="captcha"][class*="slide"]');
          for (const w of wrappers) {
            if (w.querySelector('.gc-tile') && w.querySelector('.gc-drag-slide-bar')) {
              w.dataset.brSlide = '1';
              return '.go-captcha[data-br-slide="1"]';
            }
          }
          return null;
        });
        return wrapperSel || '';
      };

      const screenshotBg = async (sel, withGrid) => {
        const el = await resolveEl(sel);
        if (!el) return null;
        await el.scrollIntoViewIfNeeded();
        await sleep(300);
        const box = await el.boundingBox();
        if (!box) return null;

        if (withGrid) {
          await page.evaluate(({ box }) => {
            const overlay = document.createElement('div');
            overlay.id = '__br_grid';
            overlay.style.cssText = `position:fixed; top:${box.y}px; left:${box.x}px; width:${box.width}px; height:${box.height}px; pointer-events:none; z-index:99999; overflow:visible;`;
            for (let x = 0; x <= box.width; x += 5) {
              const isMajor = x % 20 === 0;
              const isMid = x % 10 === 0;
              const line = document.createElement('div');
              const opacity = isMajor ? 0.7 : (isMid ? 0.35 : 0.15);
              const width = isMajor ? 2 : 1;
              line.style.cssText = `position:absolute; left:${x}px; top:0; width:0; height:100%; border-left:${width}px solid rgba(255,0,0,${opacity});`;
              overlay.appendChild(line);
              if (isMajor) {
                const label = document.createElement('span');
                label.textContent = x + 'px';
                label.style.cssText = `position:absolute; left:${x - 14}px; top:-16px; font-size:9px; color:#fff; font-weight:bold; font-family:monospace; background:rgba(200,0,0,0.85); padding:0 3px; line-height:14px; white-space:nowrap; border-radius:2px;`;
                overlay.appendChild(label);
              }
            }
            document.body.appendChild(overlay);
          }, { box });
          await sleep(150);
        }

        const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
        const clip = {
          x: Math.max(0, box.x), y: Math.max(0, box.y),
          width: Math.min(box.width, vp.w - Math.max(0, box.x)),
          height: Math.min(box.height, vp.h - Math.max(0, box.y))
        };
        let buffer = null;
        if (clip.width > 0 && clip.height > 0) {
          buffer = await page.screenshot({ clip, type: 'png' });
        }

        if (withGrid) {
          await page.evaluate(() => {
            const g = document.getElementById('__br_grid');
            if (g) g.remove();
          });
        }

        return buffer ? buffer.toString('base64') : null;
      };

      const fetchImgAsBase64 = async (el) => {
        return await page.evaluate(async (el) => {
          const getSrc = (e) => {
            if (e.tagName === 'IMG') return e.src;
            const img = e.querySelector('img');
            if (img) return img.src;
            if (e.tagName === 'CANVAS') return e.toDataURL('image/png');
            return null;
          };
          const src = getSrc(el);
          if (!src) return null;
          if (src.startsWith('data:image/')) return src.split(',')[1];
          try {
            const resp = await fetch(src, { credentials: 'omit' });
            const blob = await resp.blob();
            return await new Promise((resolve) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result.split(',')[1]);
              r.readAsDataURL(blob);
            });
          } catch {
            try {
              const c = document.createElement('canvas');
              const img = new Image();
              img.crossOrigin = 'anonymous';
              await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = src;
              });
              c.width = img.naturalWidth;
              c.height = img.naturalHeight;
              c.getContext('2d').drawImage(img, 0, 0);
              return c.toDataURL('image/png').split(',')[1];
            } catch { return null; }
          }
        }, el);
      };

      const findNotchByPixelMatch = async (scope, bgSel, tileSel) => {
        try {
          const result = await page.evaluate(({ scope, bgSel, tileSel }) => {
            const sc = scope ? scope + ' ' : '';
            const w = scope ? document.querySelector(scope) : document;
            const bgImg = w.querySelector(sc + bgSel);
            if (!bgImg || bgImg.tagName !== 'IMG') return null;
            const tileDiv = w.querySelector(sc + '.gc-tile');
            if (!tileDiv) return null;
            const tileImg = tileDiv.querySelector('img');
            if (!tileImg || tileImg.tagName !== 'IMG') return null;

            const bgC = document.createElement('canvas');
            bgC.width = bgImg.naturalWidth;
            bgC.height = bgImg.naturalHeight;
            const bgCtx = bgC.getContext('2d');
            bgCtx.drawImage(bgImg, 0, 0);
            let bgData;
            try { bgData = bgCtx.getImageData(0, 0, bgC.width, bgC.height).data; }
            catch { return null; }

            const tC = document.createElement('canvas');
            tC.width = tileImg.naturalWidth;
            tC.height = tileImg.naturalHeight;
            const tCtx = tC.getContext('2d');
            tCtx.drawImage(tileImg, 0, 0);
            let tileData;
            try { tileData = tCtx.getImageData(0, 0, tC.width, tC.height).data; }
            catch { return null; }

            const bw = bgC.width, bh = bgC.height;
            const tw = tC.width, th = tC.height;

            let minTx = tw, maxTx = 0, minTy = th, maxTy = 0;
            for (let y = 0; y < th; y++) {
              for (let x = 0; x < tw; x++) {
                if (tileData[(y * tw + x) * 4 + 3] > 50) {
                  minTx = Math.min(minTx, x); maxTx = Math.max(maxTx, x);
                  minTy = Math.min(minTy, y); maxTy = Math.max(maxTy, y);
                }
              }
            }
            const pw = maxTx - minTx + 1, ph = maxTy - minTy + 1;
            if (pw < 10 || ph < 10) return null;

            const maxSearch = Math.max(0, bw - pw);
            if (maxSearch < 1) return null;

            let bestX = 0;
            let bestScore = -Infinity;
            for (let sx = 0; sx <= maxSearch; sx += 2) {
              let score = 0, cnt = 0;
              for (let py = minTy; py <= maxTy; py++) {
                for (let px = minTx; px <= maxTx; px++) {
                  const ti = (py * tw + px) * 4;
                  if (tileData[ti + 3] < 50) continue;
                  const bx = sx + (px - minTx);
                  if (bx >= bw) continue;
                  const bi = (py * bw + bx) * 4;
                  const dr = tileData[ti] - bgData[bi];
                  const dg = tileData[ti + 1] - bgData[bi + 1];
                  const db = tileData[ti + 2] - bgData[bi + 2];
                  score += dr * dr + dg * dg + db * db;
                  cnt++;
                }
              }
              if (cnt > 0) {
                const avg = score / cnt;
                if (avg > bestScore) { bestScore = avg; bestX = sx; }
              }
            }

            return { x: bestX, score: Math.round(bestScore), bw, bh, tw, th, pw, ph };
          }, { scope, bgSel, tileSel });

          if (!result || !result.x) return null;
          const bgEl = await resolveEl(bgSel);
          const box = await bgEl.boundingBox();
          if (!box) return result.x;
          const cssScale = box.width / result.bw;
          return Math.round(result.x * cssScale);
        } catch (e) {
          return null;
        }
      };

      const findNotchByLLM = async (bgB64, tileB64) => {
        const prompt = `First image: slide captcha BACKGROUND with a RED coordinate grid overlaid. Every 20px has a thick red line labeled with the pixel position (e.g. "20px", "40px"). Thinner lines every 5px.

The background has a notch (a cut-out hole) where a puzzle piece fits. Find the EXACT pixel X position of the CENTER of this notch by reading the grid labels.

Second image: the puzzle PIECE that will be placed into the notch.

Return ONLY: <answer>X</answer> where X is the exact pixel position (0-320). Be precise — look at the grid lines and estimate between them if needed.`;

        const llmResponse = await llm.chat({
          system: 'You are a precise captcha solver. Read the coordinate grid to find the notch center position. Return <answer>X</answer> with the exact pixel X coordinate.',
          messages: [prompt],
          images: [bgB64, tileB64]
        });

        const match = llmResponse.match(/<answer>\s*(\d{1,4})\s*<\/answer>/);
        if (!match) return null;
        return parseInt(match[1], 10);
      };

      let scope = await detectScope();
      await scrollToCaptcha();

      let attempt = 0;
      let lastError = null;
      const attempts = [];

      while (attempt <= maxRetries) {
        attempt++;
        const scopedBgSel = scope ? scope + ' ' + background_selector : background_selector;
        const scopedTileSel = scope ? scope + ' ' + tile_selector : tile_selector;

        let targetX = await findNotchByPixelMatch(scope, background_selector, tile_selector);
        let notchMethod = 'pixel-match';
        let bgBase64 = null;
        let tileBase64 = null;

        if (targetX == null) {
          await page.evaluate(() => {
            const tile = document.querySelector('.gc-tile');
            if (tile) tile.style.setProperty('display', 'none', 'important');
          });
          await sleep(100);
          bgBase64 = await screenshotBg(scopedBgSel, true);
          await page.evaluate(() => {
            const tile = document.querySelector('.gc-tile');
            if (tile) tile.style.removeProperty('display');
          });
          await sleep(100);
          const tileEl = await resolveEl(scopedTileSel);
          if (tileEl) {
            const box = await tileEl.boundingBox();
            if (box) {
              const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
              const clip = {
                x: Math.max(0, box.x), y: Math.max(0, box.y),
                width: Math.min(box.width, vp.w - Math.max(0, box.x)),
                height: Math.min(box.height, vp.h - Math.max(0, box.y))
              };
              if (clip.width > 0 && clip.height > 0) {
                const buf = await page.screenshot({ clip, type: 'png' });
                tileBase64 = buf.toString('base64');
              }
            }
          }
          if (bgBase64 && tileBase64) {
            targetX = await findNotchByLLM(bgBase64, tileBase64);
            if (targetX != null) notchMethod = 'llm';
          }
        }

        if (targetX == null) {
          lastError = 'Could not determine notch position';
          break;
        }

        await scrollToCaptcha();
        await sleep(300);

        const coords = await page.evaluate(({ scope, trkSel, bgSel }) => {
          const sc = scope ? scope + ' ' : '';
          const bar = document.querySelector(sc + trkSel);
          if (!bar) return null;
          const barRect = bar.getBoundingClientRect();
          const wrapper = scope ? document.querySelector(scope) : document;
          const track = wrapper ? wrapper.querySelector('.gc-drag-slide-bar, [class*="slider"], [class*="track"]') : null;
          const block = track ? track.querySelector('.gc-drag-block, [class*="block"], [class*="handle"], [class*="thumb"], button') : null;
          const blockRect = block ? block.getBoundingClientRect() : null;
          const bg = document.querySelector(sc + bgSel);
          const bgRect = bg ? bg.getBoundingClientRect() : null;
          const tile = wrapper ? wrapper.querySelector('.gc-tile') : null;
          const tileRect = tile ? tile.getBoundingClientRect() : null;
          return {
            bar: { x: barRect.x, y: barRect.y, w: barRect.width, h: barRect.height },
            block: blockRect ? { x: blockRect.x, y: blockRect.y, w: blockRect.width, h: blockRect.height } : null,
            bg: bgRect ? { x: bgRect.x, y: bgRect.y, w: bgRect.width, h: bgRect.height } : null,
            tile: tileRect ? { x: tileRect.x, y: tileRect.y, w: tileRect.width, h: tileRect.height } : null
          };
        }, { scope, trkSel: track_selector, bgSel: background_selector });

        if (!coords || !coords.bar) {
          lastError = 'Slider track not found';
          break;
        }

        const windowPos = await hyprctl.getChromiumWindowPos();
        if (!windowPos) {
          lastError = 'Browser window not found';
          break;
        }

        const calOffset = state.getCalibrationOffset();
        const toScreenX = (pageX) => Math.round(windowPos.x + pageX + calOffset.x);
        const toScreenY = (pageY) => Math.round(windowPos.y + pageY + calOffset.y);

        let fromX, fromY, toX, toY;
        if (coords.block) {
          fromX = toScreenX(coords.block.x + coords.block.w / 2);
          fromY = toScreenY(coords.block.y + coords.block.h / 2);
        } else {
          fromX = toScreenX(coords.bar.x + 20);
          fromY = toScreenY(coords.bar.y + coords.bar.h / 2);
        }

        if (coords.tile && coords.bg) {
          const tileCenterX = coords.tile.x + coords.tile.w / 2;
          const notchX = coords.bg.x + targetX;
          const tileDelta = notchX - tileCenterX;
          toX = toScreenX(coords.block.x + coords.block.w / 2 + tileDelta);
        } else if (coords.bg) {
          toX = toScreenX(coords.bg.x + targetX);
        } else {
          toX = toScreenX(coords.bar.x + targetX);
        }
        toY = fromY;

        await hyprctl.focusChromiumWindow();
        await sleep(50);
        await execAsync(`ydotool mousemove --absolute -x ${Math.round(fromX / 2)} -y ${Math.round(fromY / 2)}`);
        await sleep(60);
        await execAsync('ydotool click 0x40');
        await sleep(100);
        const dragDist = Math.hypot(toX - fromX, toY - fromY);
        const dragSteps = Math.min(Math.max(Math.round(dragDist / 20), 3), 30);
        for (let s = 1; s <= dragSteps; s++) {
          const t = s / dragSteps;
          const px = Math.round(fromX + (toX - fromX) * t);
          const py = Math.round(fromY + (toY - fromY) * t);
          await execAsync(`ydotool mousemove --absolute -x ${Math.round(px / 2)} -y ${Math.round(py / 2)}`);
          await sleep(ydotool.rand(3, 8));
        }
        await sleep(80);
        await execAsync('ydotool click 0x80');

        state.record('solve-slide-captcha', { attempt, targetX, fromX, fromY, toX, toY });

        await sleep(1500);
        const verified = await page.evaluate(({ scope }) => {
          const w = document.querySelector(scope);
          if (!w) return { solved: false, details: { error: 'wrapper not found' } };
          const header = w.querySelector('.gc-header');
          const headerText = header ? header.textContent.trim().toLowerCase() : '';
          const successTexts = ['verified', 'passed', 'success', 'check', '✓', '✔', 'complete', 'done'];
          const failureTexts = ['failed', 'try again', 'error', 'incorrect', '✗', '✘'];
          const hasSuccessText = successTexts.some(t => headerText.includes(t));
          const hasFailureText = failureTexts.some(t => headerText.includes(t));
          const defaultPrompt = 'drag the slider';
          const promptChanged = !headerText.includes(defaultPrompt);
          const dragBlock = w.querySelector('.gc-drag-block');
          const blockLeft = dragBlock ? dragBlock.getBoundingClientRect().x : 0;
          const bar = w.querySelector('.gc-drag-slide-bar');
          const barLeft = bar ? bar.getBoundingClientRect().x : 0;
          const snappedBack = (bar && dragBlock) ? (blockLeft - barLeft < 10) : false;
          return {
            solved: hasSuccessText || (promptChanged && !hasFailureText),
            details: { headerText, promptChanged, hasSuccessText, hasFailureText, snappedBack }
          };
        }, { scope });

        attempts.push({ targetX, fromX, fromY, toX, toY, verified: verified.solved, details: { ...verified.details, method: notchMethod } });

        if (verified.solved) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, verified: true, attempts, drag: { from: { x: Math.round(fromX), y: Math.round(fromY) }, to: { x: Math.round(toX), y: Math.round(toY) } } }) }]
          };
        }

        if (attempt <= maxRetries) {
          await refreshCaptcha(scope);
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, verified: false, error: lastError, attempts }) }]
      };
    }
  );
}

module.exports = { register };
