import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store, Store as ServiceStore } from '../src/store.mjs';
import { inspect } from '../src/reader.mjs';

test('层次领取沿子图取得实际实例，保留原件并持久重查', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const response = await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    assert.equal(response.status, 201);
    const delivery = await response.json();
    assert.equal(delivery.summary.pages, 2);
    assert.equal(delivery.summary.placements, 3);
    assert.equal(delivery.summary.devices, 2);
    assert.equal(delivery.summary.unresolved, 0);
    const byReference = Object.fromEntries(delivery.result.devices.map(device => [device.reference, device]));
    assert.deepEqual(byReference.U1.units.map(unit => unit.unit), [1, 2]);
    assert.deepEqual(byReference.U1.pins.map(pin => [pin.number, pin.reference, pin.path]),
      [['1', 'U1', '/root'], ['2', 'U1', '/root/sheet-a']]);
    assert.deepEqual(byReference.U2.pins.map(pin => [pin.number, pin.reference, pin.path]),
      [['2', 'U2', '/root/sheet-b']]);
    // Both sheet placements of the same file keep their own instance path.
    assert.deepEqual(delivery.result.placements.map(item => item.path).sort(),
      ['/root', '/root/sheet-a', '/root/sheet-b']);
    assert.equal(new Set(delivery.result.placements.map(item => item.symbol_uuid)).size, 2);
    for (const digest of delivery.digests) {
      const object = await fetch(`${service.url}/objects/${digest}`);
      assert.equal(object.status, 200);
      assert.ok((await object.arrayBuffer()).byteLength > 0);
    }
    // A repeated delivery returns the stored result rather than a new record.
    const repeated = await (await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) })).json();
    assert.equal(repeated.id, delivery.id);
    const reopened = await new ServiceStore(directory);
    const stored = await reopened.delivery(delivery.id);
    assert.deepEqual(stored.result.devices, delivery.result.devices);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('子图暂不可得时领取保留未决项而不猜测', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-gap-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
    const response = await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    assert.equal(response.status, 201);
    const delivery = await response.json();
    const missing = delivery.result.unresolved.filter(item => item.kind === 'missing_page');
    assert.equal(missing.length, 2);
    assert.deepEqual(missing.map(item => item.sheet_path), ['/root/sheet-a', '/root/sheet-b']);
    assert.ok(missing.every(item => item.sheet_file === 'child.kicad_sch'));
    assert.ok(missing.every(item => item.reason === 'source_status_404'));
    // The entry page is still fully explained; only the affected sheets drop.
    assert.deepEqual(delivery.result.devices.map(device => device.reference), ['U1']);
    assert.equal(delivery.result.pages.length, 1);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('单件资料可解释，畸形输入被拒绝', async () => {
  const fixture = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
  assert.ok(inspect(fixture));
  assert.throws(() => inspect(Buffer.alloc(0)));
});
test('来源领取、原件持久化、重启查询及无副作用拒收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const body = JSON.stringify({ path: '/primary' });
    const send = path => fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const first = await send('/primary');
    assert.equal(first.status, 201);
    const record = await first.json();
    assert.deepEqual(await new Store(directory).list(), [record]);
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${record.digest}`)).arrayBuffer()),
      await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
    const repeated = await send('/primary');
    assert.equal((await repeated.json()).id, record.id);
    assert.equal((await send('/missing')).status, 422);
    assert.equal((await send('https://example.invalid/foreign')).status, 422);
    assert.equal((await new Store(directory).list()).length, 1);
    const range = await fetch(`${provider.url}/primary`, { headers: { range: 'bytes=0-0' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 1);
    const reject = await fetch(`${provider.url}/primary`, { headers: { 'if-match': '"old"' } });
    assert.equal(reject.status, 412);
    assert.ok(body.includes('primary'));
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
