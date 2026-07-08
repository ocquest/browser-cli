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

try {
  program.parse();
} catch (err) {
  if (err.code === 'commander.unknownOption') {
    console.log();
    program.outputHelp();
  }
}
