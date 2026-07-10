# AGENTS.md — @browsemake/browser-cli

## Quick start
```bash
npm install                               # no build step needed
sudo ydotoold &                           # needs /dev/uinput access, or via ACL
alias br="node $PWD/bin/br.js"
br start                                  # launches headful Chromium + Express on :3030
```

## Architecture
- **`bin/br.js`** — Thin entry point, delegates to `src/cli/index.js`.
- **`src/cli/`** — CLI commands organized in modules under `commands/`. Uses `Commander.js`, sends HTTP to daemon on `localhost:3030`.
- **`daemon.js`** — Express server running a persistent Chromium via `playwright-extra` + stealth plugin. Uses `chromium.launchPersistentContext`. Top-level async IIFE.
- **`src/daemon/services/`** — Shared services: `state.js` (history, secrets, calibration, ID→XPath), `hyprctl.js` (Hyprland window management), `ydotool.js` (mouse simulation with natural movement).
- **Sub-30 second start**: daemon writes PID to `daemon.pid`, CLI waits for `"br daemon running"` on stdout with a 5s timeout.

## Commands (all require running daemon)

### Primary methods (ydotool — undetectable, recommended)
| Command | Note |
|---------|------|
| `br yclick <id>` | **RECOMMENDED** — ydotool system-level click (undetectable); IDs come from `view-tree`. Automatically detects and dismisses cookie banners / modals before clicking. |
| `br ydrag <fromId> <toId>` | ydotool drag-and-drop |
| `br calibrate` | auto-calibrate ydotool click offset |

### Fallback methods (Playwright — detectable, use only if ydotool fails)
| Command | Note |
|---------|------|
| `br click <selectorOrId>` | FALLBACK — Playwright click (detectable) |
| `br fill <selector> <text>` | form fill |
| `br fill-secret <selector> <ENV_VAR>` | reads secret from env var, masks in HTML output |
| `br type <selector> <text>` | character-by-character typing |
| `br press <key>` | key press (e.g. `Enter`) |

### Other commands
| Command | Note |
|---------|------|
| `br start` / `br stop` | daemon lifecycle |
| `br goto <url>` | navigate |
| `br view-tree [--role --tag --match --max-depth --only-matches]` | accessibility/DOM tree with numeric node IDs |
| `br eval <code>` | JS in page context |
| `br view-html [--page N]` | paginated HTML (5KB chunks) |
| `br screenshot [--base64]` | saves PNG to tmp, or `--base64` for base64 output |
| `br screenshot-element <selector> [--margin N] [--base64]` | element screenshot with margin (default 10px) |
| `br tabs` / `br switch-tab <index>` / `br go-tab <index>` / `br close-tab <index>` | tab management |
| `br fullscreen` | `requestFullscreen()` API, falls back to F11 |
| `br scrollIntoView <selector>` / `br scrollTo <pct>` / `br nextChunk` / `br prevChunk` | scrolling |
| `br history` / `br clear-history` | action history |
| `br llm <prompt>` | send text prompt to configured LLM |
| `br solve-slide-captcha` | attempt to solve a slide captcha using LLM vision + ydotool drag |
| `br start --api-key <key>` | start daemon with LLM API key (also via `BR_LLM_API_KEY` env var) |

`selectorOrId` params accept either a CSS selector **or** a numeric node ID from `view-tree`. The daemon resolves IDs to XPath internally.

## Key details
- **ydotool**: screen pixel coords are **divided by 2** before passing to ydotool. Left click = `0xC0`. Mouse down = `0x40`. Mouse up = `0x80`.
- **Auto-dismiss blockers**: Before every `yclick`, the daemon checks if the element is covered by a modal/cookie banner and automatically tries to dismiss it.
- **Hyprland-specific**: uses `hyprctl` for window focus, cursor position, and window geometry.
- **New tabs** are automatically set as active.
- **`fill-secret`** expects an **env var name** (not the secret value directly). Values are masked in `view-html`.
- **Proxy**: daemon reads `HTTP_PROXY`/`HTTPS_PROXY` env vars and passes proxy config to Chromium automatically (including auth).
- **Anti-detection**: uses `--disable-automation`, `--disable-blink-features=AutomationControlled`, and `context.addInitScript` to hide automation from bot detection.
- **Tests**: `npm test` runs all tests via Node's built-in test runner. Tests for `state.js`, `ydotool.js`, `hyprctl.js`, and CLI `send.js` are in `test/`. No external test dependencies.
- **Lint**: `npm run lint` — syntax checks all source files (no ESLint/Prettier/TypeScript).
- **CI**: pushes to `main` auto-bump patch version and publish to npm (`@browsemake/browser-cli`). Weekly GitHub Release. Don't manually bump `version` in `package.json`.
- **CommonJS** (`"type": "commonjs"`). Node 18+.
- **nodemon-style hot reload** is not configured; restart `br stop && br start` after edits.

## Test page
`http://localhost:3030/test` — interactive page with buttons, inputs, drag-drop, event log.

## MCP Server (for AI coding tools)

The project includes an **MCP server** (`mcp-server.js`) that exposes all browser automation as MCP tools via stdio transport. Configure in your AI tool's `opencode.json`:

```jsonc
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

All tools are prefixed with `browser-cli_` (e.g. `browser-cli_browser_navigate`, `browser-cli_browser_click`). Resources are available at `browser://status`, `browser://html`, `browser://screenshot`, `browser://observe`, `browser://tabs`.

## AI agent guide
See [docs/ai-guide.md](docs/ai-guide.md) for instructions on how AI agents should use `br` — read calmly, plan, then act.
