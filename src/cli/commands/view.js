const { send } = require('../send');

module.exports = function (program) {
  program
    .command('view-html')
    .description('Output the full HTML source of the current page (paginated, 5000 chars per page).')
    .option('-p, --page <number>', 'Page number to view', '1')
    .action(async (opts) => {
      try {
        const page = Number(opts.page) || 1;
        const html = await send(`/html?page=${page}`);
        if (html.length === 0) {
          console.log('No HTML content found for this page.');
          return;
        }
        const PAGE_SIZE = 5000;
        const totalPages = Math.ceil(html.length / PAGE_SIZE);
        const start = (page - 1) * PAGE_SIZE;
        const end = start + PAGE_SIZE;
        const chunk = html.slice(start, end);
        console.log(chunk);
        console.log(`\n--- Page ${page} of ${totalPages} ---`);
        if (totalPages > 1) {
          console.log('Use --page <n> to view a different page.');
        }
        if (html.length > PAGE_SIZE) {
          console.log('Hint: If the HTML is too large to view comfortably, try the "view-tree" command for a structured overview.');
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
