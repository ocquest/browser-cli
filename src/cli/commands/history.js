const { send } = require('../send');

module.exports = function (program) {
  program
    .command('history')
    .alias('hist')
    .description('Display the history of actions performed in the current session.')
    .action(async () => {
      try {
        const hist = await send('/history');
        console.log(hist);
      } catch (error) {
        console.error('Error viewing history:', error);
      }
    });

  program
    .command('clear-history')
    .description("Clear the session's action history.")
    .action(async () => {
      try {
        await send('/history/clear', 'POST');
        console.log('History cleared.');
      } catch (error) {
        console.error('Error clearing history:', error);
      }
    });
};
