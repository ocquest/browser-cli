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
const state = require('./src/daemon/services/state');
const hyprctl = require('./src/daemon/services/hyprctl');
const ydotool = require('./src/daemon/services/ydotool');

function getProxyConfig() {
  const proxyUrl = process.env.BR_PROXY || '';
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const tmpUserDataDir = path.join(os.homedir(), '.br-profile');

(async () => {
  const proxyConfig = getProxyConfig();
  const launchOptions = {
    headless: false,
    viewport: null,
    channel: 'chrome',
    args: ['--start-fullscreen', '--disable-session-crashed-bubble', '--disable-features=SessionCrashedBubble,InfiniteSessionRestore', '--disable-automation', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    proxy: proxyConfig.server ? { server: proxyConfig.server, username: proxyConfig.username, password: proxyConfig.password } : undefined
  };
  const context = await chromium.launchPersistentContext(tmpUserDataDir, launchOptions);
  console.log('[DBG] Chrome version:', (await context.browser()).version());
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Auto-login Swagbucks via Google Sign-In
    const GOOGLE_SELECTORS = [
      '[data-test="google-signin"]', '[data-testid="google-signin"]',
      '.google-signin-btn', '.S9gUrf-YoZ4jf', /* GIS container */
      'button[class*="google"]', '[class*="google"][class*="btn"]',
      '[aria-label*="Google" i]',
    ];

    function tryClick(el) {
      if (el && el.offsetParent !== null && el.getBoundingClientRect().width > 0) {
        if (el.tagName === 'IFRAME') {
          // GIS iframe — click center
          const rect = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true,
            clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
            view: window,
          }));
        } else {
          el.click();
        }
        return true;
      }
      return false;
    }

    function tryGoogleSignIn() {
      if (!window.location.hostname.includes('swagbucks.com')) return false;
      for (const sel of GOOGLE_SELECTORS) {
        const el = document.querySelector(sel);
        if (tryClick(el)) return true;
      }
      // GIS iframe fallback: <iframe src*="accounts.google.com/gsi/"
      const iframes = document.querySelectorAll('iframe[src*="accounts.google.com"]');
      for (const f of iframes) {
        if (tryClick(f)) return true;
      }
      return false;
    }

    window.addEventListener('load', () => { setTimeout(tryGoogleSignIn, 2000); });

    const observer = new MutationObserver(() => {
      if (window.location.hostname.includes('swagbucks.com')) tryGoogleSignIn();
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
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

  // Auto-login + navegar a encuestas
  (async () => {
    try {
      if (initialPage.url() === 'about:blank') {
        await initialPage.goto('https://www.swagbucks.com/p/login?lang=es&rloc=%2Fg%2Fpaid-surveys%3Flang%3Des', { timeout: 15000, waitUntil: 'load' }).catch(() => {});
        await sleep(2000);
        for (let attempt = 0; attempt < 8; attempt++) {
          const clicked = await initialPage.evaluate(() => {
            for (const sel of ['[data-test="google-signin"]', '[data-testid="google-signin"]', '.google-signin-btn', '.S9gUrf-YoZ4jf', 'button[class*="google"]', '[aria-label*="Google" i]']) {
              const el = document.querySelector(sel);
              if (el && el.offsetParent !== null && el.getBoundingClientRect().width > 0) { el.click(); return sel; }
            }
            for (const f of document.querySelectorAll('iframe[src*="accounts.google.com"]')) {
              const r = f.getBoundingClientRect();
              if (r.width > 0) { f.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, view: window })); return 'iframe'; }
            }
            return null;
          }).catch(() => null);
          if (clicked) { console.log('[br] Auto-login OK:', clicked); await sleep(3000); break; }
          await sleep(1000);
        }
        ready = true;
        console.log('[br] Ready');
        await sleep(3000);
        await initialPage.goto('https://www.swagbucks.com/surveys?lang=es', { timeout: 15000, waitUntil: 'load' }).catch(() => {});
        console.log('[br] At surveys:', await initialPage.evaluate('location.href').catch(() => '?'));
      } else {
        ready = true;
        console.log('[br] Ready (already on page)');
      }
    } catch (e) {
      console.log('[br] Auto-login error:', e.message);
      ready = true;
      console.log('[br] Ready (after error)');
    }
  })();

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



  let ready = false;

  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.send('ok');
  });

  app.get('/ready', (req, res) => {
    if (ready) return res.send('ok');
    res.status(503).send('not ready');
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
      state.record('screenshot', { base64: req.query.base64 === 'true' });
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
      state.record('screenshot-element', { selector, margin, base64: !!base64 });
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
    state.record('switch-tab', { index });
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
      state.record('close-tab', { index });
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
      state.record('goto', { url });
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
      await hyprctl.focusChromiumWindow();
      await new Promise(r => setTimeout(r, 50));
      await ydotool.naturalMouseMove(pos.screenX, pos.screenY, hyprctl.getCursorPos);
      await new Promise(r => setTimeout(r, 60 + Math.round(Math.random() * 30)));
      await execAsync(`ydotool click C0`);
      state.record('yclick', { selector: req.body.selector, ...pos });
      res.json({ ok: true, selector: req.body.selector, x: pos.screenX, y: pos.screenY });
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
      const page = getActivePage();
      const modals = await detectModals(page);
      if (modals.length) await autoDismissBlockers(page);
      await page.fill(selector, text);
      const actual = await page.evaluate((sel) => {
        const el = document.querySelector(sel) || document.querySelector(`[data-testid="${sel}"]`);
        if (el) return el.value || el.textContent || '';
        return null;
      }, selector);
      state.record('fill', { selector });
      res.json({ ok: true, filled: text.substring(0, 50), verified: actual && actual.includes(text.substring(0, 20)) });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/fill-secret', async (req, res) => {
    const { selector, secret } = req.body;
    if (!selector || !secret) return res.status(400).send('missing selector or secret');
    try {
      await getActivePage().fill(selector, secret);
      state.addSecret(secret);
      state.record('fill-secret', { selector });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function drunkChar(char) {
    const rows = ['qwertyuiop', 'asdfghjklñ', 'zxcvbnm'];
    const lower = char.toLowerCase();
    for (const row of rows) {
      const idx = row.indexOf(lower);
      if (idx >= 0) {
        const neighbors = [];
        if (idx > 0) neighbors.push(row[idx - 1]);
        if (idx < row.length - 1) neighbors.push(row[idx + 1]);
        if (neighbors.length) {
          const wrong = neighbors[randInt(0, neighbors.length - 1)];
          return char === char.toUpperCase() ? wrong.toUpperCase() : wrong;
        }
      }
    }
    return char;
  }

  async function humanType(page, selector, text) {
    await sleep(randInt(100, 400));

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      await sleep(randInt(30, 180));

      let typed = false;

      // Accidental double-char (3%)
      if (Math.random() < 0.03) {
        await page.keyboard.type(char);
        await sleep(randInt(60, 150));
        await page.keyboard.type(char);
        await sleep(randInt(120, 250));
        await page.keyboard.press('Backspace');
        await sleep(randInt(50, 120));
        typed = true;
      }

      // Typo (~12% chance per char)
      if (Math.random() < 0.12 && char !== ' ') {
        const wrong = drunkChar(char);
        if (wrong !== char) {
          await page.keyboard.type(wrong);
          await sleep(randInt(200, 700));
          await page.keyboard.press('Backspace');
          await sleep(randInt(80, 250));
        }
      }

      // Type the correct char (skip if already typed by double-char)
      if (!typed) {
        await page.keyboard.type(char);
      }

      // Introspective pause mid-word (6%)
      if (Math.random() < 0.06) {
        await sleep(randInt(500, 1500));
      }

      // Burst: type next few chars fast (15%)
      if (Math.random() < 0.15 && i + 1 < text.length) {
        const burst = randInt(1, 3);
        for (let b = 0; b < burst && i + b + 1 < text.length; b++) {
          await page.keyboard.type(text[i + b + 1]);
          await sleep(randInt(10, 35));
        }
        i += burst;
      }

      // Space pause (30% chance after space)
      if (char === ' ' && Math.random() < 0.3) {
        await sleep(randInt(150, 500));
      }
    }
  }

  app.post('/type', async (req, res) => {
    const { selector, text, precise } = req.body;
    if (!selector || text === undefined) return res.status(400).send('missing selector or text');
    try {
      const page = getActivePage();
      // Find and focus element via DOM (avoids Playwright locator timeout)
      const found = await page.evaluate((sel) => {
        const el = document.querySelector(sel) || document.querySelector(`[data-testid="${sel}"]`);
        if (el) { el.value = ''; el.focus(); return true; }
        return false;
      }, selector);
      if (!found) return res.status(400).send('Element not found: ' + selector);
      if (precise) {
        for (const ch of text) {
          await page.keyboard.type(ch);
          await sleep(randInt(10, 30));
        }
      } else {
        await humanType(page, selector, text);
      }
      state.record('type', { selector, precise: !!precise });
      res.send('ok');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/press', async (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).send('missing key');
    try {
      const page = getActivePage();
      const modals = await detectModals(page);
      if (modals.length) await autoDismissBlockers(page);
      await page.keyboard.press(key);
      state.record('press', { key });
      res.json({ ok: true, key });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/wait', async (req, res) => {
    try {
      const page = getActivePage();
      const { type, arg, ms } = req.body;
      if (type === 'selector') {
        await page.waitForSelector(arg, { timeout: 30000 });
      } else if (type === 'networkidle') {
        await page.waitForLoadState('networkidle', { timeout: 30000 });
      } else if (type === 'timeout' || type === 'ms') {
        await sleep(ms || parseInt(arg) || 1000);
      } else {
        await sleep(1000);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.get('/observe', async (req, res) => {
    try {
      const page = getActivePage();
      const idToXPath = {};
      const result = await page.evaluate(() => {
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
        const interactive = [];
        const seen = new Set();
        const selectors = 'a[href], button, input:not([type=hidden]), textarea, select, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
        const elements = document.querySelectorAll(selectors);
        let idCounter = 0;
        const xpathMap = {};
        for (const el of elements) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.x > window.innerWidth + 50 || rect.y > window.innerHeight + 50) continue;
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().substring(0, 120);
          const aria = el.getAttribute('aria-label') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const href = el.getAttribute('href') || '';
          const role = el.getAttribute('role') || '';
          const type = el.getAttribute('type') || '';
          const label = (text || aria || placeholder || '').substring(0, 80);
          if (!label && !href && tag !== 'input' && tag !== 'textarea') continue;
          if (tag === 'a' && !href) continue;
          const key = tag + '|' + label + '|' + href;
          if (seen.has(key)) continue;
          seen.add(key);
          const id = ++idCounter;
          const xpath = getXPath(el);
          xpathMap[id] = xpath;
          interactive.push({
            id, tag, role, type,
            label,
            href: href.substring(0, 200),
            inViewport: rect.y < window.innerHeight && rect.x < window.innerWidth
          });
        }
        return {
          url: window.location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          scrollY: window.scrollY,
          scrollH: document.body.scrollHeight,
          interactive: interactive.slice(0, 200),
          text: document.body.innerText.trim().substring(0, 5000),
          xpathMap
        };
      });
      state.setIdToXPath(result.xpathMap || {});
      delete result.xpathMap;
      const modals = await detectModals(page);
      if (modals.length) result.modals = modals;
      res.json(result);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.post('/chain', async (req, res) => {
    try {
      const page = getActivePage();
      let steps = req.body.steps || [];
      if (typeof req.body.pipeline === 'string') {
        steps = req.body.pipeline.split('|').map(s => s.trim()).filter(Boolean).map(s => {
          const parts = s.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
          return { action: parts[0], args: parts.slice(1).map(a => a.replace(/^"(.*)"$/, '$1')) };
        });
      }
      if (!steps.length) return res.status(400).send('no steps');

      const stepResults = [];

      for (const step of steps) {
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
            await ensureClickable(args[0]);
            const ypos = await getElementScreenPos(args[0]);
            await hyprctl.focusChromiumWindow();
            await new Promise(r => setTimeout(r, 50));
            await ydotool.naturalMouseMove(ypos.screenX, ypos.screenY, hyprctl.getCursorPos);
            await new Promise(r => setTimeout(r, 60 + Math.round(Math.random() * 30)));
            await execAsync(`ydotool click C0`);
            entry.x = ypos.screenX;
            entry.y = ypos.screenY;
            break;
          case 'type':
            const typeIdx = args[0] === '--precise' ? 1 : 0;
            const typeSelector = args[typeIdx];
            const typeText = args.slice(typeIdx + 1).join(' ');
            const typePrecise = args[0] === '--precise';
            await page.evaluate((sel) => {
              const el = document.querySelector(sel) || document.querySelector(`[data-testid="${sel}"]`);
              if (el) { el.value = ''; el.focus(); }
            }, typeSelector);
            if (typePrecise) {
              for (const ch of typeText) {
                await page.keyboard.type(ch);
                await sleep(randInt(10, 30));
              }
            } else {
              await humanType(page, typeSelector, typeText);
            }
            break;
          case 'eval':
            const evalCode = args.join(' ');
            const evalResult = await page.evaluate(evalCode);
            entry.result = typeof evalResult === 'object' ? JSON.stringify(evalResult).substring(0, 500) : String(evalResult).substring(0, 500);
            break;
          case 'ydrag':
            if (!args[0] || !args[1]) throw new Error('ydrag requires from and to selectors');
            const fromPos = await getElementScreenPos(args[0]);
            const toPos = await getElementScreenPos(args[1]);
            await hyprctl.focusChromiumWindow();
            await new Promise(r => setTimeout(r, 50));
            await ydotool.naturalMouseMove(fromPos.screenX, fromPos.screenY, hyprctl.getCursorPos);
            await new Promise(r => setTimeout(r, 80));
            await execAsync('ydotool click 0x40');
            await new Promise(r => setTimeout(r, 120));
            await ydotool.naturalMouseMove(toPos.screenX, toPos.screenY, hyprctl.getCursorPos);
            await new Promise(r => setTimeout(r, 80));
            await execAsync('ydotool click 0x80');
            entry.fromX = fromPos.screenX;
            entry.fromY = fromPos.screenY;
            entry.toX = toPos.screenX;
            entry.toY = toPos.screenY;
            break;
          case 'screenshot':
            const ssBuffer = await page.screenshot({ type: 'png' });
            entry.screenshotBase64 = ssBuffer.toString('base64');
            if (entry.screenshotBase64.length > 100000) {
              entry.screenshotBase64 = entry.screenshotBase64.substring(0, 100000) + '...TRUNCATED';
              entry.truncated = true;
            }
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
          case 'observe':
            break;
          default:
            throw new Error('Unknown chain action: ' + action);
        }
        stepResults.push(entry);
      }

      // Final Observe snapshot with XPath registration
      const result = await page.evaluate(() => {
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
        const interactive = [];
        const seen = new Set();
        const selectors = 'a[href], button, input:not([type=hidden]), textarea, select, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
        const elements = document.querySelectorAll(selectors);
        let idCounter = 0;
        const xpathMap = {};
        for (const el of elements) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.x > window.innerWidth + 50 || rect.y > window.innerHeight + 50) continue;
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().substring(0, 120);
          const aria = el.getAttribute('aria-label') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const href = el.getAttribute('href') || '';
          const role = el.getAttribute('role') || '';
          const label = (text || aria || placeholder || '').substring(0, 80);
          if (!label && !href && tag !== 'input' && tag !== 'textarea') continue;
          if (tag === 'a' && !href) continue;
          const key = tag + '|' + label + '|' + href;
          if (seen.has(key)) continue;
          seen.add(key);
          const id = ++idCounter;
          const xpath = getXPath(el);
          xpathMap[id] = xpath;
          interactive.push({
            id, tag, role,
            type: el.getAttribute('type') || '',
            label,
            href: href.substring(0, 200),
            inViewport: rect.y < window.innerHeight && rect.x < window.innerWidth
          });
        }
        return {
          url: window.location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          scrollY: window.scrollY,
          scrollH: document.body.scrollHeight,
          interactive: interactive.slice(0, 200),
          text: document.body.innerText.trim().substring(0, 5000),
          xpathMap
        };
      });
      state.setIdToXPath(result.xpathMap || {});
      delete result.xpathMap;
      const modals = await detectModals(page);
      if (modals.length) result.modals = modals;
      result.steps = stepResults;
      res.json(result);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.get('/html', async (req, res) => {
    try {
      const html = await getActivePage().content();
      const offset = parseInt(req.query.offset) || 0;
      const limit = parseInt(req.query.limit) || html.length;
      res.type('html').send(html.slice(offset, limit ? offset + limit : undefined));
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

      state.setIdToXPath(tree.idToXPath);
      const result = tree.tree;

      function formatTree(node, prefix = '') {
        if (!node) return '';
        let text = prefix + '[' + node.id + '] ' + node.line;
        if (node.children) {
          for (const child of node.children) {
            if (!child) continue;
            text += '\n' + formatTree(child, prefix + '  ');
          }
        }
        return text;
      }

      res.json({ tree: result ? formatTree(result) : '' });
    } catch (err) {
      res.status(500).send(err.message + " " + err.stack);
    }
  });

  app.post('/xpath-for-id', (req, res) => {
    const { id } = req.body;
    if (id === undefined) return res.status(400).send('missing id');
    const xpath = state.getXPathForId(id);
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
        await hyprctl.focusChromiumWindow();
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
      const windowPos = await hyprctl.getChromiumWindowPos();
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

        await hyprctl.focusChromiumWindow();
        await new Promise(r => setTimeout(r, 50));
        await ydotool.naturalMouseMove(targetX, targetY, hyprctl.getCursorPos);
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
      const newCalibrationOffset = {
        x: estOffsetX + avgErrX * cellPitch,
        y: estOffsetY + avgErrY * cellPitch
      };
      state.setCalibrationOffset(newCalibrationOffset);

      state.record('calibrate', { windowPos, viewport, estimatedOffset: { x: estOffsetX, y: estOffsetY }, errors, avgErrX, avgErrY, calibrationOffset: newCalibrationOffset });
      res.json({ windowPos, viewport, estimatedOffset: { x: estOffsetX, y: estOffsetY }, errors, avgErrX, avgErrY, calibrationOffset: newCalibrationOffset });
    } catch (err) {
      res.status(500).send(err.message + " " + err.stack);
    }
  });

  async function resolveSelector(selector) {
    return state.resolveSelector(selector);
  }

  async function findElement(selector) {
    const isNumericId = !isNaN(selector) && !isNaN(parseFloat(selector));
    if (!isNumericId) return { element: await getActivePage().$(selector), useXpath: false, selector };
    try {
      const xpath = await resolveSelector(selector);
      const el = await getActivePage().$('xpath=' + xpath);
      if (el) return { element: el, useXpath: true, selector: xpath };
    } catch {}
    // Fallback: find Nth interactive element on-the-fly and compute its XPath
    const xpath = await getActivePage().evaluate((id) => {
      function getXPath(node) {
        if (node === document.body) return '/html/body';
        if (node === document.documentElement) return '/html';
        const parent = node.parentNode;
        if (!parent) return '';
        const siblings = Array.from(parent.childNodes).filter(n => n.nodeType === Node.ELEMENT_NODE);
        const sameTag = siblings.filter(n => n.nodeName === node.nodeName);
        const idx = sameTag.indexOf(node) + 1;
        return getXPath(parent) + '/' + node.nodeName.toLowerCase() + '[' + idx + ']';
      }
      const selectors = 'a[href], button, input:not([type=hidden]), textarea, select, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
      const els = document.querySelectorAll(selectors);
      let count = 0;
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.x > window.innerWidth + 50 || rect.y > window.innerHeight + 50) continue;
        if (++count === parseInt(id)) return getXPath(el);
      }
      return null;
    }, selector);
    if (!xpath) throw new Error(`Element not found for ID ${selector}`);
    const el = await getActivePage().$('xpath=' + xpath);
    if (!el) throw new Error(`Element not found for ID ${selector}`);
    return { element: el, useXpath: true, selector: xpath };
  }

  async function ensureClickable(selector) {
    const { element, useXpath, selector: resolved } = await findElement(selector);
    const page = getActivePage();
    if (!element) throw new Error(`Element not found: ${selector}`);

    // Check coverage and try to dismiss blockers
    const checkAndDismiss = async () => {
      const result = await page.evaluate(({ sel, useXpath }) => {
        const target = useXpath
          ? document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          : document.querySelector(sel);
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
      }, { sel: resolved, useXpath });

      return result;
    };

    let check = await checkAndDismiss();
    if (check.clickable) return element;

    // Try dismissing blockers
    await autoDismissBlockers(page);
    await new Promise(r => setTimeout(r, 500));
    check = await checkAndDismiss();
    if (check.clickable) return element;

    // Try closing via overlay click
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
    const { element } = await findElement(selector);
    const page = getActivePage();
    await element.scrollIntoViewIfNeeded();
    await new Promise(r => setTimeout(r, 100));
    const box = await element.boundingBox();
    if (!box) throw new Error('Element has no bounding box (not visible?)');
    const windowPos = await hyprctl.getChromiumWindowPos();
    if (!windowPos) throw new Error('No chromium-browser window found via hyprctl');
    const offset = state.getCalibrationOffset();
    const marginX = Math.max(2, box.width * 0.15);
    const marginY = Math.max(2, box.height * 0.15);
    const randomX = box.x + marginX + Math.random() * (box.width - 2 * marginX);
    const randomY = box.y + marginY + Math.random() * (box.height - 2 * marginY);
    return {
      screenX: Math.round(windowPos.x + randomX + offset.x),
      screenY: Math.round(windowPos.y + randomY + offset.y),
      windowPos, box,
      centerX: Math.round(windowPos.x + box.x + box.width / 2 + offset.x),
      centerY: Math.round(windowPos.y + box.y + box.height / 2 + offset.y)
    };
  }

  async function detectModals(page) {
    try {
      return await page.evaluate(() => {
        const warnings = [];
        const dialogs = document.querySelectorAll('[role=\"dialog\"], [role=\"alertdialog\"]');
        for (const d of dialogs) {
          if (d.offsetParent !== null) {
            warnings.push({ type: 'dialog', text: (d.textContent || '').trim().substring(0, 200) });
          }
        }
        const overlaySel = '[class*=\"overlay\"], [class*=\"modal\"], [class*=\"popup\"], [class*=\"backdrop\"], [class*=\"cookie\"], [id*=\"cookie\"], [class*=\"consent\"]';
        const overlays = document.querySelectorAll(overlaySel);
        for (const o of overlays) {
          if (o.offsetParent !== null && o.getBoundingClientRect().width > 0) {
            warnings.push({ type: 'overlay', text: (o.textContent || '').trim().substring(0, 200) });
          }
        }
        return warnings;
      });
    } catch { return []; }
  }

  async function autoDismissBlockers(page) {
    try {
      await page.evaluate(() => {
        // Common cookie/consent buttons
        const selectors = [
          '#sp-cc-accept', '.fc-cta-consent', '.cookie-accept',
          'button[aria-label*=\"cookie\" i]', 'button[aria-label*=\"accept\" i]',
          '#onetrust-accept-btn-handler', '.cc-btn', '.accept-cookies',
          'button:has-text(\"Accept\")', 'button:has-text(\"Aceptar\")',
          'button:has-text(\"Accept all\")', 'button:has-text(\"Aceptar todas\")',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn) { btn.click(); return true; }
        }
        // Fallback: find any visible button with accept text
        for (const btn of document.querySelectorAll('button')) {
          const t = (btn.textContent || '').trim().toLowerCase();
          if (['accept', 'aceptar', 'accept all', 'aceptar todas', 'ok', 'de acuerdo'].includes(t)) {
            btn.click(); return true;
          }
        }
        // Try iframe cookie banners
        const iframe = document.getElementById('fast-cmp-iframe') || document.querySelector('iframe[title*=\"cookie\" i]');
        if (iframe) {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            const btn = doc.querySelector('button');
            if (btn) { btn.click(); return true; }
          } catch (_) {}
        }
        return false;
      });
    } catch {}
  }

  // Scroll routes
  app.post('/scroll-into-view', async (req, res) => {
    try {
      const { selector } = req.body;
      if (!selector) return res.status(400).send('missing selector');
      const resolved = await resolveSelector(selector);
      const isNumericId = !isNaN(selector) && !isNaN(parseFloat(selector));
      const page = getActivePage();
      const el = isNumericId ? await page.$('xpath=' + resolved) : await page.$(resolved);
      if (el) await el.scrollIntoViewIfNeeded();
      res.send('ok');
    } catch (err) { res.status(500).send(err.message); }
  });

  app.post('/scroll-to', async (req, res) => {
    try {
      const { percentage } = req.body;
      const pct = parseInt(percentage) || 0;
      await getActivePage().evaluate((p) => window.scrollTo(0, document.body.scrollHeight * p / 100), pct);
      res.send('ok');
    } catch (err) { res.status(500).send(err.message); }
  });

  app.post('/next-chunk', async (req, res) => {
    try {
      await getActivePage().evaluate(() => window.scrollBy(0, window.innerHeight));
      res.send('ok');
    } catch (err) { res.status(500).send(err.message); }
  });

  app.post('/prev-chunk', async (req, res) => {
    try {
      await getActivePage().evaluate(() => window.scrollBy(0, -window.innerHeight));
      res.send('ok');
    } catch (err) { res.status(500).send(err.message); }
  });

  app.get('/check', async (req, res) => {
    try {
      const page = getActivePage();
      const modals = await detectModals(page);
      const info = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        scrollY: window.scrollY,
        scrollH: document.body.scrollHeight
      }));
      res.json({ ok: true, modals, ...info });
    } catch (err) { res.status(500).send(err.message); }
  });

  app.post('/ydrag', async (req, res) => {
    const { from, to } = req.body;
    if (!from || !to) return res.status(400).send('missing from/to');
    try {
      const fromPos = await getElementScreenPos(from);
      const toPos = await getElementScreenPos(to);
      await hyprctl.focusChromiumWindow();
      await new Promise(r => setTimeout(r, 50));
      await ydotool.naturalMouseMove(fromPos.screenX, fromPos.screenY, hyprctl.getCursorPos);
      await new Promise(r => setTimeout(r, 80));
      await execAsync(`ydotool click 0x40`); // left button down
      await new Promise(r => setTimeout(r, 120));
      await ydotool.naturalMouseMove(toPos.screenX, toPos.screenY, hyprctl.getCursorPos);
      await new Promise(r => setTimeout(r, 80));
      await execAsync(`ydotool click 0x80`); // left button up
      state.record('ydrag', { from, to });
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
