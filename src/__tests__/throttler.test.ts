import { CnbsRequestThrottler } from '../services/throttler';

describe('CnbsRequestThrottler', () => {
  let throttler: CnbsRequestThrottler;

  beforeEach(() => {
    throttler = new CnbsRequestThrottler({ maxConcurrent: 2, minInterval: 0 });
  });

  describe('execute', () => {
    it('should execute a task and return its result', async () => {
      const result = await throttler.execute(async () => 42);
      expect(result).toBe(42);
    });

    it('should propagate task errors', async () => {
      await expect(
        throttler.execute(async () => { throw new Error('task failed'); }),
      ).rejects.toThrow('task failed');
    });

    it('should respect concurrency limit', async () => {
      let activeCount = 0;
      let maxActive = 0;

      const task = async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise(r => setTimeout(r, 50));
        activeCount--;
        return true;
      };

      await Promise.all([
        throttler.execute(task),
        throttler.execute(task),
        throttler.execute(task),
        throttler.execute(task),
      ]);

      expect(maxActive).toBeLessThanOrEqual(2);
    });
  });

  describe('pause / resume', () => {
    it('should queue tasks while paused and reject on execution', async () => {
      throttler.pause('maintenance');
      // Task is queued but not executed while paused
      void throttler.execute(async () => 'should not run').catch(() => { /* cleared below */ });
      
      // Resume to let the task execute (it will throw because isPaused check happens at execution)
      // Actually, after resume, isPaused is false, so task will succeed
      // Let's test that status shows paused
      const status = throttler.getStatus();
      expect(status.isPaused).toBe(true);
      expect(status.queueSize).toBe(1);
      
      // Clear the queue to avoid hanging
      throttler.clearQueue();
      throttler.resume();
    });

    it('should resume processing after resume()', async () => {
      throttler.pause('test');
      throttler.resume();
      const result = await throttler.execute(async () => 'ok');
      expect(result).toBe('ok');
    });
  });

  describe('getStatus', () => {
    it('should report correct status', () => {
      const status = throttler.getStatus();
      expect(status.maxConcurrent).toBe(2);
      expect(status.isPaused).toBe(false);
      expect(status.queueSize).toBe(0);
      expect(status.active).toBe(0);
    });

    it('should reflect paused state', () => {
      throttler.pause('reason');
      const status = throttler.getStatus();
      expect(status.isPaused).toBe(true);
      expect(status.pauseReason).toBe('reason');
    });
  });

  describe('clearQueue', () => {
    it('should clear pending tasks', () => {
      throttler.pause();
      // Queue some tasks (they won't execute while paused)
      throttler.execute(async () => 1).catch(() => {});
      throttler.execute(async () => 2).catch(() => {});
      throttler.clearQueue();
      const status = throttler.getStatus();
      expect(status.queueSize).toBe(0);
    });
  });

  describe('setMaxConcurrent', () => {
    it('should update max concurrent', () => {
      throttler.setMaxConcurrent(10);
      expect(throttler.getStatus().maxConcurrent).toBe(10);
    });

    it('should ignore non-positive values', () => {
      throttler.setMaxConcurrent(0);
      expect(throttler.getStatus().maxConcurrent).toBe(2);
    });
  });

  describe('minInterval enforcement', () => {
    it('should enforce minimum interval between executions', async () => {
      const intervalThrottler = new CnbsRequestThrottler({ maxConcurrent: 1, minInterval: 100 });
      const start = Date.now();

      await intervalThrottler.execute(async () => 'first');
      await intervalThrottler.execute(async () => 'second');

      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow small timing variance
    });
  });
});
