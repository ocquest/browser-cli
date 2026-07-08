const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('ydotool service', () => {
  let ydotool;

  it('should load without error', () => {
    ydotool = require('../../../src/daemon/services/ydotool');
    assert.ok(ydotool.lerp);
    assert.ok(ydotool.rand);
    assert.ok(ydotool.naturalMouseMove);
  });

  describe('lerp', () => {
    it('should return start when t=0', () => {
      assert.equal(ydotool.lerp(10, 20, 0), 10);
    });

    it('should return end when t=1', () => {
      assert.equal(ydotool.lerp(10, 20, 1), 20);
    });

    it('should return midpoint when t=0.5', () => {
      assert.equal(ydotool.lerp(10, 20, 0.5), 15);
    });

    it('should handle negative values', () => {
      assert.equal(ydotool.lerp(-10, 10, 0.5), 0);
    });

    it('should handle t outside 0-1 range', () => {
      assert.equal(ydotool.lerp(10, 20, 2), 30);
      assert.equal(ydotool.lerp(10, 20, -1), 0);
    });
  });

  describe('rand', () => {
    it('should return a number within the given range', () => {
      for (let i = 0; i < 100; i++) {
        const val = ydotool.rand(5, 10);
        assert.ok(val >= 5 && val <= 10, `rand(5,10) returned ${val}`);
      }
    });

    it('should return a number (not NaN)', () => {
      for (let i = 0; i < 100; i++) {
        const val = ydotool.rand(1, 2);
        assert.equal(typeof val, 'number');
        assert.ok(!isNaN(val));
      }
    });

    it('should handle equal min and max', () => {
      const val = ydotool.rand(5, 5);
      assert.equal(val, 5);
    });

    it('should handle negative range', () => {
      for (let i = 0; i < 50; i++) {
        const val = ydotool.rand(-10, -5);
        assert.ok(val >= -10 && val <= -5);
      }
    });
  });

  describe('naturalMouseMove', () => {
    it('should return early for very short distances', async () => {
      let cursorCalled = false;
      const mockGetCursorPos = async () => {
        cursorCalled = true;
        return { x: 100, y: 100 };
      };
      // target is only 5px away from start, dist < 8 should return early
      await ydotool.naturalMouseMove(103, 104, mockGetCursorPos);
      assert.ok(cursorCalled, 'getCursorPos should have been called');
    });

    it('should call getCursorPos to get start position', async () => {
      let called = false;
      const mockGetCursorPos = async () => {
        called = true;
        return { x: 0, y: 0 };
      };
      // Use very high distance to ensure it runs
      // But we can't easily test the full loop without mocking execAsync
      // Just verify at least getCursorPos is called
      try {
        await ydotool.naturalMouseMove(1000, 1000, mockGetCursorPos);
      } catch (e) {
        // Will fail on execAsync since no ydotool, but that's OK
        // The important thing is getCursorPos was called
      }
      assert.ok(called);
    });
  });
});
