import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { compressTokenImage, downloadTokenImage, imageMime, onchainTokenImage, publicImageIp } from './tokenImage.js';

describe('token image cache', () => {
  it('recognizes image bytes and rejects HTML responses', () => {
    expect(imageMime(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('image/png');
    expect(imageMime(Buffer.from('<html>not an image</html>'))).toBeNull();
  });

  it('rejects a blocked host before fetching', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await downloadTokenImage('https://127.0.0.1/private')).toBeNull();
      expect(await downloadTokenImage('https://[::1]/private')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });

  it('accepts only public DNS addresses for external image hosts', () => {
    expect(publicImageIp('8.8.8.8')).toBe(true);
    expect(publicImageIp('127.0.0.1')).toBe(false);
    expect(publicImageIp('169.254.169.254')).toBe(false);
    expect(publicImageIp('::ffff:127.0.0.1')).toBe(false);
    expect(publicImageIp('::1')).toBe(false);
  });

  it('caches only an actual image even when a server reports success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      fetchMock.mockResolvedValueOnce(new Response('<html>blocked</html>', { status: 200, headers: { 'content-type': 'image/png' } }));
      expect(await downloadTokenImage('https://genius.fun/api/image?src=test')).toBeNull();
      fetchMock.mockResolvedValueOnce(new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), { status: 200 }));
      const image = await downloadTokenImage('https://genius.fun/api/image?src=test');
      expect(image).toBeNull();
    } finally { fetchMock.mockRestore(); }
  });

  it('tries another IPFS gateway when the first serves corrupt artwork', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f2cc52' } }).png().toBuffer();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      fetchMock.mockResolvedValueOnce(new Response(Buffer.from([255, 216, 255]), { status: 200 }));
      fetchMock.mockResolvedValueOnce(new Response(png, { status: 200 }));
      const image = await downloadTokenImage('https://flap.mypinata.cloud/ipfs/bafkreibvcilgl2johr2xq4uifh2e6todmuy6tafvdppq4neq3dipzu67oe');
      expect(image).not.toBeNull();
      expect(image?.url).toContain('gateway.pinata.cloud');
      expect((await sharp(image!.data).metadata()).width).toBe(8);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { fetchMock.mockRestore(); }
  });

  it('resizes an oversized Flap PNG before caching it', async () => {
    const png = await sharp(randomBytes(1024 * 1024 * 3), {
      raw: { width: 1024, height: 1024, channels: 3 },
    }).png().toBuffer();
    expect(png.length).toBeGreaterThan(2 * 1024 * 1024);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      fetchMock.mockResolvedValueOnce(new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } }));
      const image = await downloadTokenImage('https://flap.mypinata.cloud/ipfs/bafybeieyh36w5af7unxi3jzhznqw7btqdxchkqauhcmlgpukqemnuqovse');
      expect(image?.mime).toBe('image/webp');
      expect(image?.data.length).toBeLessThan(2 * 1024 * 1024);
      const metadata = await sharp(image!.data).metadata();
      expect(metadata.width).toBe(192);
      expect(metadata.height).toBe(192);
    } finally { fetchMock.mockRestore(); }
  });

  it('renders an oversized animated logo as a compact first frame', async () => {
    const gif = await sharp(randomBytes(1024 * 1024 * 3 * 3), {
      raw: { width: 1024, height: 3072, pageHeight: 1024, channels: 3 },
    }).gif({ effort: 1, dither: 0 }).toBuffer();
    expect(gif.length).toBeGreaterThan(2 * 1024 * 1024);
    const image = await compressTokenImage({ url: 'https://flap.sh/large.gif', data: gif, mime: 'image/gif' });
    expect(image?.mime).toBe('image/webp');
    expect((await sharp(image!.data).metadata()).width).toBe(192);
    expect(image!.data.length).toBeLessThan(2 * 1024 * 1024);
  }, 15000);

  it('compresses ordinary token art while keeping transparent pixels', async () => {
    const rgba = randomBytes(256 * 256 * 4);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = ((i - 3) / 4) % 2 ? 255 : 0;
    const png = await sharp(rgba, { raw: { width: 256, height: 256, channels: 4 } }).png().toBuffer();
    const image = await compressTokenImage({ url: 'https://flap.sh/example.png', data: png, mime: 'image/png' });
    expect(image?.mime).toBe('image/webp');
    expect(image!.data.length).toBeLessThan(png.length);
    const metadata = await sharp(image!.data).metadata();
    expect(metadata.width).toBe(192);
    expect(metadata.hasAlpha).toBe(true);
  });

  it('decodes Brew on-chain artwork without accepting a mismatched data URI', async () => {
    const source = 'onchain://56/0xe84481a12e9404bc644948e589acd33600b677fa';
    const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f2cc52' } }).jpeg().toBuffer();
    expect(await onchainTokenImage(source, `data:image/jpeg;base64,${jpeg.toString('base64')}`)).not.toBeNull();
    expect(await onchainTokenImage(source, 'data:image/jpeg;base64,PGh0bWw+')).toBeNull();
    expect(await onchainTokenImage('onchain://1/0xe84481a12e9404bc644948e589acd33600b677fa', `data:image/jpeg;base64,${jpeg.toString('base64')}`)).toBeNull();
  });
});
