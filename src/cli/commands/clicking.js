const { send } = require('../send');

module.exports = function (program) {
  program
    .command('click')
    .description('Click an element using Playwright (detectable — fallback).')
    .argument('<selectorOrId>', 'The CSS selector or node ID for the element to click.')
    .action(async (selector) => {
      try {
        await send('/click', 'POST', { selector });
        console.log('Clicked', selector);
      } catch (error) {
        console.error('Error clicking element:', error);
      }
    });

  program
    .command('yclick')
    .description('Click an element using ydotool with natural mouse movement (undetectable).')
    .argument('<selectorOrId>', 'Node ID from view-tree (e.g. "22"), or CSS/XPath selector.')
    .action(async (selector) => {
      try {
        await send('/yclick', 'POST', { selector });
        console.log('yclicked', selector);
      } catch (error) {
        console.error('Error yclicking element:', error);
      }
    });

  program
    .command('ydrag')
    .description('Drag from one element to another using ydotool (mousedown to move to mouseup).')
    .argument('<fromSelector>', 'Node ID or selector for the source (draggable) element.')
    .argument('<toSelector>', 'Node ID or selector for the target (drop zone) element.')
    .action(async (from, to) => {
      try {
        await send('/ydrag', 'POST', { from, to });
        console.log('dragged from', from, 'to', to);
      } catch (error) {
        console.error('Error dragging:', error);
      }
    });

  program
    .command('calibrate')
    .description('Calibrate the ydotool click offset.')
    .action(async () => {
      try {
        const result = await send('/calibrate');
        const parsed = JSON.parse(result);
        console.log(JSON.stringify(parsed, null, 2));
      } catch (error) {
        console.error('Error calibrating:', error);
      }
    });
};
