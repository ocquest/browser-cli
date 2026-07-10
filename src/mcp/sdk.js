const path = require('path');
const { createRequire } = require('module');

const wrongPkg = require.resolve('@modelcontextprotocol/sdk/package.json');
const sdkRoot = path.resolve(wrongPkg, '../../..');
const sdkReq = createRequire(path.join(sdkRoot, 'package.json'));

const { McpServer, ResourceTemplate } = sdkReq('./dist/cjs/server/mcp.js');
const { StdioServerTransport } = sdkReq('./dist/cjs/server/stdio.js');

module.exports = { McpServer, ResourceTemplate, StdioServerTransport };
