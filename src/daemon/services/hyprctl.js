const util = require('util');
const execAsync = util.promisify(require('child_process').exec);

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

module.exports = { getChromiumWindowPos, focusChromiumWindow, getCursorPos };
