const { Command } = require('commander');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function register(program) {
  program
    .command('mcp')
    .description('Start the MCP server (stdio mode for opencode, or --http for remote)')
    .option('--http', 'Run in Streamable HTTP mode instead of stdio')
    .option('--port <port>', 'Port for HTTP mode (default: 3031)', parseInt)
    .action(async (options) => {
      const scriptPath = path.join(__dirname, '..', '..', '..', 'mcp-server.js');
      const args = [];
      if (options.http) args.push('--http');
      if (options.port) args.push('--port', String(options.port));

      console.log('Starting MCP server...');

      const child = spawn(process.execPath, [scriptPath, ...args], {
        stdio: ['inherit', 'inherit', 'inherit'],
        detached: false,
        env: { ...process.env }
      });

      child.on('error', (err) => {
        console.error('Failed to start MCP server:', err.message);
        process.exit(1);
      });

      child.on('exit', (code) => {
        console.log(`MCP server exited with code ${code}`);
        process.exit(code || 0);
      });

      process.on('SIGINT', () => {
        child.kill('SIGINT');
      });

      process.on('SIGTERM', () => {
        child.kill('SIGTERM');
      });
    });
}

module.exports = { register };
