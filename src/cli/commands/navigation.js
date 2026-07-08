const { send } = require('../send');

module.exports = function (program) {
  program
    .command('goto')
    .description('Navigate the browser to a specific URL.')
    .argument('<url>', 'The full URL to navigate to (e.g., "https://example.com").')
    .action(async (url) => {
      try {
        await send('/goto', 'POST', { url });
        console.log('Navigated to', url);
      } catch (error) {
        console.error('Error navigating:', error);
      }
    });

  program
    .command('scrollIntoView')
    .description('Scroll the page until a specific element is in view.')
    .argument('<selectorOrId>', 'The CSS selector or node ID for the target element.')
    .action(async (selector) => {
      try {
        await send('/scroll-into-view', 'POST', { selector });
        console.log('Scrolled', selector, 'into view.');
      } catch (error) {
        console.error('Error scrolling into view:', error);
      }
    });

  program
    .command('scrollTo')
    .description('Scroll the page to a given percentage of its total height.')
    .argument('<percentage>', 'A number from 0 to 100.')
    .action(async (percentage) => {
      try {
        await send('/scroll-to', 'POST', { percentage });
        console.log(`Scrolled to ${percentage}%.`);
      } catch (error) {
        console.error('Error scrolling:', error);
      }
    });

  program
    .command('nextChunk')
    .description('Scroll down by one viewport height to view the next chunk of content.')
    .action(async () => {
      try {
        await send('/next-chunk', 'POST');
        console.log('Scrolled to the next chunk.');
      } catch (error) {
        console.error('Error scrolling to next chunk:', error);
      }
    });

  program
    .command('prevChunk')
    .description('Scroll up by one viewport height to view the previous chunk of content.')
    .action(async () => {
      try {
        await send('/prev-chunk', 'POST');
        console.log('Scrolled to the previous chunk.');
      } catch (error) {
        console.error('Error scrolling to previous chunk:', error);
      }
    });
};
