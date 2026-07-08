# br — Browser CLI

System-level browser automation using Playwright + ydotool for undetectable mouse events on Wayland/Hyprland.

## Requirements

- **Wayland** compositor (Hyprland recommended)
- **ydotool** (`/usr/bin/ydotool`) with `ydotoold` running
- **hyprctl** (part of Hyprland)
- **Node.js** 18+

## Setup

```bash
# Install dependencies
npm install

# Make CLI available
node bin/br.js <command>
```

### ydotool Setup

```bash
# Start daemon (needs /dev/uinput access)
sudo ydotoold &

# Or run as user with ACL:
sudo setfacl -m u:$USER:rw /dev/uinput
ydotoold &
```

## Commands

### Daemon Lifecycle

| Command | Description |
|---------|-------------|
| `br start` | Start the browser daemon |
| `br stop` | Stop the daemon gracefully |
| `br goto <url>` | Navigate active tab to URL |

### Clicking

| Command | Description |
|---------|-------------|
| `br yclick <id>` | **RECOMMENDED** — Click via ydotool (undetectable system-level) |
| `br click <selector>` | FALLBACK — Click via Playwright (detectable, use if yclick fails) |

`yclick` uses **natural mouse movement**:
- Linear path from current cursor position
- Ease-in-out acceleration/deceleration
- ±1.2px random jitter per step
- Variable step count and delay based on distance
- Scrolls element into view first

### Drag & Drop

| Command | Description |
|---------|-------------|
| `br ydrag <fromId> <toId>` | **RECOMMENDED** — Drag element A to element B via ydotool |

Uses `ydotool click 0x40` (mousedown) → natural move → `ydotool click 0x80` (mouseup).

### Fullscreen

| Command | Description |
|---------|-------------|
| `br fullscreen` | Enter browser fullscreen mode |

Calls `document.documentElement.requestFullscreen()` first, falls back to F11 key press.

### Page Interaction

| Command | Description |
|---------|-------------|
| `br eval <code>` | Execute JavaScript in page context |
| `br type <selector> <text>` | Type text character by character |
| `br fill <selector> <text>` | Fill form field |
| `br press <key>` | Press keyboard key |
| `br screenshot [--base64]` | Capture page screenshot (PNG or base64) |
| `br screenshot-element <selector> [--margin N] [--base64]` | Capture element screenshot with margin |

### Navigation & View

| Command | Description |
|---------|-------------|
| `br view-tree [options]` | Show accessibility/DOM tree |
| `br view-html` | Show page HTML source |
| `br tabs` | List open tabs |
| `br switch-tab <index>` | Switch to tab by index |

`view-tree` options:
- `--role <roles>` — Filter by ARIA roles (comma-separated)
- `--tag <tags>` — Filter by HTML tags
- `--match <text>` — Filter by text content
- `--max-depth <depth>` — Limit tree depth
- `--only-matches` — Show only matching nodes

### Calibration

| Command | Description |
|---------|-------------|
| `br calibrate` | Auto-calibrate ydotool click offset |

Navigates to calibration grid (5×5 cells), clicks corners + center via ydotool, computes offset. In fullscreen mode, offset is always `{x:0, y:0}`.

### Other

| Command | Description |
|---------|-------------|
| `br scrollIntoView <selector>` | Scroll element into view |
| `br scrollTo <percentage>` | Scroll to page percentage |
| `br history` | Show action history |
| `br clear-history` | Clear history |
| `br nextChunk` | Scroll down one viewport height |
| `br prevChunk` | Scroll up one viewport height |

## Architecture

```
CLI (bin/br.js)  ←→  Daemon (daemon.js)  ←→ Chromium (Playwright)
                         ↕
                    hyprctl + ydotool
                    (system-level input)
```

The daemon runs as an Express server on port 3030. The CLI sends HTTP requests to it.

### ydotool Coordinate System

- Screen pixel coords are divided by 2 for ydotool (observed scaling factor)
- Left click: `ydotool click 0xC0` (hex 0xC0 = LEFT + DOWN + UP)
- Mouse down: `ydotool click 0x40`
- Mouse up: `ydotool click 0x80`
- Absolute move: `ydotool mousemove --absolute -x <x> -y <y>`

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/tabs` | List tabs |
| POST | `/tabs/switch` | Switch tab |
| POST | `/goto` | Navigate to URL |
| POST | `/element-box` | Get element bounding box |
| POST | `/yclick` | System-level click |
| POST | `/evaluate` | Execute JS |
| GET | `/html` | Page HTML |
| GET | `/source` | Page source |
| POST | `/view-tree` | Accessibility tree |
| POST | `/xpath-for-id` | Get XPath by node ID |
| POST | `/fullscreen` | Enter fullscreen |
| GET | `/screenshot?base64=true` | Page screenshot (PNG file or base64) |
| POST | `/screenshot-element` | Element screenshot with margin |
| GET | `/test` | Test page with interactive elements |
| GET | `/calibrate-page` | Calibration grid HTML |
| GET | `/calibrate` | Run calibration |
| POST | `/ydrag` | Drag and drop |

### Test Page

Navigate to `http://localhost:3030/test` for an interactive test page with:
- Buttons (with click counter)
- Text/email/password inputs
- Textarea and select dropdown
- Checkboxes and radio buttons
- Drag & drop elements
- Event log
