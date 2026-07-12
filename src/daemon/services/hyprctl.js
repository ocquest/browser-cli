const util = require('util');
const execAsync = util.promisify(require('child_process').exec);

const BROWSER_CLASSES = ['firefox', 'firefox-esr', 'Mozilla Firefox', 'camoufox'].map(c => c.toLowerCase());

function findBrowserWindow(clients) {
  const lower = c => c.class.toLowerCase();
  return clients.find(c => BROWSER_CLASSES.includes(lower(c)));
}

async function getBrowserWindowPos() {
  try {
    const { stdout } = await execAsync('hyprctl clients -j');
    const clients = JSON.parse(stdout);
    const win = findBrowserWindow(clients);
    if (!win) return null;
    return { x: win.at[0], y: win.at[1], width: win.size[0], height: win.size[1] };
  } catch (err) {
    return null;
  }
}

async function focusBrowserWindow() {
  try {
    const { stdout } = await execAsync('hyprctl clients -j');
    const clients = JSON.parse(stdout);
    const win = findBrowserWindow(clients);
    if (win) {
      await execAsync('hyprctl dispatch focuswindow class:' + win.class);
    }
  } catch (_) {}
}

async function getCursorPos() {
  const { stdout } = await execAsync('hyprctl cursorpos');
  const parts = stdout.trim().split(',').map(Number);
  return { x: parts[0], y: parts[1] };
}

module.exports = { getBrowserWindowPos, focusBrowserWindow, getCursorPos };
