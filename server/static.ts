/**
 * Production static file server for the Vite build (`dist/`): correct MIME types, path-traversal safe,
 * immutable caching for hashed assets, SPA fallback to index.html.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

export const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

const isFile = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

/** Resolves a URL path inside `root`, or null if it escapes `root` or is malformed. */
export function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const full = normalize(join(root, decoded));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(rootWithSep)) return null;
  return full;
}

export function createStaticHandler(root: string): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const indexPath = join(root, 'index.html');

  const sendFile = async (res: ServerResponse, path: string, head: boolean, status = 200): Promise<void> => {
    const info = await stat(path);
    const ext = extname(path).toLowerCase();
    const hashedAsset = path.includes(`${sep}assets${sep}`) && ext !== '.html';
    res.writeHead(status, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (head) {
      res.end();
      return;
    }
    createReadStream(path)
      .on('error', () => res.destroy())
      .pipe(res);
  };

  return async (req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const head = method === 'HEAD';
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const target = safeJoin(root, pathname);
    if (target === null) {
      res.writeHead(400).end();
      return;
    }
    try {
      if (await isFile(target)) return await sendFile(res, target, head);
      // SPA fallback: extensionless routes get index.html; missing assets are a real 404.
      if (extname(pathname) === '' && (await isFile(indexPath))) return await sendFile(res, indexPath, head);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  };
}
