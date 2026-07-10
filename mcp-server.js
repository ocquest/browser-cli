#!/usr/bin/env node

const { McpServer, StdioServerTransport } = require('./src/mcp/sdk');
const BrowserManager = require('./src/mcp/browser');
const tools = require('./src/mcp/tools');
const resources = require('./src/mcp/resources');
const prompts = require('./src/mcp/prompts');
const os = require('os');
const path = require('path');
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  const pidFile = path.join(os.tmpdir(), 'mcp.pid');
  fs.writeFileSync(pidFile, String(process.pid));

  const state = require('./src/daemon/services/state');

  const browser = new BrowserManager();
  await browser.launch();

  const pkg = require('./package.json');
  const server = new McpServer({
    name: 'browser-cli',
    version: pkg.version
  }, {
    capabilities: { tools: {}, resources: {}, prompts: {} }
  });

  tools.register(server, browser);
  resources.register(server, browser);
  prompts.register(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await browser.close();
    try { fs.unlinkSync(pidFile); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('MCP server error:', err);
  process.exit(1);
});
