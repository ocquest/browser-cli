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

  // Random waypoint for curved path (quadratic bezier)
  const midX = (start.x + targetX) / 2 + (Math.random() - 0.5) * dist * 0.6;
  const midY = (start.y + targetY) / 2 + (Math.random() - 0.5) * dist * 0.6;

  const steps = Math.max(8, Math.min(40, Math.round(dist / 20)));

  for (let i = 1; i <= steps; i++) {
    let t = i / steps;
    // Quadratic bezier: (1-t)²·P0 + 2(1-t)·t·P1 + t²·P2
    const px = (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * midX + t * t * targetX + rand(-1.2, 1.2);
    const py = (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * midY + t * t * targetY + rand(-1.2, 1.2);
    const ydoX = Math.round(px / 2);
    const ydoY = Math.round(py / 2);
    await execAsync(`ydotool mousemove --absolute -x ${ydoX} -y ${ydoY}`);
    const phase = Math.abs(t - 0.5) * 2;
    const delay = Math.round(rand(3, 8) + phase * rand(3, 10));
    await new Promise(r => setTimeout(r, delay));
  }
}

module.exports = { naturalMouseMove, lerp, rand };
