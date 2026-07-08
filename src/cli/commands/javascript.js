const { send } = require('../send');

module.exports = function (program) {
  program
    .command('eval')
    .description('Evaluate JavaScript code in the browser page.')
    .argument('<code>', 'JavaScript code to evaluate.')
    .action(async (code) => {
      try {
        const parsed = JSON.parse(await send('/evaluate', 'POST', { code }));
        const result = parsed.result;
        if (result === undefined) {
          console.log('undefined');
        } else {
          console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
        }
      } catch (error) {
        console.error('Error evaluating code:', error);
      }
    });

  program
    .command('is-clickable')
    .description('Check if an element is clickable or covered by another element (e.g. a modal or cookie banner).')
    .argument('<selectorOrId>', 'CSS selector or node ID for the target element.')
    .action(async (selector) => {
      try {
        const result = JSON.parse(await send('/is-clickable', 'POST', { selector }));
        if (result.clickable) {
          console.log('\u2713 Element is clickable');
        } else {
          console.log('\u2717 Not clickable:', result.reason || 'unknown');
          if (result.covered) {
            console.log('  Covered by: <' + result.coveringTag + (result.coveringId ? '#' + result.coveringId : '') + '>');
            if (result.coveringText) console.log('  Cover text: "' + result.coveringText + '"');
          }
        }
      } catch (error) {
        console.error('Error checking clickable:', error);
      }
    });
};
