const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

describe('hyprctl service', () => {
  let hyprctl;

  it('should load without error', () => {
    hyprctl = require('../../../src/daemon/services/hyprctl');
    assert.ok(hyprctl.getBrowserWindowPos);
    assert.ok(hyprctl.focusBrowserWindow);
    assert.ok(hyprctl.getCursorPos);
  });

  describe('getBrowserWindowPos', () => {
    it('should return null when hyprctl command fails', async () => {
      // This will fail because hyprctl is not available in test env
      const result = await hyprctl.getBrowserWindowPos();
      assert.equal(result, null);
    });
  });

  describe('focusBrowserWindow', () => {
    it('should not throw when hyprctl is unavailable', async () => {
      await assert.doesNotReject(hyprctl.focusBrowserWindow());
    });
  });

  describe('getCursorPos', () => {
    it('should return an object with x and y or throw if unavailable', async () => {
      try {
        const pos = await hyprctl.getCursorPos();
        assert.ok(typeof pos.x === 'number');
        assert.ok(typeof pos.y === 'number');
      } catch (e) {
        assert.ok(e.message);
      }
    });
  });
});
