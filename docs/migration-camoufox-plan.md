# Migration Plan: Chrome + ydotool → Camoufox (Firefox Fork)

## Why Camoufox

Camoufox (`daijro/camoufox`, 9.9k ⭐) es un fork de Firefox con parches C++ de anti-detección:
- **Sin inyección JS** — spoofea WebGL, AudioContext, WebRTC, `navigator.webdriver` a nivel motor
- **Juggler sandboxing** — Playwright corre aislado, la página no detecta automatización
- **BrowserForge** — fingerprints realistas con distribución estadística real
- **Mouse humano built-in** — movimiento Bezier en C++, no necesita ydotool
- **Headless indetectable** — parchea las leaks de Firefox headless

---

## Phase 0: Brancheo

```bash
git checkout -b feat/camoufox-migration
```

Crear rama de trabajo. Todos los cambios en esta rama.

---

## Phase 1: Dependencias

### package.json changes

| Acción | Paquete | Razón |
|--------|---------|-------|
| **REMOVE** | `playwright-extra` ^4.3.6 | Chrome-specific, stealth plugin no necesario |
| **REMOVE** | `puppeteer-extra-plugin-stealth` ^2.11.2 | Camoufox ya parchea todo en C++ |
| **KEEP** | `playwright` ^1.53.2 | Camoufox usa Playwright Firefox engine |
| **ADD** | `camoufox-js` ^0.11.1 | JS wrapper: descarga binario, aporta `launchOptions()` |

### Install browser binary

```bash
npm install
npx camoufox-js fetch
```

Descarga Camoufox a `~/.cache/camoufox/` (Linux). Opcional: `CAMOUFOX_INSTALL_DIR` para paths custom.

---

## Phase 2: `daemon.js` — Core daemon

### 2.1 Imports (lines 2-5)

**Antes:**
```js
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
```

**Después:**
```js
const { launchOptions } = require('camoufox-js');
const { firefox } = require('playwright');
```

### 2.2 Launch options (lines 37-44)

**Antes:**
```js
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
  ],
  ignoreDefaultArgs: ['--enable-automation'],
  proxy: proxyConfig.server ? { ... } : undefined
};
```

**Después:**
```js
const camoufoxOpts = await launchOptions({
  headless: false,
  blockImages: false,
  screen: { width: 1920, height: 1080 },
});
const launchOpts = {
  ...camoufoxOpts,
  args: [
    '--start-fullscreen',
    ...(camoufoxOpts.args || []),
  ],
  proxy: proxyConfig.server
    ? { server: proxyConfig.server, username: proxyConfig.username, password: proxyConfig.password }
    : undefined
};
```

### 2.3 Launch call (line 45)

**Antes:**
```js
const context = await chromium.launchPersistentContext(tmpUserDataDir, launchOptions);
```

**Después:**
```js
const context = await firefox.launchPersistentContext(tmpUserDataDir, launchOpts);
```

### 2.4 Remove `addInitScript` block (lines 47-102)

Camoufox ya parchea `navigator.webdriver` en C++. Todo el bloque Swagbucks + MutationObserver se elimina. Si se necesita auto-login Swagbucks, debe implementarse via API route, no via init script.

### 2.5 ydotool → Playwright methods

#### `yclick` handler (Express route)

**Antes:** usa `naturalMouseMove()` + `execAsync('ydotool click C0')`

**Después:** usa `page.click()` de Playwright (Camoufox ya humaniza clicks)

```js
// Dentro del route handler de /yclick:
await autoDismissBlockers(activePage);
const el = await findElement(selector);
await el.click(); // Camoufox ya aplica movimiento humano
```

Mantener ydotool como fallback opcional con flag `--force-ydotool`:

```js
if (forceYdotool) {
  // lógica legacy ydotool
} else {
  await el.click();
}
```

#### `ydrag` handler

**Antes:** ydotool mousedown + mouseup

**Después:** Playwright `page.mouse.move()` + `page.mouse.down()` + `page.mouse.move()` + `page.mouse.up()` con steps Bezier (o usar `page.dragAndDrop()`)

#### Calibrate handler

Calibración de ydotool ya no tiene sentido si no se usa ydotool. Opciones:
- Convertir a no-op que retorna offset 0,0
- Eliminar ruta y comando

**Decisión recomendada:** mantener `calibrate` como no-op que responde `{ offset: { x: 0, y: 0 }, note: 'No-op with Camoufox' }`

### 2.6 `getChromiumWindowPos` → `getBrowserWindowPos`

Actualizar llamadas en `hyprctl.js` y daemon (ver Phase 5).

---

## Phase 3: `src/mcp/browser.js` — MCP BrowserManager

### 3.1 Imports (lines 1-3)

**Antes:** `require('playwright-extra')` + `chromium.use(stealth)`

**Después:** `require('camoufox-js')` + `const { firefox } = require('playwright')`

### 3.2 `launch()` method (lines 91-153)

Mismo patrón que daemon.js:
1. Reemplazar `launchOptions` con `camoufoxOpts` de `camoufox-js`
2. `chromium.launchPersistentContext()` → `firefox.launchPersistentContext()`
3. Eliminar `addInitScript()` block
4. Eliminar Chrome-specific args
5. `focusChromiumWindow()` → `focusBrowserWindow()`

### 3.3 Error message (line 329)

**Antes:** `'Chrome window not found on your desktop...'`

**Después:** `'Browser window not found on your desktop...'`

---

## Phase 4: `src/mcp/tools.js` — MCP Tools

### 4.1 Imports (line 3)

Mantener `ydotool` require — es opcional para `--force-ydotool`.

### 4.2 Error messages

Line 1025: `'No chromium-browser window found via hyprctl'` → `'No browser window found via hyprctl'`

### 4.3 ydotool calls

Hay ~20 llamadas a `naturalMouseMove` + `execAsync('ydotool click ...')`. Estrategia:

**Wrap en helper condicional:**
```js
async function clickElement(page, element) {
  if (process.env.BR_FORCE_YDOTOOL) {
    // legacy ydotool path
  } else {
    await element.click();
  }
}
```

O simplemente reemplazar todo a `element.click()` con `force=false` global.

---

## Phase 5: `src/daemon/services/hyprctl.js`

### 5.1 Browser classes (line 4)

**Antes:**
```js
const BROWSER_CLASSES = ['chromium-browser', 'google-chrome', 'chrome', 'Chromium', 'Google-chrome'];
```

**Después:**
```js
const BROWSER_CLASSES = ['firefox', 'Firefox', 'firefox-esr', 'Mozilla Firefox', 'camoufox', 'Camoufox'].map(c => c.toLowerCase());
```

### 5.2 Rename functions

- `getChromiumWindowPos()` → `getBrowserWindowPos()`
- `focusChromiumWindow()` → `focusBrowserWindow()`

### 5.3 Update exports

Actualizar module.exports y todos los callers (daemon.js, browser.js, tools.js).

---

## Phase 6: `test/` — Tests

| Test file | Cambios |
|-----------|---------|
| `test/daemon/services/ydotool.test.js` | **KEEP** — tests de `lerp`, `rand`, `naturalMouseMove` siguen siendo válidos para el fallback |
| `test/daemon/services/hyprctl.test.js` | Actualizar nombres de funciones: `getChromiumWindowPos` → `getBrowserWindowPos` |
| `test/daemon/services/state.test.js` | **No changes** — state es agnóstico al browser |
| `test/cli/send.test.js` | **No changes** — CLI es agnóstico |

---

## Phase 7: `mcp-server.js`

Sigue igual — solo llama a `BrowserManager.launch()` que ya migramos.

Revisar:
- `ensureYdotoold()` — mantener para `--force-ydotool`
- Start-up logging: si referencia "Chrome", actualizar

---

## Phase 8: Documentation & AGENTS.md

Actualizar referencias:
- `AGENTS.md` → toda mención de "chrome", "Chrome", "chromium" a "Camoufox" o genérico
- Error messages → "Camoufox" o "Browser"
- CLI help text → consistente

---

## Summary: Files Changed

| File | Change type |
|------|-------------|
| `package.json` | Remove `playwright-extra`, `puppeteer-extra-plugin-stealth`; add `camoufox-js` |
| `daemon.js` | **Heavy** — imports, launch, ydotool routes, addInitScript removal |
| `src/mcp/browser.js` | **Heavy** — imports, launch, addInitScript removal |
| `src/mcp/tools.js` | Medium — ydotool opts, error messages |
| `src/daemon/services/hyprctl.js` | Medium — browser classes, rename functions |
| `mcp-server.js` | Light — startup log |
| `test/daemon/services/hyprctl.test.js` | Light — function name updates |
| `AGENTS.md` | Light — docs |
| `src/mcp/resources.js` | None |
| `src/daemon/services/state.js` | None |
| `src/daemon/services/ydotool.js` | **KEEP** for fallback |
| `bin/br.js` | None |
| `src/cli/` | None (all HTTP to daemon) |

---

## Rollback / Safety

1. **Fallback mode**: mantener `BR_FORCE_YDOTOOL=1` para revertir a ydotool si Camoufox falla
2. **Profile dir**: `~/.br-profile` se mantiene — Firefox también usa perfil persistente
3. **Git**: cambios en rama `feat/camoufox-migration`, no tocar `main` hasta aprobación

---

## Verification Checklist

- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] `br start` launches Camoufox (no Chrome)
- [ ] `br goto http://localhost:3030/test` works
- [ ] `br yclick 1` clicks element (via Playwright, not ydotool)
- [ ] `br view-tree` shows elements
- [ ] `br observe` works
- [ ] `br screenshot` works
- [ ] MCP tools (`browser://observe`, `browser://status`) work
- [ ] Test on bot detection site
- [ ] `--force-ydotool` fallback works
