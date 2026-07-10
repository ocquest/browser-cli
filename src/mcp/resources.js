let _browser;

function register(server, browser) {
  _browser = browser;

  server.registerResource(
    'browser://status',
    {
      name: 'browser-status',
      description: 'Current page status: URL, title, scroll position, viewport, and detected modals',
      mimeType: 'application/json'
    },
    async (uri) => {
      const page = browser.getActivePage();
      if (!page) {
        return { contents: [{ uri, text: JSON.stringify({ error: 'No active page' }) }] };
      }
      const info = await browser.getPageInfo(page);
      return { contents: [{ uri, text: JSON.stringify(info) }] };
    }
  );

  server.registerResource(
    'browser://html',
    {
      name: 'browser-html',
      description: 'Full HTML source of the current page',
      mimeType: 'text/html'
    },
    async (uri) => {
      const page = browser.getActivePage();
      if (!page) {
        return { contents: [{ uri, text: 'No active page' }] };
      }
      const html = await page.content();
      return { contents: [{ uri, text: html }] };
    }
  );

  server.registerResource(
    'browser://screenshot',
    {
      name: 'browser-screenshot',
      description: 'Full page screenshot as PNG',
      mimeType: 'image/png'
    },
    async (uri) => {
      const page = browser.getActivePage();
      if (!page) {
        return { contents: [] };
      }
      const buffer = await page.screenshot({ type: 'png' });
      return {
        contents: [{
          uri,
          mimeType: 'image/png',
          blob: buffer.toString('base64')
        }]
      };
    }
  );

  server.registerResource(
    'browser://observe',
    {
      name: 'browser-observe',
      description: 'Structured page snapshot: URL, title, viewport, interactive elements, visible text, and modals',
      mimeType: 'application/json'
    },
    async (uri) => {
      const page = browser.getActivePage();
      if (!page) {
        return { contents: [{ uri, text: JSON.stringify({ error: 'No active page' }) }] };
      }
      const result = await browser.observe(page);
      return { contents: [{ uri, text: JSON.stringify(result) }] };
    }
  );

  server.registerResource(
    'browser://tabs',
    {
      name: 'browser-tabs',
      description: 'List of open tabs with index, title, URL, and active status',
      mimeType: 'application/json'
    },
    async (uri) => {
      const tabs = await browser.getTabInfo();
      return { contents: [{ uri, text: JSON.stringify(tabs) }] };
    }
  );
}

module.exports = { register };
