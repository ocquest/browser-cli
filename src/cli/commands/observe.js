const { send } = require('../send');

module.exports = function (program) {
  program
    .command('observe')
    .description('Get a structured snapshot of the current page: URL, title, interactive elements, visible text. Replaces view-tree/view-html/scroll eval patterns.')
    .action(async () => {
      try {
        const raw = await send('/observe');
        const data = JSON.parse(raw);
        console.log('URL:', data.url);
        console.log('Title:', data.title);
        console.log('Viewport:', data.viewport.width + 'x' + data.viewport.height);
        console.log('Scroll:', data.scrollY + '/' + data.scrollH);
        console.log('--- Interactive elements ---');
        for (const el of data.interactive.slice(0, 60)) {
          const tag = el.tag + (el.role ? '[' + el.role + ']' : '');
          const loc = el.inViewport ? '' : ' [off-screen]';
          const label = el.label ? ': ' + el.label : '';
          const href = el.href ? ' (' + el.href.substring(0, 60) + ')' : '';
          console.log('  [' + el.id + '] ' + tag + label + href + loc);
        }
        if (data.interactive.length > 60) console.log('  ... and ' + (data.interactive.length - 60) + ' more');
        console.log('--- Visible text (first 2000 chars) ---');
        console.log(data.text.substring(0, 2000));
      } catch (error) {
        console.error('Error observing page:', error);
      }
    });
};