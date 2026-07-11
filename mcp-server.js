#!/usr/bin/env node

const { McpServer, StdioServerTransport } = require('./src/mcp/sdk');
const BrowserManager = require('./src/mcp/browser');
const tools = require('./src/mcp/tools');
const resources = require('./src/mcp/resources');
const prompts = require('./src/mcp/prompts');
const os = require('os');
const path = require('path');
const fs = require('fs');
const util = require('util');
const execAsync = util.promisify(require('child_process').exec);
const { spawn } = require('child_process');

async function ensureYdotoold() {
  try {
    await execAsync('pgrep ydotoold');
    return;
  } catch {}
  const trySpawn = (cmd, args) => {
    return new Promise((resolve) => {
      const child = spawn(cmd, args || [], { detached: true, stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.unref();
      setTimeout(() => resolve(true), 500);
    });
  };
  const ok = await trySpawn('ydotoold') || await trySpawn('sudo', ['ydotoold']);
  if (!ok) {
    console.error('Warning: could not start ydotoold. ydotool commands will fail.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const pidFile = path.join(os.tmpdir(), 'mcp.pid');
  fs.writeFileSync(pidFile, String(process.pid));

  const state = require('./src/daemon/services/state');

  await ensureYdotoold();

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
