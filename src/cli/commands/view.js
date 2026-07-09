const { send } = require('../send');

module.exports = function (program) {
  program
    .command('view-html')
    .description('Output HTML source. Use --page for paginated view, or --offset/--limit for range (like cat).')
    .option('-p, --page <number>', 'Page number (5000 chars per page)')
    .option('-o, --offset <number>', 'Character offset to start from')
    .option('-l, --limit <number>', 'Max characters to return')
    .action(async (opts) => {
      try {
        const page = Number(opts.page) || 0;
        const offset = Number(opts.offset) || 0;
        const limit = Number(opts.limit) || 0;
        let html;
        if (opts.page) {
          html = await send(`/html?offset=${(page - 1) * 5000}&limit=5000`);
          if (html.length === 0) {
            console.log('No HTML content found for this page.');
            return;
          }
          console.log(html);
          console.log(`\n--- Page ${page} ---`);
        } else {
          const qs = offset || limit ? `?offset=${offset}&limit=${limit}` : '';
          html = await send('/html' + qs);
          console.log(html);
          if (html.length === 0) console.log('(empty)');
        }
      } catch (error) {
        console.error('Error viewing HTML:', error);
      }
    });

  program
    .command('view-tree')
    .description("Display a hierarchical tree of the page's accessibility and DOM nodes.")
    .option('-r, --role <roles>', 'Filter by ARIA roles (comma-separated, e.g. "button,link,heading")')
    .option('-t, --tag <tags>', 'Filter by HTML tags (comma-separated, e.g. "a,button,input")')
    .option('-m, --match <text>', 'Filter by name text (case-insensitive substring match)')
    .option('-d, --max-depth <depth>', 'Maximum tree depth to display')
    .option('-o, --only-matches', 'Show only matching nodes (hide ancestor context)')
    .action(async (opts) => {
      try {
        const body = {};
        if (opts.role) body.role = opts.role;
        if (opts.tag) body.tag = opts.tag;
        if (opts.match) body.match = opts.match;
        if (opts.maxDepth) body.maxDepth = parseInt(opts.maxDepth);
        if (opts.onlyMatches) body.onlyMatches = true;
        const tree = await send('/view-tree', 'POST', body);
        try {
          const parsed = JSON.parse(tree);
          console.log(parsed.tree || tree);
        } catch {
          console.log(tree);
        }
      } catch (error) {
        console.error('Error viewing tree:', error);
      }
    });
};
