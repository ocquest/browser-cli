const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);
const fs = require('fs');
const util = require('util');
const execAsync = util.promisify(require('child_process').exec);
const os = require('os');
const path = require('path');
const llm = require('./lib/llm');

function getProxyConfig() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (!proxyUrl) return {};
  try {
    const url = new URL(proxyUrl);
    return {
      server: url.origin,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined
    };
  } catch {
    return {};
  }
}

let lastIdToXPath = {}; // Global variable to store the last idToXPath mapping
const secrets = new Set();
const history = [];
let calibrationOffset = { x: 0, y: 0 };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function record(action, args = {}) {
  history.push({ action, args, timestamp: new Date().toISOString() });
}

const tmpUserDataDir = path.join(os.tmpdir(), 'br_user_data');

(async () => {
  // Clean user data dir to avoid "restore pages" prompt
  try { fs.rmSync(tmpUserDataDir, { recursive: true, force: true }); } catch (_) {}
  const proxyConfig = getProxyConfig();
  const launchOptions = {
    headless: false,
    viewport: null,
    args: ['--start-fullscreen', '--disable-session-crashed-bubble', '--disable-features=SessionCrashedBubble', '--disable-automation', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    proxy: proxyConfig.server ? { server: proxyConfig.server, username: proxyConfig.username, password: proxyConfig.password } : undefined
  };
  const context = await chromium.launchPersistentContext(tmpUserDataDir, launchOptions);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const browser = await context.browser();
  let pages = [];
  let activePage;

  const initialPage = await context.newPage();
  pages.push(initialPage);
  activePage = initialPage;

  // Focus browser window (fullscreen via --start-fullscreen arg)
  setTimeout(async () => {
    try {
      await execAsync('hyprctl dispatch focuswindow class:Chromium-browser');
    } catch (_) {}
  }, 1000);

  function getActivePage() {
    return activePage;
  }

  context.on('page', async newPage => {
    pages = await context.pages();
    activePage = newPage; // Set newly opened page as active
  });

  context.on('framenavigated', async frame => {
    if (frame === activePage.mainFrame()) {
      // The active page's main frame navigated, update activePage to ensure it's still the correct reference
      // This is a safeguard, as Playwright's page object should remain consistent across navigations
      // but it helps to re-confirm the active page in case of complex scenarios.
      activePage = frame.page();
    }
  });

  context.on('close', () => {
    // Handle context close if necessary, e.g., clean up resources
    console.log('Browser context closed.');
  });

  browser.on('disconnected', () => {
    console.log('Browser disconnected. Exiting daemon.');
    process.exit(0);
  });

  // Listen for page close events
  context.on('pageclose', closedPage => {
    pages = pages.filter(page => page !== closedPage);
    if (activePage === closedPage) {
      // If the active page was closed, switch to the last remaining page or null if no pages left
      activePage = pages.length > 0 ? pages[pages.length - 1] : null;
    }
  });

  async function getChromiumWindowPos() {
    try {
      const { stdout } = await execAsync('hyprctl clients -j');
      const clients = JSON.parse(stdout);
      const win = clients.find(c => c.class.toLowerCase() === 'chromium-browser');
      if (!win) return null;
      return { x: win.at[0], y: win.at[1], width: win.size[0], height: win.size[1] };
    } catch (err) {
      return null;
    }
  }

  async function focusChromiumWindow() {
    try {
      await execAsync('hyprctl dispatch focuswindow class:Chromium-browser');
    } catch (_) {}
  }

  async function getCursorPos() {
    const { stdout } = await execAsync('hyprctl cursorpos');
    const parts = stdout.trim().split(',').map(Number);
    return { x: parts[0], y: parts[1] };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }

  async function naturalMouseMove(targetX, targetY) {
    const start = await getCursorPos();
    const dx = targetX - start.x;
    const dy = targetY - start.y;
    const dist = Math.sqrt(dy*dy + dx*dx);
    if (dist < 8) return;

    const steps = Math.max(6, Math.min(30, Math.round(dist / 30)));

    for (let i = 1; i <= steps; i++) {
      let t = i / steps;
      t = t * t * (3 - 2 * t);
      const px = lerp(start.x, targetX, t) + rand(-1.2, 1.2);
      const py = lerp(start.y, targetY, t) + rand(-1.2, 1.2);
      const ydoX = Math.round(px / 2);
      const ydoY = Math.round(py / 2);
      await execAsync(`ydotool mousemove --absolute -x ${ydoX} -y ${ydoY}`);
      const phase = Math.abs(t - 0.5) * 2;
      const delay = Math.round(rand(3, 8) + phase * rand(3, 10));
      await new Promise(r => setTimeout(r, delay));
    }
  }

  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.send('ok');
  });

  app.get('/screenshot', async (req, res) => {
    try {
      const page = getActivePage();
      const buffer = await page.screenshot({ type: 'png' });
      if (req.query.base64 === 'true') {
        res.send(buffer.toString('base64'));
      } else {
        const filePath = path.join(os.tmpdir(), `br-screenshot-${Date.now()}.png`);
        fs.writeFileSync(filePath, buffer);
        res.send(filePath);
      }
      record('screenshot', { base64: req.query.base64 === 'true' });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/screenshot-element', async (req, res) => {
    try {
      const { selector, margin = 10, base64 } = req.body;
      if (!selector) return res.status(400).send('missing selector');
      const page = getActivePage();
      const isNumericId = !isNaN(selector) && !isNaN(parseFloat(selector));
      const resolved = await resolveSelector(selector);
      const el = isNumericId ? await page.$('xpath=' + resolved) : await page.$(resolved);
      if (!el) return res.status(400).send('Element not found');
      const box = await el.boundingBox();
      if (!box) return res.status(400).send('Element not visible');
      const clip = {
        x: Math.max(0, box.x - margin),
        y: Math.max(0, box.y - margin),
        width: box.width + 2 * margin,
        height: box.height + 2 * margin
      };
      const buffer = await page.screenshot({ clip, type: 'png' });
      if (base64) {
        res.send(buffer.toString('base64'));
      } else {
        const filePath = path.join(os.tmpdir(), `br-screenshot-el-${Date.now()}.png`);
        fs.writeFileSync(filePath, buffer);
        res.send(filePath);
      }
      record('screenshot-element', { selector, margin, base64: !!base64 });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/is-clickable', async (req, res) => {
    try {
      const { selector } = req.body;
      if (!selector) return res.status(400).send('missing selector');
      const page = getActivePage();
      const isNumericId = !isNaN(selector) && !isNaN(parseFloat(selector));
      const resolved = await resolveSelector(selector);
      const el = isNumericId ? await page.$('xpath=' + resolved) : await page.$(resolved);
      if (!el) return res.json({ clickable: false, exists: false, reason: 'Element not found' });

      const result = await page.evaluate((sel) => {
        const target = document.querySelector(sel);
        if (!target) return { clickable: false, exists: false, reason: 'Element not found' };

        const rect = target.getBoundingClientRect();
        const isVisible = target.offsetParent !== null && target.style.display !== 'none' && target.style.visibility !== 'hidden';
        if (rect.width === 0 || rect.height === 0 || !isVisible) {
          return { clickable: false, exists: true, reason: 'Element has zero dimensions or is hidden' };
        }

        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const topEl = document.elementFromPoint(cx, cy);

        if (!topEl) return { clickable: true, exists: true, reason: 'OK' };

        const isSame = topEl === target || target.contains(topEl) || topEl.contains(target);
        if (isSame) return { clickable: true, exists: true, reason: 'OK' };

        return {
          clickable: false,
          exists: true,
          covered: true,
          coveringTag: topEl.tagName,
          coveringId: topEl.id || null,
          coveringClass: (typeof topEl.className === 'string') ? topEl.className : null,
          coveringText: (topEl.textContent || '').trim().substring(0, 80),
          reason: `Element is covered by <${topEl.tagName.toLowerCase()}${topEl.id ? '#'+topEl.id : ''}>`
        };
      }, resolved);

      res.json(result);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.get('/tabs', async (req, res) => {
    try {
      const tabInfo = await Promise.all(pages.map(async (p, i) => ({
        index: i,
        title: await p.title(),
        url: p.url(),
        isActive: p === activePage
      })));
      res.json(tabInfo);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/tabs/switch', (req, res) => {
    const { index } = req.body;
    if (index === undefined || index < 0 || index >= pages.length) {
      return res.status(400).send('invalid tab index');
    }
    activePage = pages[index];
    record('switch-tab', { index });
    res.send('ok');
  });

  app.post('/tabs/close', async (req, res) => {
    try {
      const { index } = req.body;
      if (index === undefined || index < 0 || index >= pages.length) {
        return res.status(400).send('invalid tab index');
      }
      const page = pages[index];
      const wasActive = page === activePage;
      await page.close();
      pages.splice(index, 1);
      if (wasActive) {
        activePage = pages.length > 0 ? pages[Math.min(index, pages.length - 1)] : null;
      }
      record('close-tab', { index });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/goto', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send('missing url');
    try {
      await getActivePage().goto(url);
      record('goto', { url });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/element-box', async (req, res) => {
    try {
      const pos = await getElementScreenPos(req.body.selector);
      res.json({ box: pos.box });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/yclick', async (req, res) => {
    try {
      await ensureClickable(req.body.selector);
      const pos = await getElementScreenPos(req.body.selector);
      await focusChromiumWindow();
      await new Promise(r => setTimeout(r, 50));
      await naturalMouseMove(pos.screenX, pos.screenY);
      await new Promise(r => setTimeout(r, 60 + Math.round(Math.random() * 30)));
      await execAsync(`ydotool click C0`);
      record('yclick', { selector: req.body.selector, ...pos });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/evaluate', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).send('missing code');
    try {
      const result = await getActivePage().evaluate(code);
      res.json({ result });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/fill', async (req, res) => {
    const { selector, text } = req.body;
    if (!selector || text === undefined) return res.status(400).send('missing selector or text');
    try {
      await getActivePage().fill(selector, text);
      record('fill', { selector });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/fill-secret', async (req, res) => {
    const { selector, secret } = req.body;
    if (!selector || !secret) return res.status(400).send('missing selector or secret');
    try {
      await getActivePage().fill(selector, secret);
      secrets.add(secret);
      record('fill-secret', { selector });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/type', async (req, res) => {
    const { selector, text } = req.body;
    if (!selector || text === undefined) return res.status(400).send('missing selector or text');
    try {
      await getActivePage().type(selector, text);
      record('type', { selector });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/press', async (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).send('missing key');
    try {
      await getActivePage().press(key);
      record('press', { key });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.get('/html', async (req, res) => {
    try {
      const html = await getActivePage().content();
      res.type('html').send(html);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.get('/source', async (req, res) => {
    try {
      const source = await getActivePage().evaluate(() => document.documentElement.outerHTML);
      res.type('html').send(source);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/view-tree', async (req, res) => {
    try {
      const page = getActivePage();
      const { role: roleFilter, tag, match, maxDepth, onlyMatches } = req.body;
      const tree = await page.evaluate(({ role: roleFilter, tag, match, maxDepth, onlyMatches }) => {
        const idToXPath = {};
        let idCounter = 0;

        function getXPath(node) {
          if (node === document.body) return '/html/body';
          if (node === document.documentElement) return '/html';
          if (node === document) return '';
          const parent = node.parentNode;
          if (!parent) return '';
          const siblings = Array.from(parent.childNodes).filter(n => n.nodeType === Node.ELEMENT_NODE);
          const sameTag = siblings.filter(n => n.nodeName === node.nodeName);
          const idx = sameTag.indexOf(node) + 1;
          return getXPath(parent) + '/' + node.nodeName.toLowerCase() + '[' + idx + ']';
        }

        function buildTree(node, depth) {
          if (node.nodeType !== Node.ELEMENT_NODE) return null;
          if (maxDepth && depth > maxDepth) return null;

          const tagName = node.tagName.toLowerCase();
          const role = node.getAttribute('role') || '';
          const name = node.textContent ? node.textContent.trim().substring(0, 80) : '';
          const id = ++idCounter;

          const xpath = getXPath(node);
          if (xpath) idToXPath[id] = xpath;

          let line = '[' + id + '] ' + tagName;
          if (role) line += ' [' + role + ']';
          if (name) line += ': ' + name;

          let passes = true;
          if (roleFilter && !roleFilter.split(',').includes(role)) passes = false;
          if (tag && !tag.split(',').includes(tagName)) passes = false;
          if (match && !name.toLowerCase().includes(match.toLowerCase())) passes = false;

          const children = Array.from(node.children)
            .map(child => buildTree(child, depth + 1))
            .filter(Boolean);

          if (onlyMatches && !passes && children.length === 0) return null;

          return { line, passes, children, id };
        }

        const root = buildTree(document.body, 0);
        return { tree: root, idToXPath };
      }, { role: roleFilter, tag, match, maxDepth, onlyMatches });

      lastIdToXPath = tree.idToXPath;
      const result = tree.tree;

      function formatTree(node, prefix = '') {
        let text = prefix + '[' + node.id + '] ' + node.line;
        if (node.children) {
          for (const child of node.children) {
            text += '\n' + formatTree(child, prefix + '  ');
          }
        }
        return text;
      }

      res.json({ tree: formatTree(result) });
    } catch (err) {
      res.status(500).send(err.message + " " + err.stack);
    }
  });

  app.post('/xpath-for-id', (req, res) => {
    const { id } = req.body;
    if (id === undefined) return res.status(400).send('missing id');
    const xpath = lastIdToXPath[id];
    if (!xpath) return res.status(400).send('XPath not found for ID');
    res.json({ xpath });
  });

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

  app.post('/fullscreen', async (req, res) => {
    try {
      const page = getActivePage();
      const isFullscreen = await page.evaluate(() => !!document.fullscreenElement);
      if (isFullscreen) {
        res.send('ok');
        return;
      }
      const result = await page.evaluate(`document.documentElement.requestFullscreen().then(() => 'ok').catch(e => e.message)`);
      if (result !== 'ok') {
        await focusChromiumWindow();
        await new Promise(r => setTimeout(r, 200));
        await page.keyboard.press('F11');
        await new Promise(r => setTimeout(r, 500));
      }
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  const TEST_FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>br click test</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #eee; font-family: monospace; padding: 40px; }
  h1 { text-align: center; margin-bottom: 30px; color: #0f0; }
  h2 { margin: 20px 0 10px; color: #ffd700; font-size: 16px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
  button, .btn { padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-family: monospace; }
  button.primary { background: #3498db; color: #fff; }
  button.success { background: #2ecc71; color: #fff; }
  button.danger { background: #e74c3c; color: #fff; }
  button:active { transform: scale(0.95); }
  input, textarea, select { padding: 8px 12px; border: 2px solid #555; border-radius: 6px; background: #16213e; color: #eee; font-size: 14px; font-family: monospace; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: #3498db; }
  label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .counter { background: #0f3460; padding: 12px 20px; border-radius: 8px; font-size: 24px; display: inline-block; margin: 10px 0; }
  .log { background: #0a0a1a; padding: 12px; border-radius: 6px; max-height: 200px; overflow-y: auto; font-size: 12px; margin-top: 20px; }
  .log div { padding: 2px 0; border-bottom: 1px solid #1a1a3e; }
  .log .click { color: #2ecc71; }
  .log .input { color: #3498db; }
  .log .focus { color: #ffd700; }
  .tag { font-size: 11px; color: #888; margin-left: 8px; }
</style>
</head>
<body>
<h1>br yclick test ▸</h1>

<h2>Buttons</h2>
<div class="row">
  <button class="primary" id="btn-1">Button 1</button>
  <button class="success" id="btn-2">Button 2</button>
  <button class="danger" id="btn-3">Button 3</button>
  <button disabled>Disabled</button>
  <a class="btn primary" id="btn-link" href="#">Link as button</a>
</div>

<h2>Inputs</h2>
<div class="row">
  <input id="input-text" placeholder="Text input">
  <input id="input-email" type="email" placeholder="Email">
  <input id="input-password" type="password" placeholder="Password">
</div>
<div class="row">
  <textarea id="textarea" placeholder="Textarea" rows="2" cols="30"></textarea>
  <select id="select">
    <option>Option 1</option>
    <option selected>Option 2</option>
    <option>Option 3</option>
  </select>
</div>

<h2>Checkboxes &amp; Radios</h2>
<div class="row">
  <label><input type="checkbox" id="check-1"> Check 1</label>
  <label><input type="checkbox" id="check-2"> Check 2</label>
  <label><input type="radio" name="r" id="radio-1"> Radio 1</label>
  <label><input type="radio" name="r" id="radio-2"> Radio 2</label>
</div>

<h2>Counter <span class="tag">(click count)</span></h2>
<div class="counter" id="counter">0</div>

<h2>Drag &amp; Drop <span class="tag">(try: br ydrag 37 39)</span></h2>
<div class="row">
  <div draggable="true" id="drag-a" class="draggable" style="background:#e74c3c;width:80px;height:80px;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:grab;font-weight:bold;">A</div>
  <div id="drop-zone" style="background:#2d2d5e;width:120px;height:100px;border:3px dashed #888;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#888;">Drop here</div>
  <div id="drag-result">not dropped</div>
</div>
<div id="drag-log" style="font-size:12px;color:#888;margin-top:4px;"></div>

<h2>Log <span class="tag">(click/focus/input events)</span></h2>
<div class="log" id="log"></div>

<script>
  const log = document.getElementById('log');
  const counterElem = document.getElementById('counter');
  let count = 0;

  function addLog(msg, type) {
    const div = document.createElement('div');
    div.className = type;
    div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  // Drag handlers
  const dragA = document.getElementById('drag-a');
  const dropZone = document.getElementById('drop-zone');
  const dragResult = document.getElementById('drag-result');
  const dragLog = document.getElementById('drag-log');

  dragA.addEventListener('dragstart', () => {
    dragLog.textContent = 'dragstart on A';
    document.body.style.userSelect = 'none';
  });
  dragA.addEventListener('dragend', () => {
    document.body.style.userSelect = '';
  });
  dropZone.addEventListener('dragover', e => e.preventDefault());
  dropZone.addEventListener('drop', () => {
    dragA.textContent = '✓';
    dragA.style.background = '#2ecc71';
    dragResult.textContent = 'dropped!';
    dragLog.textContent = 'drop on zone at ' + new Date().toLocaleTimeString();
    addLog('drag A dropped on zone', 'click');
  });

  document.querySelectorAll('button, #btn-link').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      count++;
      counterElem.textContent = count;
      addLog('click on ' + (el.id || el.tagName + (el.textContent ? ' "' + el.textContent.trim() + '"' : '')), 'click');
    });
  });

  document.querySelectorAll('input, textarea, select').forEach(el => {
    const type = el.type || el.tagName.toLowerCase();
    el.addEventListener('focus', () => {
      addLog('focus on ' + (el.id || type), 'focus');
    });
    el.addEventListener('input', () => {
      addLog('input on ' + (el.id || type) + ': "' + el.value + '"', 'input');
    });
  });

  document.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach(el => {
    el.addEventListener('change', () => {
      addLog('change ' + el.id + ' = ' + el.checked, 'click');
    });
  });

  addLog('Page loaded. Ready for clicks.', 'click');
</script>
</body>
</html>`;

  app.get('/test', (req, res) => {
    res.type('html').send(TEST_FORM_HTML);
  });

  app.get('/calibrate-page', (req, res) => {
    res.type('html').send(CALIBRATION_HTML);
  });

  app.get('/calibrate', async (req, res) => {
    try {
      const page = getActivePage();
      const windowPos = await getChromiumWindowPos();
      if (!windowPos) {
        return res.status(400).send('No chromium-browser window found via hyprctl');
      }

      // Navigate to calibration page
      await page.goto(`http://localhost:${port}/calibrate-page`);
      await page.waitForTimeout(500);

      // Re-enter fullscreen (navigation exits it)
      await page.evaluate(`document.documentElement.requestFullscreen().catch(() => {})`);
      await page.waitForTimeout(500);

      // Estimate initial offset from chrome height
      const viewport = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight
      }));
      let estOffsetY = Math.max(0, viewport.outerHeight - viewport.innerHeight);
      let estOffsetX = Math.max(0, viewport.outerWidth - viewport.innerWidth);

      // Test points: corners + center
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

        // Clear previous hit
        await page.evaluate(() => { window.__brCalibrationHit = null; });

        // Calculate expected screen position using current offset estimate
        const targetX = Math.round(windowPos.x + estOffsetX + box.x + box.width / 2);
        const targetY = Math.round(windowPos.y + estOffsetY + box.y + box.height / 2);

        await focusChromiumWindow();
        await new Promise(r => setTimeout(r, 50));
        await naturalMouseMove(targetX, targetY);
        await new Promise(r => setTimeout(r, 60 + Math.round(Math.random() * 30)));
        await execAsync(`ydotool click C0`);
        await page.waitForTimeout(200);

        const hit = await page.evaluate(() => window.__brCalibrationHit);
        if (hit) {
          const errX = hit.col - tp.col;
          const errY = hit.row - tp.row;
          errors.push({ expected: tp, actual: hit, errX, errY, targetX, targetY });
        }
      }

      // Compute average error
      let avgErrX = 0, avgErrY = 0;
      if (errors.length > 0) {
        avgErrX = Math.round(errors.reduce((s, e) => s + e.errX, 0) / errors.length);
        avgErrY = Math.round(errors.reduce((s, e) => s + e.errY, 0) / errors.length);
      }

      // Adjust offset based on error: each cell is 86px apart (80px + 6px gap)
      const cellPitch = 86;
      calibrationOffset = {
        x: estOffsetX + avgErrX * cellPitch,
        y: estOffsetY + avgErrY * cellPitch
      };

      record('calibrate', { windowPos, viewport, estimatedOffset: { x: estOffsetX, y: estOffsetY }, errors, avgErrX, avgErrY, calibrationOffset });
      res.json({ windowPos, viewport, estimatedOffset: { x: estOffsetX, y: estOffsetY }, errors, avgErrX, avgErrY, calibrationOffset });
    } catch (err) {
      res.status(500).send(err.message + " " + err.stack);
    }
  });

  async function resolveSelector(selector) {
    if (!isNaN(selector) && !isNaN(parseFloat(selector))) {
      const xpath = lastIdToXPath[selector];
      if (!xpath) throw new Error('XPath not found for ID');
      selector = xpath;
    }
    return selector;
  }

  async function ensureClickable(selector) {
    const isNumericId = !isNaN(selector) && !isNaN(parseFloat(selector));
    const resolved = await resolveSelector(selector);
    const page = getActivePage();
    const element = isNumericId ? await page.$('xpath=' + resolved) : await page.$(resolved);
    if (!element) throw new Error(`Element not found: ${selector}`);

    // Check coverage and try to dismiss blockers
    const checkAndDismiss = async () => {
      const result = await page.evaluate((sel) => {
        const target = document.querySelector(sel);
        if (!target) return { clickable: false, reason: 'Element not found' };

        const rect = target.getBoundingClientRect();
        const isVisible = target.offsetParent !== null && target.style.display !== 'none' && target.style.visibility !== 'hidden';
        if (rect.width === 0 || rect.height === 0 || !isVisible) {
          return { clickable: false, reason: 'Element has zero dimensions or is hidden' };
        }

        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const topEl = document.elementFromPoint(cx, cy);

        if (!topEl || topEl === target || target.contains(topEl) || topEl.contains(target)) {
          return { clickable: true };
        }

        return {
          clickable: false,
          coveringTag: topEl.tagName,
          coveringId: topEl.id || null,
          coveringText: (topEl.textContent || '').trim().substring(0, 80),
          reason: `Covered by <${topEl.tagName.toLowerCase()}${topEl.id ? '#'+topEl.id : ''}>`
        };
      }, resolved);

      return result;
    };

    let check = await checkAndDismiss();
    if (check.clickable) return element;

    // Try to dismiss common blockers
    const acceptCookieViaEval = async () => {
      await page.evaluate(() => {
        // Try common cookie acceptance selectors
        const selectors = [
          '#sp-cc-accept',
          '.fc-cta-consent',
          '.cookie-accept',
          'button[aria-label*="cookie" i]',
          'button[aria-label*="accept" i]',
          '#onetrust-accept-btn-handler',
          '.cc-btn',
          '.accept-cookies',
          'button:has-text("Accept")',
          'button:has-text("Aceptar")',
          'button:has-text("Accept all")'
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn) { btn.click(); return true; }
        }
        // Try iframe cookie banners
        const iframe = document.getElementById('fast-cmp-iframe') || document.querySelector('iframe[title*="cookie" i]');
        if (iframe) {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            const btn = doc.querySelector('button');
            if (btn) { btn.click(); return true; }
          } catch (_) {}
        }
        return false;
      });
    };

    // If covered by an iframe, try clicking a button inside it
    if (check.coveringTag === 'IFRAME' && check.coveringId) {
      await page.evaluate((id) => {
        const iframe = document.getElementById(id);
        if (!iframe) return;
        try {
          const doc = iframe.contentDocument || iframe.contentWindow.document;
          const btns = doc.querySelectorAll('button');
          for (const btn of btns) { btn.click(); }
        } catch (_) {}
      }, check.coveringId);
      await new Promise(r => setTimeout(r, 500));
      check = await checkAndDismiss();
      if (check.clickable) return element;
    }

    // Try generic dismiss: click the first button in the covering element
    if (!check.clickable) {
      await acceptCookieViaEval();
      await new Promise(r => setTimeout(r, 500));
      check = await checkAndDismiss();
      if (check.clickable) return element;
    }

    // Try closing via overlay click (click top-center of covering element)
    if (!check.clickable) {
      await page.evaluate(() => {
        const overlay = document.querySelector('[class*="modal"], [class*="overlay"], [class*="popup"], [class*="dialog"]');
        if (overlay) {
          const closeBtn = overlay.querySelector('button, [class*="close"], [aria-label*="close" i]');
          if (closeBtn) closeBtn.click();
        }
      });
      await new Promise(r => setTimeout(r, 500));
      check = await checkAndDismiss();
    }

    if (!check.clickable) {
      throw new Error(`Cannot click element: ${check.reason}${check.coveringText ? ' ("'+check.coveringText+'")' : ''}`);
    }

    return element;
  }

  async function getElementScreenPos(selector) {
    if (!selector) throw new Error('missing selector');
    const isNumericId = !isNaN(selector) && !isNaN(parseFloat(selector));
    const resolved = await resolveSelector(selector);
    const page = getActivePage();
    const element = isNumericId ? await page.$('xpath=' + resolved) : await page.$(resolved);
    if (!element) throw new Error(`Element not found for selector: ${selector}`);
    await element.scrollIntoViewIfNeeded();
    await new Promise(r => setTimeout(r, 100));
    const box = await element.boundingBox();
    if (!box) throw new Error('Element has no bounding box (not visible?)');
    const windowPos = await getChromiumWindowPos();
    if (!windowPos) throw new Error('No chromium-browser window found via hyprctl');
    return {
      screenX: Math.round(windowPos.x + box.x + box.width / 2 + calibrationOffset.x),
      screenY: Math.round(windowPos.y + box.y + box.height / 2 + calibrationOffset.y),
      windowPos, box
    };
  }

  app.post('/ydrag', async (req, res) => {
    const { from, to } = req.body;
    if (!from || !to) return res.status(400).send('missing from/to');
    try {
      const fromPos = await getElementScreenPos(from);
      const toPos = await getElementScreenPos(to);
      await focusChromiumWindow();
      await new Promise(r => setTimeout(r, 50));
      await naturalMouseMove(fromPos.screenX, fromPos.screenY);
      await new Promise(r => setTimeout(r, 80));
      await execAsync(`ydotool click 0x40`); // left button down
      await new Promise(r => setTimeout(r, 120));
      await naturalMouseMove(toPos.screenX, toPos.screenY);
      await new Promise(r => setTimeout(r, 80));
      await execAsync(`ydotool click 0x80`); // left button up
      record('ydrag', { from, to });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/llm/chat', async (req, res) => {
    try {
      const { system, messages, images } = req.body;
      if (!messages || !messages.length) return res.status(400).send('missing messages');
      const result = await llm.chat({ system, messages, images });
      res.json({ result });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/solve-slide-captcha', async (req, res) => {
    try {
      const page = getActivePage();
      const { backgroundSelector, tileSelector, trackSelector, retries } = req.body;
      const maxRetries = Math.min(retries || 2, 5);

      const bgSel = backgroundSelector || '.gc-picture';
      const tileSel = tileSelector || '.gc-tile';
      const trkSel = trackSelector || '.gc-drag-slide-bar';

      // Helper: resolve selector to element
      const resolveEl = async (sel) => {
        const isNumericId = !isNaN(sel) && !isNaN(parseFloat(sel));
        const resolved = await resolveSelector(sel);
        return isNumericId ? await page.$('xpath=' + resolved) : await page.$(resolved);
      };

      // Helper: click the refresh button in the captcha to get a new puzzle
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
        await new Promise(r => setTimeout(r, 2000));
      };

      // Helper: scroll captcha area into view
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
        await new Promise(r => setTimeout(r, 500));
        return found;
      };

      // Auto-detect the correct slide captcha wrapper (handles multiple captchas on page)
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
      let scope = await detectScope();
      await scrollToCaptcha();

      // Helper: take background screenshot (with or without coordinate grid)
      const screenshotBg = async (sel, withGrid) => {
        const el = await resolveEl(sel);
        if (!el) return null;
        await el.scrollIntoViewIfNeeded();
        await new Promise(r => setTimeout(r, 300));
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
                label.style.cssText = `position:absolute; left:${x-14}px; top:-16px; font-size:9px; color:#fff; font-weight:bold; font-family:monospace; background:rgba(200,0,0,0.85); padding:0 3px; line-height:14px; white-space:nowrap; border-radius:2px;`;
                overlay.appendChild(label);
              }
            }
            document.body.appendChild(overlay);
          }, { box });
          await new Promise(r => setTimeout(r, 150));
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

      // Helper: fetch image as base64 from any src (even cross-origin via fetch)
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
            // Fallback: try canvas draw with anonymous cors
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

      // Helper: find notch X by pixel-matching tile against background
      // Runs entirely in page context, uses data: URLs (no CORS issues)
      const findNotchByPixelMatch = async (scope, bgSel, tileSel) => {
        try {
          const result = await page.evaluate(({ scope, bgSel, tileSel }) => {
            const sc = scope ? scope + ' ' : '';
            const w = scope ? document.querySelector(scope) : document;

            // Find bg img
            const bgImg = w.querySelector(sc + bgSel);
            if (!bgImg || bgImg.tagName !== 'IMG') return null;
            // Find tile img (inside .gc-tile)
            const tileDiv = w.querySelector(sc + '.gc-tile');
            if (!tileDiv) return null;
            const tileImg = tileDiv.querySelector('img');
            if (!tileImg) return null;
            if (!tileImg || tileImg.tagName !== 'IMG') return null;

            // Render bg to canvas
            const bgC = document.createElement('canvas');
            bgC.width = bgImg.naturalWidth;
            bgC.height = bgImg.naturalHeight;
            const bgCtx = bgC.getContext('2d');
            bgCtx.drawImage(bgImg, 0, 0);
            let bgData;
            try { bgData = bgCtx.getImageData(0, 0, bgC.width, bgC.height).data; }
            catch { return null; }

            // Render tile to canvas
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

            // Find non-transparent bounds of the tile
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

            // Find position where tile differs MOST from bg (notch is a cutout in bg)
            // The notch in the bg is where the puzzle piece was cut from:
            // the tile pixels will differ significantly from the bg pixels there.
            // We want max-diff (notch is missing from bg, so tile != bg at that position)
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
          // Convert from natural image coords to CSS pixel coords
          const bgEl = await resolveEl(bgSel);
          const box = await bgEl.boundingBox();
          if (!box) return result.x; // fallback to natural coords
          const cssScale = box.width / result.bw;
          const cssX = Math.round(result.x * cssScale);
          record('pixel-match', { naturalX: result.x, cssX, score: result.score, bw: result.bw, tw: result.tw });
          return cssX;
        } catch (e) {
          record('pixel-match-error', e.message);
          return null;
        }
      };

      // Helper: ask LLM for notch position
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

      // Retry loop
      let attempt = 0;
      let lastError = null;
      let attempts = [];

      while (attempt <= maxRetries) {
        attempt++;
        const scopedBgSel = scope ? scope + ' ' + bgSel : bgSel;
        const scopedTileSel = scope ? scope + ' ' + tileSel : tileSel;

        // METHOD 1: Pixel matching (tile vs bg in page context, natural resolution)
        let targetX = await findNotchByPixelMatch(scope, bgSel, tileSel);
        let notchMethod = 'pixel-match';
        let bgBase64 = null;
        let tileBase64 = null;

        // METHOD 2: Fall back to LLM vision (needs screenshots with grid overlay)
        if (targetX == null) {
          // Hide overlapping tile for clean bg screenshot
          await page.evaluate(() => {
            const tile = document.querySelector('.gc-tile');
            if (tile) tile.style.setProperty('display', 'none', 'important');
          });
          await new Promise(r => setTimeout(r, 100));
          bgBase64 = await screenshotBg(scopedBgSel, true);
          // Restore tile
          await page.evaluate(() => {
            const tile = document.querySelector('.gc-tile');
            if (tile) tile.style.removeProperty('display');
          });
          await new Promise(r => setTimeout(r, 100));
          // Screenshot tile for LLM
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

        // Get element positions just before drag
        await scrollToCaptcha();
        await new Promise(r => setTimeout(r, 300));

        const coords = await page.evaluate(({ scope, trkSel, bgSel }) => {
          const sc = scope ? scope + ' ' : '';
          const bar = document.querySelector(sc + trkSel);
          if (!bar) return null;
          const barRect = bar.getBoundingClientRect();
          const wrapper = scope ? document.querySelector(scope) : document;
          // Must find block ONLY within the track to avoid matching .gc-icon-block etc.
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
        }, { scope, trkSel, bgSel });

        if (!coords || !coords.bar) {
          lastError = 'Slider track not found';
          break;
        }

        const windowPos = await getChromiumWindowPos();
        if (!windowPos) {
          lastError = 'Browser window not found';
          break;
        }

        const toScreenX = (pageX) => Math.round(windowPos.x + pageX + calibrationOffset.x);
        const toScreenY = (pageY) => Math.round(windowPos.y + pageY + calibrationOffset.y);

        let fromX, fromY, toX, toY;
        if (coords.block) {
          fromX = toScreenX(coords.block.x + coords.block.w / 2);
          fromY = toScreenY(coords.block.y + coords.block.h / 2);
        } else {
          fromX = toScreenX(coords.bar.x + 20);
          fromY = toScreenY(coords.bar.y + coords.bar.h / 2);
        }

        // The tile is what actually needs to align with the notch.
        // Calculate how much the tile must move, then apply that delta to the block.
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

        // Perform the drag
        await focusChromiumWindow();
        await new Promise(r => setTimeout(r, 50));
        await execAsync(`ydotool mousemove --absolute -x ${Math.round(fromX / 2)} -y ${Math.round(fromY / 2)}`);
        await new Promise(r => setTimeout(r, 60));
        await execAsync(`ydotool click 0x40`);
        await new Promise(r => setTimeout(r, 100));
        const dragDist = Math.hypot(toX - fromX, toY - fromY);
        const dragSteps = Math.min(Math.max(Math.round(dragDist / 20), 3), 30);
        for (let s = 1; s <= dragSteps; s++) {
          const t = s / dragSteps;
          const px = Math.round(fromX + (toX - fromX) * t);
          const py = Math.round(fromY + (toY - fromY) * t);
          await execAsync(`ydotool mousemove --absolute -x ${Math.round(px / 2)} -y ${Math.round(py / 2)}`);
          await sleep(rand(3, 8));
        }
        await new Promise(r => setTimeout(r, 80));
        await execAsync(`ydotool click 0x80`);

        record('solve-slide-captcha', { attempt, targetX, fromX, fromY, toX, toY });

        // Verify
        await new Promise(r => setTimeout(r, 1500));
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
          return res.json({
            success: true,
            verified: true,
            attempts,
            drag: { from: { x: Math.round(fromX), y: Math.round(fromY) }, to: { x: Math.round(toX), y: Math.round(toY) } }
          });
        }

        if (attempt <= maxRetries) {
          await refreshCaptcha(scope);
        }
      }

      // All attempts failed
      res.json({
        success: true,
        verified: false,
        error: lastError,
        attempts
      });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // Configure LLM
  if (process.env.BR_LLM_API_KEY) {
    llm.configure({ apiKey: process.env.BR_LLM_API_KEY });
  }

  const port = 3030;
  app.listen(port, () => {
    console.log(`br daemon running on port ${port}`);
    process.stdout.uncork();
  });

  async function shutdown() {
    try {
      await Promise.race([
        context.close(),
        new Promise(r => setTimeout(r, 3000))
      ]);
    } catch (_) {}
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch(err => {
  console.error('daemon error:', err);
  process.exit(1);
});
