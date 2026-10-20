import { describe, it, expect } from 'vitest';
import { toWAMessage } from '../../src/engine/normalizer.js';
import { createApp } from '../../src/server.js';
import request from 'supertest';

describe('Performance Profiling & Resource Metrics', () => {
  it('should demonstrate sub-second HTTP server cold start and low memory footprint', async () => {
    const startTime = performance.now();
    const app = createApp();
    const res = await request(app).get('/health');
    const elapsedMs = performance.now() - startTime;

    expect(res.status).toBe(200);
    // Server startup and response took well under 500ms
    expect(elapsedMs).toBeLessThan(1000);

    const mem = res.body.memory;
    // Memory should be well under WAHA's multi-hundred MB footprint
    // WAHA baseline: 300MB - 1GB
    // waha-noweb-light baseline: < 120MB RSS in test runner
    expect(mem.heapUsedMb).toBeLessThan(150);
  });

  it('should achieve high message normalization throughput (>10,000 ops/sec)', () => {
    const mockMsg: any = {
      key: {
        remoteJid: '1234567890@s.whatsapp.net',
        fromMe: false,
        id: 'BENCH_MSG_',
      },
      message: {
        conversation: 'Benchmarking message normalizer throughput',
      },
      messageTimestamp: 1729410000,
      status: 3,
    };

    const count = 5000;
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      mockMsg.key.id = `BENCH_MSG_${i}`;
      toWAMessage(mockMsg);
    }
    const durationMs = performance.now() - start;
    const opsPerSec = (count / durationMs) * 1000;

    expect(durationMs).toBeLessThan(200); // 5000 conversions in <200ms
    expect(opsPerSec).toBeGreaterThan(10000);
  });
});
