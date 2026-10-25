/** Disposable local replay QA receiver. Never bind it to an external interface. */
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const output = path.resolve('.cache/fresh/vertical'); await mkdir(output, { recursive: true });
const allowedOrigin = value => !value || /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(value);
const server = http.createServer(async (request, response) => {
  if (!allowedOrigin(request.headers.origin)) { response.writeHead(403).end(); return; }
  response.setHeader('Access-Control-Allow-Origin', request.headers.origin ?? 'http://127.0.0.1:5173');
  response.setHeader('Vary', 'Origin'); response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  const files = { '/metrics': ['render-metrics.json', 128 * 1024], '/frame': ['ending.png', 8 * 1024 * 1024], '/video': ['replay.mp4', 64 * 1024 * 1024] };
  const target = files[request.url];
  if (request.method !== 'POST' || !target) { response.writeHead(404).end(); return; }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of request) { size += chunk.length; if (size > target[1]) { response.writeHead(413).end(); request.destroy(); return; } chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    if (request.url === '/video' && (body.length < 12 || body.subarray(4, 8).toString() !== 'ftyp')) { response.writeHead(400).end('Actual MP4 required'); return; }
    if (request.url === '/frame' && body.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') { response.writeHead(400).end(); return; }
    if (request.url === '/metrics') JSON.parse(body.toString());
    await writeFile(path.join(output, target[0]), body); response.writeHead(200).end('Saved');
    console.info(JSON.stringify({ artifact: target[0], bytes: body.length }));
  } catch { if (!response.headersSent) response.writeHead(400).end(); }
});
server.listen(3304, '127.0.0.1', () => console.info('Local replay artifacts receiver: http://127.0.0.1:3304'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
