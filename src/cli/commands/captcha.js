const { send } = require('../send');

module.exports = function (program) {
  program
    .command('solve-slide-captcha')
    .description('Attempt to solve a slide captcha on the current page using LLM vision + ydotool drag.')
    .option('-b, --background <selector>', 'CSS selector for the background image element')
    .option('-t, --tile <selector>', 'CSS selector for the puzzle tile element')
    .option('-s, --slider <selector>', 'CSS selector for the slider track element')
    .option('-r, --retry <count>', 'Number of retries on failure (default: 2)')
    .action(async (opts) => {
      try {
        const body = {};
        if (opts.background) body.backgroundSelector = opts.background;
        if (opts.tile) body.tileSelector = opts.tile;
        if (opts.slider) body.trackSelector = opts.slider;
        if (opts.retry) body.retries = parseInt(opts.retry, 10);
        const result = JSON.parse(await send('/solve-slide-captcha', 'POST', body));
        if (result.attempts) {
          for (const a of result.attempts) {
            const method = a.details?.method || 'llm';
            console.log('--- Attempt [' + method + '] target: ' + a.targetX + 'px ---');
            console.log('  Dragged:', Math.round(a.fromX), Math.round(a.fromY), '\u2192', Math.round(a.toX), Math.round(a.toY));
            console.log('  Verified:', a.verified ? '\u2713' : '\u2717');
            if (!a.verified) console.log('  Header: "' + (a.details?.headerText || '') + '", snappedBack:', a.details?.snappedBack);
          }
        } else {
          console.log('LLM analysis:', result.llmAnalysis);
          console.log('Target X offset:', result.targetX);
          console.log('Dragged from:', result.dragFrom?.x, result.dragFrom?.y, 'to:', result.dragTo?.x, result.dragTo?.y);
        }
        if (result.verified) {
          console.log('\u2713 Captcha solved successfully!');
        } else if (result.success) {
          console.log('\u2717 Captcha NOT verified after ' + (result.attempts?.length || 1) + ' attempt(s)');
        }
      } catch (error) {
        console.error('Error solving captcha:', error);
      }
    });
};
