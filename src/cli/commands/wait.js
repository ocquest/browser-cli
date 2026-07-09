const { send } = require('../send');

module.exports = function (program) {
  program
    .command('wait')
    .description('Wait for a page condition. Replaces manual sleep. Usage: wait networkidle | wait selector <css> | wait <ms>')
    .argument('<type>', '"networkidle", "selector <css>", or a number (milliseconds)')
    .argument('[arg]', 'CSS selector if type is "selector"')
    .action(async (type, arg) => {
      try {
        const body = {};
        if (type === 'networkidle') {
          body.type = 'networkidle';
        } else if (type === 'selector') {
          body.type = 'selector';
          body.arg = arg;
        } else {
          body.type = 'timeout';
          body.ms = parseInt(type) || 1000;
        }
        await send('/wait', 'POST', body);
        if (body.type === 'networkidle') console.log('Waited for network idle');
        else if (body.type === 'selector') console.log('Waited for selector:', arg);
        else console.log('Waited', body.ms, 'ms');
      } catch (error) {
        console.error('Error waiting:', error);
      }
    });
};