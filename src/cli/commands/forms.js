const { send } = require('../send');

module.exports = function (program) {
  program
    .command('fill')
    .description('Fill a form field with the provided text.')
    .argument('<selectorOrId>', 'The CSS selector or node ID for the input field.')
    .argument('<text>', 'The text to fill the field with.')
    .action(async (selector, text) => {
      try {
        const res = await send('/fill', 'POST', { selector, text });
        const data = JSON.parse(res);
        const status = data.verified ? '✓ verified' : '✗ not verified';
        console.log('Filled', selector, `(${status})`);
      } catch (error) {
        console.error('Error filling field:', error);
      }
    });

  program
    .command('fill-secret')
    .description('Fill a form field with a value from a specified environment variable. The value is masked in logs.')
    .argument('<selectorOrId>', 'The CSS selector or node ID for the input field.')
    .argument('<envVar>', 'The name of the environment variable containing the secret.')
    .action(async (selector, envVar) => {
      const secret = process.env[envVar];
      if (!secret) {
        console.error(`Error: Environment variable "${envVar}" is not set.`);
        return;
      }
      try {
        await send('/fill-secret', 'POST', { selector, secret });
        console.log('Filled secret value into', selector);
      } catch (error) {
        console.error('Error filling secret field:', error);
      }
    });

  program
    .command('type')
    .description('Simulate typing text into a form field, character by character.')
    .argument('<selectorOrId>', 'The CSS selector or node ID for the input field.')
    .argument('<text>', 'The text to type into the field.')
    .action(async (selector, text) => {
      try {
        await send('/type', 'POST', { selector, text });
        console.log('Typed text into', selector);
      } catch (error) {
        console.error('Error typing into field:', error);
      }
    });

  program
    .command('press')
    .description("Simulate a single key press (e.g., 'Enter', 'Tab').")
    .argument('<key>', "The key to press, as defined in Playwright's documentation.")
    .action(async (key) => {
      try {
        await send('/press', 'POST', { key });
        console.log('Pressed', key);
      } catch (error) {
        console.error('Error pressing key:', error);
      }
    });
};
