const util = require('util');
const execAsync = util.promisify(require('child_process').exec);

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function rand(a, b) {
  return a + Math.random() * (b - a);
}

async function naturalMouseMove(targetX, targetY, getCursorPos) {
  const start = await getCursorPos();
  const dx = targetX - start.x;
  const dy = targetY - start.y;
  const dist = Math.sqrt(dy * dy + dx * dx);
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

module.exports = { naturalMouseMove, lerp, rand };
