const { send } = require('../send');

module.exports = function (program) {
  program
    .command('fullscreen')
    .description('Enter browser fullscreen mode via requestFullscreen() API.')
    .action(async () => {
      try {
        await send('/fullscreen', 'POST');
        console.log('Entered fullscreen mode.');
      } catch (error) {
        console.error('Error entering fullscreen:', error);
      }
    });
};
