import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { resolveHierarchy } from './hierarchy.mjs';

async function readJson(request, limit) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function catalogOf(source) {
  try {
    const result = await acquire(source, '/catalog');
    const catalog = JSON.parse(result.bytes.toString('utf8'));
    return catalog && typeof catalog === 'object' ? catalog : {};
  } catch { return {}; }
}

function summaryOf(result) {
  return {
    entry: result.entry,
    project: result.project,
    pages: result.pages.length,
    sheets: result.sheets.length,
    placements: result.placements.length,
    devices: result.devices.length,
    unresolved: result.unresolved.length,
    duplicates: result.duplicates.length
  };
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname === '/deliveries' && request.method === 'GET') {
        return response.end(JSON.stringify((await store.listDeliveries()).map(delivery => ({
          id: delivery.id, source: delivery.source, summary: delivery.summary,
          unresolved: delivery.result.unresolved.length
        }))));
      }
      if (url.pathname.startsWith('/deliveries/') && request.method === 'GET') {
        const delivery = await store.delivery(url.pathname.slice('/deliveries/'.length));
        if (!delivery) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        return response.end(JSON.stringify(delivery));
      }
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await readJson(request, 16384);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/deliveries' && request.method === 'POST') {
        const payload = await readJson(request, 16384);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const catalog = await catalogOf(source);
        const files = catalog.files && typeof catalog.files === 'object' ? catalog.files : {};
        const fetched = new Map();
        const result = await resolveHierarchy({
          project: catalog.project ?? null,
          entry: payload.path,
          files,
          fetchPage: async page => {
            const acquired = await acquire(source, page.urlPath ?? page.url);
            fetched.set(page.key ?? page.urlPath, acquired.bytes);
            return acquired.bytes;
          }
        });
        const pages = result.pages
          .map(page => ({ ...page, bytes: fetched.get(page.key) ?? fetched.get(page.source) }))
          .filter(page => page.bytes);
        if (!pages.length) {
          response.statusCode = 422;
          return response.end(JSON.stringify({ error: 'entry_unreadable', unresolved: result.unresolved }));
        }
        const bytesByDigest = Object.fromEntries(pages.map(page => [page.digest, page.bytes]));
        const delivery = await store.acceptDelivery({
          bytesByDigest, source: new URL(payload.path, source).href,
          summary: summaryOf(result),
          result: { ...result, pages: pages.map(({ bytes, ...page }) => page) },
          pages
        });
        response.statusCode = 201;
        return response.end(JSON.stringify(delivery));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
