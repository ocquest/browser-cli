const { program } = require('commander');

require('./commands/daemon')(program);
require('./commands/navigation')(program);
require('./commands/clicking')(program);
require('./commands/forms')(program);
require('./commands/view')(program);
require('./commands/screenshots')(program);
require('./commands/tabs')(program);
require('./commands/javascript')(program);
require('./commands/fullscreen')(program);
require('./commands/llm')(program);
require('./commands/captcha')(program);
require('./commands/history')(program);

const origHelp = program.helpInformation.bind(program);
program.helpInformation = function () {
  const lines = origHelp().split('\n');
  const others = [];
  const primary = [];
  const emergency = [];
  let inCommands = false;
  for (const line of lines) {
    if (line.trim().startsWith('Commands:')) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (!line.trim()) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('yclick') || trimmed.startsWith('ydrag') || trimmed.startsWith('calibrate')) {
      primary.push('  ' + trimmed);
    } else if (trimmed.startsWith('click') || trimmed.startsWith('fill') || trimmed.startsWith('fill-secret') || trimmed.startsWith('type') || trimmed.startsWith('press')) {
      emergency.push('  ' + trimmed);
    } else {
      others.push('  ' + trimmed);
    }
  }
  const header = lines.slice(0, lines.findIndex(l => l.trim().startsWith('Commands:'))).join('\n');
  const out = [header, '', 'Commands:', ''];
  if (primary.length) {
    out.push('  Primary methods (ydotool — undetectable, recommended):');
    out.push(...primary);
    out.push('');
  }
  if (others.length) {
    out.push('  Other commands:');
    out.push(...others);
    out.push('');
  }
  if (emergency.length) {
    out.push('  Fallback methods (Playwright — detectable, use if ydotool fails):');
    out.push(...emergency);
    out.push('');
  }
  return out.join('\n');
};

try {
  program.parse();
} catch (err) {
  if (err.code === 'commander.unknownOption') {
    console.log();
    program.outputHelp();
  }
}