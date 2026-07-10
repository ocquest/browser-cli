<p align="center">
  <img width="full" src="https://github.com/user-attachments/assets/ac1cd9e3-f811-4af7-9338-7d6d0c80fcd7" />
</p>


<h1 align="center">Browser CLI </h1>

<div align="center">
  
  [![Discord](https://img.shields.io/discord/1391101800052035714?color=7289DA&label=Discord&logo=discord&logoColor=white)](https://discord.gg/N7crMvEX)
  [![Twitter Follow](https://img.shields.io/twitter/follow/browse_make?style=social)](https://x.com/intent/user?screen_name=browse_make)
  
</div>

`br` is a command line tool used by any capable LLM agent, like ChatGPT, [Claude Code](https://github.com/anthropics/claude-code) or [Gemini CLI](https://github.com/google-gemini/gemini-cli).

https://www.npmjs.com/package/@browsemake/browser-cli

## ⚠️ Vital: Usa subagentes para ahorrar tokens

Las sesiones largas con múltiples interacciones consumen muchos tokens de contexto.
**Es crítico delegar tareas complejas a subagentes** para mantener el contexto principal
ligero. El patrón recomendado:

```
1. El agente principal recibe la tarea del usuario
2. El agente principal lanza un subagente que ejecuta la secuencia de comandos br
3. El subagente completa toda la navegación y devuelve solo el resultado final
4. El agente principal presenta el resultado y queda disponible para la siguiente tarea
```

Esto reduce drásticamente el uso de tokens y evita que la ventana de contexto se sature
con el historial de navegación. Usa la herramienta `task` para lanzar subagentes.

## Why Broswer CLI?
- **Just works**: simply browser automation, coding not required, leave the rest workflow to the most powerful LLM agent
- **AI first**: designed for LLM agent, readable view from HTML, and error hint
- **Secure**: can be run locally, no credential passed to LLM 
- **Robust**: browser persisted progress across session, and track history action for replay

## Install

### Global (npm)
```bash
npm install -g @browsemake/browser-cli
```

### Local (clone)
```bash
git clone https://github.com/browsemake/browser-cli.git
cd browser-cli
npm install
alias br="node $PWD/bin/br.js"   # temporal, o añade a ~/.bashrc

# Opcional: registrar el binario local globalmente
npm link
```

## Usage
Type instruction to AI agent (Gemini CLI / Claude Code / ChatGPT):

```
> You have browser automation tool 'br', use it to go to amazon to buy me a basketball
```

Use command line directly by human:

```bash
br start
br goto https://github.com/
```

## Demos

Grocery (Go to Amazon and buy me a basketball)
<div align="center">
    <a href="https://www.loom.com/share/b7aeba65bb0b4c4bb5bbef9b59b4b9dc">
      <img style="max-width:300px;" src="https://github.com/user-attachments/assets/3cd46b9a-6ef9-4987-a952-fcd22890334c">
    </a>
</div>

Navigate to GitHub repo:
<div align="center">
    <a href="https://www.loom.com/share/0ef198e259864ae08afa9ae9f78acfac">
      <img style="max-width:300px;" src="https://cdn.loom.com/sessions/thumbnails/0ef198e259864ae08afa9ae9f78acfac-3e42df07f2040874-full-play.gif">
    </a>
</div>


Print invoice

Download bank account statement

Search for job posting

## Features
- **Browser Action**: Comprehensive action for browser automation (navigation, click, etc.)
- **LLM friendly output**: LLM friendly command output with error correction hint
- **Daemon mode**: Always-on daemon mode so it lives across multiple LLM sessions
- **Structured web page view**: Accessibility tree view for easier LLM interpretation than HTML
- **Secret management**: Secret management to isolate password from LLM
- **History tracking**: History tracking for replay and scripting

## Command

### Start the daemon
```bash
br start
```
If starting the daemon fails (for example due to missing Playwright browsers),
the CLI prints the error output so you can diagnose the issue.

### Navigate to a URL
```bash
br goto https://example.com
```

### Click an element (RECOMMENDED — undetectable)

```bash
br yclick 22
```

Uses **ydotool** (system-level mouse events) instead of Playwright's synthetic clicks.
The mouse movement is undetectable by bot detection systems.

Features:
- **Natural movement**: linear path with ease-in-out acceleration, random jitter (±1.2px), variable speed
- **Scrolls into view** automatically before clicking
- **Node ID based**: use the numeric ID from `br view-tree` output
- **Fullscreen required**: works best after `br fullscreen` to eliminate browser chrome offset

### Click an element (FALLBACK — detectable)

```bash
br click "button.submit"
```

Only use this if `yclick` fails. Playwright clicks are detectable by bot detection.

Commands that accept a CSS selector (like `click`, `fill`, `scrollIntoView`, `type`) can also accept a numeric ID. These IDs are displayed in the output of `br view-tree` and allow for direct interaction with elements identified in the tree.

### ydotool system-level click (RECOMMENDED — undetectable)

```bash
br yclick 22
```

Clicks an element using **ydotool** (system-level mouse events) instead of
Playwright's synthetic clicks. The mouse movement is undetectable by bot
detection systems because it uses real OS-level input.

Features:
- **Natural movement**: linear path with ease-in-out acceleration,
  random jitter (±1.2px), and variable speed
- **Scrolls into view** automatically before clicking
- **Node ID based**: use the numeric ID from `br view-tree` output
- **Fullscreen required**: works best after `br fullscreen` to eliminate
  browser chrome offset

### Click an element (FALLBACK — detectable)

```bash
br click "button.submit"
```

Only use this if `yclick` fails. Playwright clicks are detectable by bot detection systems.

### Speed commands: single round-trip pipelines

`br chain` ejecuta múltiples acciones en una sola petición HTTP. Cada acción
se separa con `|`. Soporta todas las acciones principales.

**Ejemplos:**

```bash
# Tres clics, una sola petición (ideal para navegación rápida)
br chain "yclick 22 | yclick 35 | yclick 12"

# Buscar producto y añadirlo al carrito
br chain "fill #search arroz | press Enter | wait 2000 | yclick 162"

# Información + screenshot en un paso
br chain "eval document.title | screenshot | observe"

# Scroll y clic
br chain "scrollIntoView #footer | yclick 45"

# Pipeline completo: navegar, esperar, rellenar, hacer clic, observar
br chain "goto https://example.com | wait networkidle | fill #q hello | press Enter | wait 3000 | observe"
```

La respuesta incluye un snapshot `observe` final con todos los elementos
interactivos, texto visible, y resultados de cada paso.

### Fullscreen mode

```bash
br fullscreen
```

Enters browser fullscreen via `requestFullscreen()` API. Eliminates
browser chrome offset entirely, making `yclick` coordinates accurate.

### Drag & drop (RECOMMENDED — undetectable)

```bash
br ydrag <fromNodeId> <toNodeId>
```

System-level drag and drop using ydotool. Example:
```bash
br view-tree --only-matches  # find node IDs
br ydrag 37 38               # drag element 37 to drop zone 38
```

### Calibration

```bash
br calibrate
```

Auto-calibrates the ydotool click offset by navigating to a calibration
grid, clicking 5 test points (corners + center), and computing the offset.

### Scroll element into view

```bash
br scrollIntoView "#footer"
```

### Scroll to percentage of page

```bash
br scrollTo 50
```

### Fill an input field

```bash
br fill "input[name='q']" "search text"
```

### Fill an input field with a secret

```bash
MY_SECRET="top-secret" br fill-secret "input[name='password']" MY_SECRET
```

When retrieving page HTML with `br view-html`, any text provided via
`fill-secret` is masked to avoid exposing secrets.

### Type text into an input

```bash
br type "input[name='q']" "search text"
```

### Press a key

```bash
br press Enter
```

### Scroll next/previous chunk

```bash
br nextChunk
br prevChunk
```

### View page HTML

```bash
br view-html
```

### View action history

```bash
br history
```

### Clear action history

```bash
br clear-history
```

### Capture a screenshot

```bash
br screenshot
br screenshot --base64
```

### Capture a screenshot of an element

```bash
br screenshot-element "#btn-1"
br screenshot-element "#btn-1" --margin 20
br screenshot-element "#btn-1" --margin 10 --base64
```

Screenshots an element by CSS selector or node ID with optional margin padding (default 10px). Use `--base64` to get base64 output instead of saving to a temp file.

### View accessibility and DOM tree

```bash
br view-tree
```

Outputs a hierarchical tree combining accessibility roles with DOM element
information. It also builds an ID-to-XPath map for quick element lookup.

### List open tabs

```bash
br tabs
```

### Switch to a tab by index

```bash
br switch-tab 1
br go-tab 1     # alias for switch-tab
```

### Close a tab by index

```bash
br close-tab 1
```

### Stop the daemon

```bash
br stop
```

### Test page

The daemon includes a test page at `http://localhost:3030/test` with
buttons, inputs, checkboxes, radios, drag-and-drop, and an event log.

## Local development

```bash
git clone <repo>
cd browser-cli
npm install
alias br="node $PWD/bin/br.js"
br start
```

See [docs/usage.md](docs/usage.md) for full documentation.

---

## MCP Server (for AI coding tools)

Use `browser-cli` as an **MCP server** directly from AI coding tools like **opencode**, **Claude Desktop**, **Cursor**, or **Claude Code**. The server exposes all browser automation capabilities as MCP tools, resources, and prompts.

### Setup

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "browser-cli": {
      "type": "local",
      "command": ["node", "/path/to/browser-cli/mcp-server.js"],
      "enabled": true
    }
  }
}
```

### What you get

Once configured, the AI can use all browser tools directly:

| Tool | Purpose |
|------|---------|
| `browser-cli_browser_navigate` | Go to any URL |
| `browser-cli_browser_observe` | Get page snapshot (interactive elements, text, modals) |
| `browser-cli_browser_click` | Click elements via ydotool (undetectable) |
| `browser-cli_browser_fill` | Fill form fields |
| `browser-cli_browser_type` | Type text with human-like behavior |
| `browser-cli_browser_screenshot` | Take page screenshots |
| `browser-cli_browser_solve_slide_captcha` | Solve slide captchas |
| `browser-cli_browser_evaluate` | Execute JavaScript |
| `browser-cli_browser_view_tree` | Get DOM tree with IDs |
| `browser-cli_browser_drag` | Drag & drop via ydotool |
| And 20+ more... | |

### Resources

| URI | Description |
|-----|-------------|
| `browser://status` | Current page status (URL, title, scroll, modals) |
| `browser://html` | Full page HTML |
| `browser://screenshot` | Page screenshot (PNG) |
| `browser://observe` | Structured page snapshot |
| `browser://tabs` | Open tabs list |

### CLI

```bash
# Start MCP server in stdio mode (for opencode, Claude Desktop)
br mcp

# Start MCP server in HTTP mode (for remote clients)
br mcp --http --port 3031
```

### Requirements

- Linux with Hyprland (for ydotool + hyprctl)
- Chrome installed (`channel: 'chrome'`)
- Node.js 18+
