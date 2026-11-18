import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { inspect } from '../src/reader.mjs';

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

test('层次领取经产品入口返回器件并持久化全部页原件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claim-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const response = await fetch(`${service.url}/claims`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/hierarchy.kicad_sch' }) });
    assert.equal(response.status, 200);
    const claim = await response.json();
    assert.equal(claim.project, 'board');
    assert.deepEqual(claim.pages.map(page => page.file).sort(), ['amp-a.kicad_sch',
      'amp-b.kicad_sch', 'cycle.kicad_sch', 'hierarchy.kicad_sch', 'nolib.kicad_sch']);
    assert.ok(claim.pages.every(page => page.digest && page.recordId));
    const u10 = claim.devices.find(device => device.reference === 'U10');
    assert.deepEqual(u10.paths.sort(), ['/h-root/hs-a', '/h-root/hs-b']);
    assert.deepEqual(u10.units.map(unit => unit.unit).sort(), [1, 2]);
    assert.ok(u10.pins.every(pin => pin.reference === 'U10' && pin.attributes.dnp === 'yes'));

    // Every claimed page is queryable as an exact original.
    for (const page of claim.pages) {
      const stored = Buffer.from(await (await fetch(
        `${service.url}/objects/${page.digest}`)).arrayBuffer());
      const source = await (await fetch(page.source)).arrayBuffer();
      assert.deepEqual(stored, Buffer.from(source));
    }
    // A repeated claim keeps the same stored records.
    const repeated = await (await fetch(`${service.url}/claims`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/hierarchy.kicad_sch' }) })).json();
    assert.deepEqual(repeated.pages.map(page => page.recordId),
      claim.pages.map(page => page.recordId));
    assert.equal((await new Store(directory).list()).length, claim.pages.length);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('领取遇到来源不可用时返回未决项而不是伪造数据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claim-fail-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
    const claim = await (await fetch(`${service.url}/claims`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/primary' }) })).json();
    const failure = claim.unresolved.find(item => item.kind === 'sheet'
      && item.sheetUuid === 'sheet-a');
    assert.equal(failure.reason, 'source_status_404');
    // The entry page itself is still delivered.
    assert.deepEqual(claim.pages.map(page => page.file), ['primary']);
  } finally {
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 0 }) });
    await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true });
  }
});
