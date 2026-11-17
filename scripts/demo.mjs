import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  const response = await fetch(`${service.url}/deliveries`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  if (response.status !== 201) throw new Error(await response.text());
  const delivery = await response.json();
  console.log('层次领取摘要', delivery.summary);
  console.log('器件', delivery.result.devices.map(device => ({
    reference: device.reference,
    units: device.units.map(unit => unit.unit),
    pins: device.pins.map(pin => `${pin.number}@${pin.path}=${pin.reference}`),
    assembly: device.assembly
  })));
  console.log('未决项', delivery.result.unresolved);
  console.log('已保存原件', delivery.digests);
  const repeated = await fetch(`${service.url}/deliveries`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  console.log('重复领取返回同一记录', (await repeated.json()).id === delivery.id);
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
  const gap = await (await fetch(`${service.url}/deliveries`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) })).json();
  console.log('子图不可得时的未决项', gap.result.unresolved.map(item =>
    [item.kind, item.reason, item.sheet_path]));
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
