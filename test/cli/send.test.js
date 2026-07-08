const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

describe('send module', () => {
  let mod;

  it('should load without error', () => {
    mod = require('../../src/cli/send');
    assert.ok(mod.send);
    assert.ok(mod.getRunningPid);
    assert.equal(mod.PORT, 3030);
  });

  it('should export expected functions', () => {
    assert.equal(typeof mod.send, 'function');
    assert.equal(typeof mod.getRunningPid, 'function');
  });

  it('getRunningPid should return null when no pid file', () => {
    const result = mod.getRunningPid();
    assert.equal(result, null);
  });

  it('send should reject with daemon not running message on ECONNREFUSED', async () => {
    await assert.rejects(
      mod.send('/health'),
      /Daemon is not running/
    );
  });
});
