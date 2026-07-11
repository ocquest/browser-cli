const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs');
const util = require('util');
const execAsync = util.promisify(require('child_process').exec);
const os = require('os');
const path = require('path');
const state = require('../daemon/services/state');
const hyprctl = require('../daemon/services/hyprctl');
const ydotool = require('../daemon/services/ydotool');
const llm = require('../../lib/llm');

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

class BrowserManager {
  constructor() {
    this.context = null;
    this.browser = null;
    this.pages = [];
    this.activePage = null;
    this.ready = false;
  }

  async launch(userDataDir) {
    const dir = userDataDir || path.join(os.homedir(), '.br-profile');
    const proxyConfig = getProxyConfig();

    const launchOptions = {
      headless: false,
      viewport: null,
      channel: 'chrome',
      args: [
        '--start-fullscreen',
        '--disable-session-crashed-bubble',
        '--disable-features=SessionCrashedBubble,InfiniteSessionRestore',
        '--disable-automation',
        '--disable-blink-features=AutomationControlled',
        '--no-proxy-server'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      proxy: proxyConfig.server
        ? { server: proxyConfig.server, username: proxyConfig.username, password: proxyConfig.password }
        : undefined
    };

    this.context = await chromium.launchPersistentContext(dir, launchOptions);
    this.browser = await this.context.browser();

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const initialPage = await this.context.newPage();
    this.pages.push(initialPage);
    this.activePage = initialPage;

    this.context.on('page', async newPage => {
      this.pages = await this.context.pages();
      this.activePage = newPage;
    });

    this.context.on('framenavigated', async frame => {
      if (frame === this.activePage?.mainFrame()) {
        this.activePage = frame.page();
      }
    });

    this.context.on('pageclose', closedPage => {
      this.pages = this.pages.filter(p => p !== closedPage);
      if (this.activePage === closedPage) {
        this.activePage = this.pages.length > 0 ? this.pages[this.pages.length - 1] : null;
      }
    });

    this.browser.on('disconnected', () => {
      console.error('Browser disconnected');
      process.exit(0);
    });

    try {
      await hyprctl.focusChromiumWindow();
    } catch (_) {}

    this.ready = true;
    return initialPage;
  }

  async close() {
    try {
      await Promise.race([
        this.context?.close(),
        new Promise(r => setTimeout(r, 3000))
      ]);
    } catch (_) {}
  }

  getActivePage() {
    return this.activePage;
  }

  async newPage() {
    const page = await this.context.newPage();
    this.pages.push(page);
    this.activePage = page;
    return page;
  }

  async switchTab(index) {
    if (index < 0 || index >= this.pages.length) {
      throw new Error(`Invalid tab index ${index}. ${this.pages.length} tabs available.`);
    }
    this.activePage = this.pages[index];
    state.record('switch-tab', { index });
  }

  async closeTab(index) {
    if (index < 0 || index >= this.pages.length) {
      throw new Error(`Invalid tab index ${index}. ${this.pages.length} tabs available.`);
    }
    const page = this.pages[index];
    const wasActive = page === this.activePage;
    await page.close();
    this.pages.splice(index, 1);
    if (wasActive) {
      this.activePage = this.pages.length > 0 ? this.pages[Math.min(index, this.pages.length - 1)] : null;
    }
    state.record('close-tab', { index });
  }

  async getTabInfo() {
    return await Promise.all(this.pages.map(async (p, i) => ({
      index: i,
      title: await p.title(),
      url: p.url(),
      isActive: p === this.activePage
    })));
  }

  async resolveSelector(selector) {
    return state.resolveSelector(selector);
  }

  async findElement(selector) {
    const page = this.getActivePage();
    if (!page) throw new Error('No active page');
    const isNumericId = !isNaN(selector) && !isNaN(parseFloat(selector));
    if (!isNumericId) {
      return { element: await page.$(selector), useXpath: false, selector };
    }
    try {
      const xpath = await this.resolveSelector(selector);
      const el = await page.$('xpath=' + xpath);
      if (el) return { element: el, useXpath: true, selector: xpath };
    } catch {}
    const xpath = await page.evaluate((id) => {
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
    const el = await page.$('xpath=' + xpath);
    if (!el) throw new Error(`Element not found for ID ${selector}`);
    return { element: el, useXpath: true, selector: xpath };
  }

  async ensureClickable(selector) {
    const { element, useXpath, selector: resolved } = await this.findElement(selector);
    const page = this.getActivePage();
    if (!element) throw new Error(`Element not found: ${selector}`);

    const checkAndDismiss = async () => {
      return await page.evaluate(({ sel, useXpath }) => {
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
          reason: `Covered by <${topEl.tagName.toLowerCase()}${topEl.id ? '#' + topEl.id : ''}>`
        };
      }, { sel: resolved, useXpath });
    };

    let check = await checkAndDismiss();
    if (check.clickable) return element;

    await this.autoDismissBlockers(page);
    await sleep(500);
    check = await checkAndDismiss();
    if (check.clickable) return element;

    if (!check.clickable) {
      await page.evaluate(() => {
        const overlay = document.querySelector('[class*="modal"], [class*="overlay"], [class*="popup"], [class*="dialog"]');
        if (overlay) {
          const closeBtn = overlay.querySelector('button, [class*="close"], [aria-label*="close" i]');
          if (closeBtn) closeBtn.click();
        }
      });
      await sleep(500);
      check = await checkAndDismiss();
    }

    if (!check.clickable) {
      throw new Error(`Cannot click element: ${check.reason}${check.coveringText ? ' ("' + check.coveringText + '")' : ''}`);
    }
    return element;
  }

  async getElementScreenPos(selector) {
    if (!selector) throw new Error('missing selector');
    const { element } = await this.findElement(selector);
    const page = this.getActivePage();
    await element.scrollIntoViewIfNeeded();
    await sleep(100);
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

  async detectModals(page) {
    try {
      return await page.evaluate(() => {
        const warnings = [];
        const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
        for (const d of dialogs) {
          if (d.offsetParent !== null) {
            warnings.push({ type: 'dialog', text: (d.textContent || '').trim().substring(0, 200) });
          }
        }
        const overlaySel = '[class*="overlay"], [class*="modal"], [class*="popup"], [class*="backdrop"], [class*="cookie"], [id*="cookie"], [class*="consent"]';
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

  async autoDismissBlockers(page) {
    try {
      await page.evaluate(() => {
        const selectors = [
          '#sp-cc-accept', '.fc-cta-consent', '.cookie-accept',
          'button[aria-label*="cookie" i]', 'button[aria-label*="accept" i]',
          '#onetrust-accept-btn-handler', '.cc-btn', '.accept-cookies',
          'button:has-text("Accept")', 'button:has-text("Aceptar")',
          'button:has-text("Accept all")', 'button:has-text("Aceptar todas")',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn) { btn.click(); return true; }
        }
        for (const btn of document.querySelectorAll('button')) {
          const t = (btn.textContent || '').trim().toLowerCase();
          if (['accept', 'aceptar', 'accept all', 'aceptar todas', 'ok', 'de acuerdo'].includes(t)) {
            btn.click(); return true;
          }
        }
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
    } catch {}
  }

  async getPageInfo(page) {
    const modals = await this.detectModals(page);
    const info = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      scrollY: window.scrollY,
      scrollH: document.body.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }));
    return { ...info, modals };
  }

  randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  drunkChar(char) {
    const rows = ['qwertyuiop', 'asdfghjklñ', 'zxcvbnm'];
    const lower = char.toLowerCase();
    for (const row of rows) {
      const idx = row.indexOf(lower);
      if (idx >= 0) {
        const neighbors = [];
        if (idx > 0) neighbors.push(row[idx - 1]);
        if (idx < row.length - 1) neighbors.push(row[idx + 1]);
        if (neighbors.length) {
          const wrong = neighbors[this.randInt(0, neighbors.length - 1)];
          return char === char.toUpperCase() ? wrong.toUpperCase() : wrong;
        }
      }
    }
    return char;
  }

  async humanType(page, selector, text) {
    await sleep(this.randInt(100, 400));
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      await sleep(this.randInt(30, 180));
      let typed = false;
      if (Math.random() < 0.03) {
        await page.keyboard.type(char);
        await sleep(this.randInt(60, 150));
        await page.keyboard.type(char);
        await sleep(this.randInt(120, 250));
        await page.keyboard.press('Backspace');
        await sleep(this.randInt(50, 120));
        typed = true;
      }
      if (Math.random() < 0.12 && char !== ' ') {
        const wrong = this.drunkChar(char);
        if (wrong !== char) {
          await page.keyboard.type(wrong);
          await sleep(this.randInt(200, 700));
          await page.keyboard.press('Backspace');
          await sleep(this.randInt(80, 250));
        }
      }
      if (!typed) {
        await page.keyboard.type(char);
      }
      if (Math.random() < 0.06) {
        await sleep(this.randInt(500, 1500));
      }
      if (Math.random() < 0.15 && i + 1 < text.length) {
        const burst = this.randInt(1, 3);
        for (let b = 0; b < burst && i + b + 1 < text.length; b++) {
          await page.keyboard.type(text[i + b + 1]);
          await sleep(this.randInt(10, 35));
        }
        i += burst;
      }
      if (char === ' ' && Math.random() < 0.3) {
        await sleep(this.randInt(150, 500));
      }
    }
  }

  async observe(page) {
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
    const modals = await this.detectModals(page);
    if (modals.length) result.modals = modals;
    return result;
  }

  async viewTree(page, filters = {}) {
    const { role: roleFilter, tag, match, maxDepth, onlyMatches } = filters;
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
    return result ? formatTree(result) : '';
  }
}

module.exports = BrowserManager;
