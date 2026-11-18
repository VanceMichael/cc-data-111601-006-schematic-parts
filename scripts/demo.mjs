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
  const response = await fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  if (response.status !== 201) throw new Error(await response.text());
  console.log('接收结果', await response.json());
  const claimResponse = await fetch(`${service.url}/claims`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/hierarchy.kicad_sch' }) });
  if (claimResponse.status !== 200) throw new Error(await claimResponse.text());
  const claim = await claimResponse.json();
  console.log('层次领取页', claim.pages.map(page => page.file));
  console.log('器件', claim.devices.map(device => ({
    reference: device.reference,
    units: device.units.map(unit => unit.unit),
    pins: device.pins.map(pin => `${pin.reference}.${pin.number}@unit${pin.unit}`),
    attributes: device.attributes,
    paths: device.paths
  })));
  console.log('未决项', claim.unresolved);
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
