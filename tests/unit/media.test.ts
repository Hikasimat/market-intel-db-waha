import { describe, it, expect } from 'vitest';
import { resolveMediaBuffer } from '../../src/engine/media.js';

describe('Media Resolver', () => {
  it('should resolve base64 encoded data to Buffer with correct mimetype and extension', async () => {
    // Base64 of a 1x1 transparent PNG
    const base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const resolved = await resolveMediaBuffer({
      data: base64Png,
      mimetype: 'image/png',
      filename: 'pixel',
    });

    expect(Buffer.isBuffer(resolved.buffer)).toBe(true);
    expect(resolved.buffer.length).toBeGreaterThan(0);
    expect(resolved.mimetype).toBe('image/png');
    expect(resolved.filename).toBe('pixel.png');
  });

  it('should throw an error if neither data nor url is provided', async () => {
    await expect(resolveMediaBuffer({})).rejects.toThrow('Either "file.url" or "file.data" must be provided');
  });
});
