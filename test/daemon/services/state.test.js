const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

describe('state service', () => {
  let state;

  beforeEach(() => {
    state = require('../../../src/daemon/services/state');
    state.resetAll();
  });

  describe('history', () => {
    it('should start empty', () => {
      assert.equal(state.getHistory().length, 0);
    });

    it('should record actions with timestamp', () => {
      state.record('test-action', { foo: 'bar' });
      const hist = state.getHistory();
      assert.equal(hist.length, 1);
      assert.equal(hist[0].action, 'test-action');
      assert.deepEqual(hist[0].args, { foo: 'bar' });
      assert.ok(hist[0].timestamp);
      assert.ok(hist[0].timestamp.endsWith('Z'));
    });

    it('should record multiple actions in order', () => {
      state.record('first');
      state.record('second');
      state.record('third');
      const hist = state.getHistory();
      assert.equal(hist.length, 3);
      assert.equal(hist[0].action, 'first');
      assert.equal(hist[1].action, 'second');
      assert.equal(hist[2].action, 'third');
    });

    it('should clear history', () => {
      state.record('a');
      state.record('b');
      assert.equal(state.getHistory().length, 2);
      state.clearHistory();
      assert.equal(state.getHistory().length, 0);
    });

    it('should record without args', () => {
      state.record('no-args');
      assert.deepEqual(state.getHistory()[0].args, {});
    });
  });

  describe('secrets', () => {
    it('should add and mask secrets in text', () => {
      state.addSecret('my-secret-password');
      const masked = state.maskSecrets('The password is my-secret-password');
      assert.equal(masked, 'The password is ***');
    });

    it('should mask multiple occurrences', () => {
      state.addSecret('token123');
      const masked = state.maskSecrets('token123 and token123 again');
      assert.equal(masked, '*** and *** again');
    });

    it('should mask multiple different secrets', () => {
      state.addSecret('secret1');
      state.addSecret('secret2');
      const masked = state.maskSecrets('secret1 and secret2');
      assert.equal(masked, '*** and ***');
    });

    it('should return text unchanged if no secrets match', () => {
      const text = 'Hello world';
      assert.equal(state.maskSecrets(text), text);
    });

    it('should handle empty text', () => {
      assert.equal(state.maskSecrets(''), '');
    });

    it('should handle secret that is substring of another', () => {
      state.addSecret('abcdef');
      state.addSecret('abc');
      const result = state.maskSecrets('prefix abc and abcdef suffix');
      // Longer match wins when added first (order matters: exact match found first)
      assert.equal(result, 'prefix *** and *** suffix');
    });
  });

  describe('calibration offset', () => {
    it('should start at zero', () => {
      const offset = state.getCalibrationOffset();
      assert.deepEqual(offset, { x: 0, y: 0 });
    });

    it('should return a copy, not a reference', () => {
      const offset1 = state.getCalibrationOffset();
      offset1.x = 100;
      const offset2 = state.getCalibrationOffset();
      assert.equal(offset2.x, 0);
    });

    it('should set and get calibration offset', () => {
      state.setCalibrationOffset({ x: 10, y: 20 });
      const offset = state.getCalibrationOffset();
      assert.deepEqual(offset, { x: 10, y: 20 });
    });

    it('should store a copy of the set value', () => {
      const orig = { x: 5, y: 15 };
      state.setCalibrationOffset(orig);
      orig.x = 999;
      assert.equal(state.getCalibrationOffset().x, 5);
    });
  });

  describe('idToXPath mapping', () => {
    it('should set and get XPath by ID', () => {
      state.setIdToXPath({ 1: '/html/body/div[1]', 2: '/html/body/div[2]' });
      assert.equal(state.getXPathForId(1), '/html/body/div[1]');
      assert.equal(state.getXPathForId(2), '/html/body/div[2]');
    });

    it('should return undefined for unknown ID', () => {
      assert.equal(state.getXPathForId(999), undefined);
    });

    it('resolveSelector should return selector unchanged for non-numeric', () => {
      assert.equal(state.resolveSelector('#my-button'), '#my-button');
      assert.equal(state.resolveSelector('.some-class'), '.some-class');
      assert.equal(state.resolveSelector('button'), 'button');
      assert.equal(state.resolveSelector('xpath=/html/body'), 'xpath=/html/body');
    });

    it('resolveSelector should convert numeric ID to XPath', () => {
      state.setIdToXPath({ 42: '/html/body/div[3]/button[1]' });
      assert.equal(state.resolveSelector('42'), '/html/body/div[3]/button[1]');
    });

    it('resolveSelector should throw if numeric ID not found', () => {
      state.setIdToXPath({});
      assert.throws(() => state.resolveSelector('999'), /XPath not found/);
    });

    it('resolveSelector should handle string numbers', () => {
      state.setIdToXPath({ 7: '/html/body/p[2]' });
      assert.equal(state.resolveSelector('7'), '/html/body/p[2]');
    });
  });
});
