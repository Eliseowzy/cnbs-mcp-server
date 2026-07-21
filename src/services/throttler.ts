// src/services/throttler.ts
// Request throttler with concurrency control and minimum interval enforcement.
import { createLogger } from '../logger.js';

const log = createLogger('throttler');

export class CnbsRequestThrottler {
  private taskQueue: Array<() => Promise<unknown>> = [];
  private active = 0;
  private maxConcurrent = 3;
  private minInterval = 300;
  private lastExecutionTime = 0;
  private isPaused = false;
  private pauseReason?: string;

  constructor(settings?: {
    maxConcurrent?: number;
    minInterval?: number;
  }) {
    this.maxConcurrent = settings?.maxConcurrent || 3;
    this.minInterval = settings?.minInterval || 300;
  }

  async execute<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.taskQueue.push(async () => {
        try {
          if (this.isPaused) {
            throw new Error(`Throttler is paused: ${this.pauseReason || 'Unknown reason'}`);
          }

          const now = Date.now();
          const scheduled = Math.max(now, this.lastExecutionTime + this.minInterval);
          this.lastExecutionTime = scheduled;
          if (scheduled > now) {
            await new Promise(resolve => setTimeout(resolve, scheduled - now));
          }

          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.active--;
          this.processQueue();
        }
      });

      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.isPaused) {
      return;
    }

    while (this.taskQueue.length > 0 && this.active < this.maxConcurrent) {
      const task = this.taskQueue.shift();
      if (task) {
        this.active++;
        task();
      }
    }
  }

  pause(reason?: string): void {
    this.isPaused = true;
    this.pauseReason = reason;
    log.warn({ reason }, 'Throttler paused');
  }

  resume(): void {
    this.isPaused = false;
    this.pauseReason = undefined;
    log.info('Throttler resumed');
    this.processQueue();
  }

  getStatus(): {
    queueSize: number;
    active: number;
    maxConcurrent: number;
    isPaused: boolean;
    pauseReason?: string;
  } {
    return {
      queueSize: this.taskQueue.length,
      active: this.active,
      maxConcurrent: this.maxConcurrent,
      isPaused: this.isPaused,
      pauseReason: this.pauseReason,
    };
  }

  clearQueue(): void {
    this.taskQueue = [];
    log.info('Throttler queue cleared');
  }

  setMaxConcurrent(maxConcurrent: number): void {
    if (maxConcurrent > 0) {
      this.maxConcurrent = maxConcurrent;
      log.info({ maxConcurrent }, 'Throttler max concurrent updated');
      this.processQueue();
    }
  }

  setMinInterval(minInterval: number): void {
    if (minInterval >= 0) {
      this.minInterval = minInterval;
      log.info({ minInterval }, 'Throttler min interval updated');
    }
  }
}

// Global throttler singleton
export const cnbsRequestThrottler = new CnbsRequestThrottler({
  maxConcurrent: 5,
  minInterval: 200,
});
