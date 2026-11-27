// Cloudhaven Air Rally — tiny local static server (Node standard library only).
//
// Usage: node serve.ts   then open http://localhost:8080
//
// Serves the game/ directory beside this file. ES modules need a real HTTP
// origin (file:// URLs block module imports), hence this helper.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8080;
const root = resolve(dirname(fileURLToPath(import.meta.url)), 'game');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const server = createServer(async (req, res) => {
  try {
    // Strip the query string (?shot=... etc.) and decode %-escapes.
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    let file = resolve(root, '.' + urlPath);

    // Path traversal guard: the resolved file must stay inside game/.
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Cloudhaven Air Rally running at http://localhost:${PORT}`);
});
