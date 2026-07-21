import { CircuitBreaker, CircuitState, getCircuitBreaker, getAllCircuitStats } from '../services/circuit-breaker';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test', {
      failureThreshold: 3,
      resetTimeout: 100,
      halfOpenMax: 2,
    });
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should allow execution when CLOSED', () => {
      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe('state transitions', () => {
    it('should transition to OPEN after failure threshold', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.recordFailure(); // 3rd failure hits threshold
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should reject execution when OPEN', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      expect(breaker.canExecute()).toBe(false);
    });

    it('should transition to HALF_OPEN after reset timeout', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      await new Promise(r => setTimeout(r, 150));
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('should allow limited execution in HALF_OPEN', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise(r => setTimeout(r, 150));
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
      expect(breaker.canExecute()).toBe(true);
    });

    it('should recover to CLOSED after successful HALF_OPEN attempts', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise(r => setTimeout(r, 150));
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      breaker.recordSuccess();
      breaker.recordSuccess(); // halfOpenMax = 2
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should trip back to OPEN on failure in HALF_OPEN', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise(r => setTimeout(r, 150));
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('execute', () => {
    it('should execute function and return result when CLOSED', async () => {
      const result = await breaker.execute(async () => 'success');
      expect(result).toBe('success');
    });

    it('should throw when circuit is OPEN', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await expect(
        breaker.execute(async () => 'should not run'),
      ).rejects.toThrow('Circuit breaker "test" is OPEN');
    });

    it('should record failure when function throws', async () => {
      await expect(
        breaker.execute(async () => { throw new Error('fail'); }),
      ).rejects.toThrow('fail');

      expect(breaker.getStats().failures).toBe(1);
    });

    it('should reset failure count on success in CLOSED state', async () => {
      breaker.recordFailure();
      breaker.recordFailure();

      await breaker.execute(async () => 'ok');
      expect(breaker.getStats().failures).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return current statistics', () => {
      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
    });
  });
});

describe('Circuit Breaker Registry', () => {
  it('should return the same breaker for the same name', () => {
    const b1 = getCircuitBreaker('registry-test');
    const b2 = getCircuitBreaker('registry-test');
    expect(b1).toBe(b2);
  });

  it('should return different breakers for different names', () => {
    const b1 = getCircuitBreaker('breaker-a');
    const b2 = getCircuitBreaker('breaker-b');
    expect(b1).not.toBe(b2);
  });

  it('should aggregate stats from all breakers', () => {
    const stats = getAllCircuitStats();
    expect(typeof stats).toBe('object');
  });
});
