const util = require('util');
const execAsync = util.promisify(require('child_process').exec);

const BROWSER_CLASSES = ['chromium-browser', 'google-chrome', 'chrome', 'Chromium', 'Google-chrome'];

function findBrowserWindow(clients) {
  const lower = c => c.class.toLowerCase();
  return clients.find(c => BROWSER_CLASSES.includes(lower(c)));
}

async function getChromiumWindowPos() {
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

async function focusChromiumWindow() {
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

module.exports = { getChromiumWindowPos, focusChromiumWindow, getCursorPos };
