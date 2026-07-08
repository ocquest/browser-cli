const { send } = require('../send');

module.exports = function (program) {
  program
    .command('screenshot')
    .description('Capture a screenshot of the current page. Saves to a temp file by default, or use --base64 for base64 output.')
    .option('-b, --base64', 'Output the image as a base64-encoded string')
    .action(async (opts) => {
      try {
        const query = opts.base64 ? '?base64=true' : '';
        const result = await send('/screenshot' + query);
        if (opts.base64) {
          console.log(result);
        } else {
          console.log('Screenshot saved to:', result);
        }
      } catch (error) {
        console.error('Error taking screenshot:', error);
      }
    });

  program
    .command('screenshot-element')
    .description('Capture a screenshot of a specific element with optional margin padding.')
    .argument('<selectorOrId>', 'CSS selector or node ID for the target element.')
    .option('-m, --margin <pixels>', 'Margin padding around the element in pixels', '10')
    .option('-b, --base64', 'Output the image as a base64-encoded string')
    .action(async (selector, opts) => {
      try {
        const body = { selector, margin: parseInt(opts.margin) };
        if (opts.base64) body.base64 = true;
        const result = await send('/screenshot-element', 'POST', body);
        if (opts.base64) {
          console.log(result);
        } else {
          console.log('Screenshot saved to:', result);
        }
      } catch (error) {
        console.error('Error taking element screenshot:', error);
      }
    });
};
