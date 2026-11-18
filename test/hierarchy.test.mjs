import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from '../src/reader.mjs';
import { resolveHierarchy, groupDevices, normalizeSheetFile } from '../src/hierarchy.mjs';

const load = async name => readFile(new URL(`../fixtures/${name}`, import.meta.url));
const pages = {
  'hierarchy.kicad_sch': 'hierarchy.bin',
  'amp-a.kicad_sch': 'amp-a.bin',
  'amp-b.kicad_sch': 'amp-b.bin',
  'nolib.kicad_sch': 'nolib.bin',
  'cycle.kicad_sch': 'cycle.bin'
};
const bytes = Object.fromEntries(await Promise.all(Object.entries(pages)
  .map(async ([file, fixture]) => [file, await load(fixture)])));

function resolve(entry = 'hierarchy.kicad_sch', extra = {}) {
  const requested = [];
  return {
    requested,
    result: resolveHierarchy({
      entryFile: entry,
      project: 'board',
      // Mirror the catalog: only declared files may be fetched.
      isDeclared: file => Object.hasOwn(pages, file),
      fetchPage: async file => {
        requested.push(file);
        const value = extra[file] ?? bytes[file];
        return value ? { bytes: value } : { error: 'page_unavailable' };
      }
    })
  };
}

test('层次领取沿声明子图展开，同一文件的多个路径实例不合并', async () => {
  const { requested, result: resolved } = resolve();
  const resolvedPages = await resolved;
  assert.deepEqual(requested.sort(), Object.keys(bytes).sort());
  const ampA = resolvedPages.placements.filter(item => item.file === 'amp-a.kicad_sch');
  // The child file is fetched once, but appears as two independent paths.
  assert.equal(requested.filter(file => file === 'amp-a.kicad_sch').length, 1);
  assert.ok(ampA.some(item => item.path === '/h-root/hs-a'));
  assert.ok(ampA.some(item => item.path === '/h-root/hs-c'));
  assert.equal(ampA.find(item => item.path === '/h-root/hs-a').reference, 'U10');
  assert.equal(ampA.find(item => item.path === '/h-root/hs-c').reference, 'U20');
  // Same file, same symbol UUID, same unit: still two distinct placements.
  const sameSymbol = ampA.filter(item => item.symbolUuid === 'a-u1');
  assert.equal(sameSymbol.length, 2);
  assert.deepEqual(sameSymbol.map(item => item.path).sort(), ['/h-root/hs-a', '/h-root/hs-c']);
  assert.deepEqual(sameSymbol.map(item => item.unit.resolved), [1, 1]);
});

test('多单元器件按实例标号跨页合并，管脚带所属单元与装配属性', async () => {
  const resolved = await resolve().result;
  const U10 = resolved.devices.find(device => device.reference === 'U10');
  assert.deepEqual(U10.paths.sort(), ['/h-root/hs-a', '/h-root/hs-b']);
  assert.deepEqual(U10.units.map(unit => unit.unit).sort(), [1, 2]);
  assert.equal(U10.libraryStatus, 'resolved');
  const pinNumbers = U10.pins.map(pin => pin.number).sort();
  assert.deepEqual(pinNumbers, ['1', '2', '8', '8']);
  for (const pin of U10.pins) {
    assert.equal(pin.reference, 'U10');
    assert.equal(pin.library, 'Device:OPA');
    assert.equal(pin.attributes.dnp, 'yes');
    assert.ok(pin.path === '/h-root/hs-a' || pin.path === '/h-root/hs-b');
  }
  const unitOne = U10.units.find(unit => unit.unit === 1);
  const unitTwo = U10.units.find(unit => unit.unit === 2);
  assert.deepEqual(unitOne.pins.map(pin => pin.number), ['8', '1']);
  assert.deepEqual(unitTwo.pins.map(pin => pin.number), ['8', '2']);
  // Unit-0 pins repeat per unit but stay attributed to the unit using them.
  assert.equal(unitOne.pins.find(pin => pin.number === '8').unitDeclaration, 0);
  assert.equal(unitOne.pins.find(pin => pin.number === '8').unit, 1);
  assert.equal(unitTwo.pins.find(pin => pin.number === '8').unit, 2);
  assert.equal(U10.attributes.in_bom, 'no');
  assert.equal(U10.attributes.on_board, 'yes');
});

test('库符号、放置实例与器件是三层不同身份', async () => {
  const page = inspect(await load('amp-a.bin'));
  assert.equal(page.librarySymbols.length, 1);
  assert.equal(page.librarySymbols[0].pins.length, 4);
  assert.equal(page.symbols.length, 3);
  const resolved = await resolve().result;
  const placement = resolved.placements.find(item => item.symbolUuid === 'a-u1'
    && item.path === '/h-root/hs-a');
  assert.equal(placement.libraryDefinitionFile, 'amp-a.kicad_sch');
  assert.equal(placement.libraryStatus, 'resolved');
  const device = resolved.devices.find(item => item.reference === 'U10');
  assert.equal(device.placements.length, 2);
  assert.notEqual(device.placements[0].symbolUuid, resolved.devices
    .find(item => item.reference === 'U11').placements[0].symbolUuid);
  // The library definition is not mistaken for a placed instance.
  assert.ok(!resolved.placements.some(item => item.symbolUuid === null && item.pins.length));
});

test('缺库定义时保留未决放置，不用别页同名符号补齐', async () => {
  const resolved = await resolve().result;
  const missing = resolved.placements.find(item => item.symbolUuid === 'a-only'
    && item.path === '/h-root/hs-a');
  assert.equal(missing.libraryStatus, 'unresolved');
  assert.equal(missing.libraryReason, 'library_symbol_missing');
  assert.deepEqual(missing.pins, []);
  assert.equal(missing.reference, 'U30');
  // The parent page defines Logic:ONLY_PARENT, but the child page must not use it.
  assert.equal(resolved.placements.find(item => item.symbolUuid === 'n-opa').libraryStatus,
    'unresolved');
  assert.ok(resolved.unresolved.some(item => item.kind === 'placement'
    && item.symbolUuid === 'n-opa' && item.reason === 'library_symbol_missing'));
  const missingUnit = resolved.unresolved.find(item => item.symbolUuid === 'n-unit5');
  assert.equal(missingUnit.reason, 'library_unit_missing');
});

test('缺子图与子图环产生可追查的未决项，不中断其余领取', async () => {
  const resolved = await resolve().result;
  const missingSheet = resolved.unresolved.find(item => item.sheetUuid === 'hs-missing');
  assert.equal(missingSheet.reason, 'sheet_not_declared');
  assert.equal(missingSheet.sheetFile, 'missing.kicad_sch');
  assert.equal(missingSheet.path, '/h-root/hs-missing');
  const cycle = resolved.unresolved.find(item => item.reason === 'sheet_cycle');
  assert.ok(cycle);
  assert.equal(cycle.sheetFile, 'hierarchy.kicad_sch');
  // Everything reachable despite the broken branches is still delivered.
  assert.ok(resolved.devices.some(device => device.reference === 'U10'));
});

test('未申报的子图文件不会被自行抓取', async () => {
  const requested = [];
  const resolved = await resolveHierarchy({
    entryFile: 'hierarchy.kicad_sch',
    isDeclared: file => Object.hasOwn(pages, file),
    fetchPage: async file => { requested.push(file); return { bytes: bytes[file] }; }
  });
  assert.ok(!requested.includes('missing.kicad_sch'));
  assert.ok(resolved.unresolved.some(item => item.reason === 'sheet_not_declared'));
});

test('实例路径缺失与占位标号都不会被错误合并', async () => {
  const resolved = await resolve().result;
  const noInstance = resolved.unresolved.find(item => item.symbolUuid === 'a-noinst');
  assert.equal(noInstance.reason, 'instance_path_missing');
  // U? on two different paths stays two devices, never one.
  const placeholders = resolved.devices.filter(device => device.reference === 'U?');
  assert.equal(placeholders.length, 2);
  assert.notEqual(placeholders[0].paths[0], placeholders[1].paths[0]);
  assert.ok(placeholders.every(device => device.referenceAnnotated === false));
});

test('同一标号指向不同库符号时保留冲突而不是合并为一件', () => {
  const base = {
    path: '/r/s', symbolUuid: 'x1', library: 'A:CHIP', reference: 'R1',
    referenceSource: 'instances', attributes: {}, properties: {}, pins: [],
    unit: { declared: '1', resolved: 1 }, libraryStatus: 'resolved'
  };
  const devices = groupDevices([base, { ...base, symbolUuid: 'x2', library: 'B:CHIP' }]);
  assert.equal(devices.length, 2);
  for (const device of devices) {
    assert.deepEqual(device.conflicts[0].reason, 'reference_library_conflict');
    assert.deepEqual(device.conflicts[0].libraries.sort(), ['A:CHIP', 'B:CHIP']);
  }
});

test('库定义缺失时器件保留身份但标记未决', async () => {
  const resolved = await resolve().result;
  const device = resolved.devices.find(item => item.reference === 'U30');
  assert.equal(device.library, undefined);
  assert.equal(device.libraryStatus, 'unresolved');
  assert.equal(device.unresolved[0].reason, 'library_symbol_missing');
  assert.deepEqual(device.pins, []);
});

test('未声明入口与非法子图路径不会被读取', async () => {
  const requested = [];
  const resolved = await resolveHierarchy({
    entryFile: 'absent.kicad_sch',
    fetchPage: async file => { requested.push(file); return { error: 'page_unavailable' }; }
  });
  assert.deepEqual(requested, ['absent.kicad_sch']);
  assert.deepEqual(resolved.unresolved, [{ kind: 'page', path: '/', file: 'absent.kicad_sch',
    reason: 'page_unavailable' }]);
  assert.equal(normalizeSheetFile('../escape.kicad_sch'), null);
  assert.equal(normalizeSheetFile('a/../../b.kicad_sch'), null);
  assert.equal(normalizeSheetFile('https://example.invalid/x.kicad_sch'), null);
  assert.equal(normalizeSheetFile('./sub/child.kicad_sch'), 'sub/child.kicad_sch');
});

test('项目范围不匹配的实例声明不会被借用', async () => {
  const body = '(kicad_sch (uuid "p") (lib_symbols (symbol "L:X" (symbol "X_1_1" '
    + '(pin input line (number "1") (name "A"))))) (symbol (uuid "x") (lib_id "L:X") (unit 1) '
    + '(property "Reference" "U?") (instances (project "other" (path "/p" '
    + '(reference "U9") (unit 1))))))';
  const resolved = await resolveHierarchy({ entryFile: 'p.kicad_sch', project: 'board',
    fetchPage: async () => ({ bytes: Buffer.from(body) }) });
  const placement = resolved.placements[0];
  assert.equal(placement.referenceSource, 'property');
  assert.equal(placement.reference, 'U?');
  assert.ok(resolved.unresolved.some(item => item.reason === 'instance_project_missing'));
});

test('显式 body style 缺失时报告未决而不是退回到另一套单元图形', async () => {
  const body = '(kicad_sch (uuid "p") (lib_symbols (symbol "L:X" (symbol "X_1_1" '
    + '(pin input line (number "1") (name "A"))))) (symbol (uuid "x") (lib_id "L:X") (unit 1) '
    + '(body_style 2) (property "Reference" "U1") (instances (project "board" (path "/p" '
    + '(reference "U1") (unit 1))))))';
  const resolved = await resolveHierarchy({ entryFile: 'p.kicad_sch', project: 'board',
    fetchPage: async () => ({ bytes: Buffer.from(body) }) });
  assert.equal(resolved.placements[0].libraryStatus, 'unresolved');
  assert.equal(resolved.placements[0].libraryReason, 'library_body_style_missing');
  assert.deepEqual(resolved.placements[0].pins, []);
});

test('装配属性按原始声明保留，不转换为采购决策', () => {
  const resolved = resolve();
  return resolved.result.then(result => {
    const U1 = result.devices.find(device => device.reference === 'U1');
    assert.deepEqual(U1.attributes, { dnp: 'yes', in_bom: 'no', on_board: 'yes' });
    // Merged device keeps per-unit declarations even when they differ.
    const U10 = result.devices.find(device => device.reference === 'U10');
    assert.equal(U10.units[0].attributes.dnp, 'yes');
    assert.equal(U10.units[1].attributes.dnp, 'yes');
    assert.equal(U10.units[1].attributes.exclude_from_sim, undefined);
  });
});
