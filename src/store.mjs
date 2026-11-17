import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
  async saveDeliveries(deliveries) {
    const temporary = join(this.directory, `deliveries-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(deliveries));
    await rename(temporary, join(this.directory, 'deliveries.json'));
  }
  async listDeliveries() {
    try { return JSON.parse(await readFile(join(this.directory, 'deliveries.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async acceptDelivery({ bytesByDigest, source, summary, result, pages }) {
    const digests = Object.keys(bytesByDigest).sort();
    const operation = this.pending.then(async () => {
      const deliveries = await this.listDeliveries();
      const existing = deliveries.find(delivery => delivery.source === source &&
        delivery.digests.join(',') === digests.join(','));
      if (existing) return existing;
      for (const [digest, bytes] of Object.entries(bytesByDigest)) {
        try { await readFile(join(this.directory, 'objects', digest)); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await writeFile(join(this.directory, 'objects', digest), bytes);
        }
      }
      const delivery = {
        id: randomUUID(), source, digests,
        pages: pages.map(page => ({ key: page.key, source: page.source, uuid: page.uuid, digest: page.digest })),
        summary, result
      };
      deliveries.push(delivery);
      await this.saveDeliveries(deliveries);
      return delivery;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async delivery(id) {
    const deliveries = await this.listDeliveries();
    return deliveries.find(delivery => delivery.id === id) ?? null;
  }
}
