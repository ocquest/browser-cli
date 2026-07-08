const { send } = require('../send');

module.exports = function (program) {
  program
    .command('tabs')
    .description('List all open tabs (pages) in the browser daemon.')
    .action(async () => {
      try {
        const tabs = JSON.parse(await send('/tabs'));
        tabs.forEach(tab => {
          console.log(`${tab.isActive ? '*' : ' '}${tab.index}: ${tab.title} (${tab.url})`);
        });
      } catch (error) {
        console.error('Error listing tabs:', error);
      }
    });

  program
    .command('switch-tab')
    .description('Switch to a different open tab by its index.')
    .argument('<index>', 'The index of the tab to switch to.')
    .alias('go-tab')
    .action(async (index) => {
      try {
        await send('/tabs/switch', 'POST', { index: Number(index) });
        console.log('Switched to tab', index);
      } catch (error) {
        console.error('Error switching tab:', error);
      }
    });

  program
    .command('close-tab')
    .description('Close an open tab by its index.')
    .argument('<index>', 'The index of the tab to close.')
    .action(async (index) => {
      try {
        await send('/tabs/close', 'POST', { index: Number(index) });
        console.log('Closed tab', index);
      } catch (error) {
        console.error('Error closing tab:', error);
      }
    });
};
