import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from '../src/reader.mjs';
import { resolveHierarchy } from '../src/hierarchy.mjs';

const fixture = name => readFile(new URL(`../fixtures/${name}`, import.meta.url));

// Tiny schematic builder so each test can describe only the parts it cares about.
const page = ({ uuid, libraries = '', symbols = '', sheets = '' }) =>
  `(kicad_sch (version 20250114) (generator eeschema) (uuid "${uuid}")` +
  (libraries ? ` (lib_symbols ${libraries})` : '') + sheets + symbols + ')';
const library = (name, bodies) => `(symbol "${name}" ${bodies})`;
const body = (name, pins) => `(symbol "${name}" ${pins})`;
const pin = (number, name, type = 'passive') =>
  `(pin ${type} line (number "${number}") (name "${name}"))`;
const placed = ({ uuid, library: lib, unit = 1, reference, instances = '', properties = '', flags = '' }) =>
  `(symbol (uuid "${uuid}") (lib_id "${lib}") (unit ${unit})` +
  (properties || ` (property "Reference" "${reference}") (property "Value" "V")`) +
  flags + (instances ? ` (instances ${instances})` : '') + ')';
const paths = (...items) => items.join('');
const instance = (project, path, reference, unit) =>
  `(project "${project}" (path "${path}" (reference "${reference}") (unit ${unit})))`;
const sheet = (uuid, name, file) =>
  `(sheet (uuid "${uuid}") (property "Sheetname" "${name}") (property "Sheetfile" "${file}"))`;

function resolver(pages, { entry = '/root', files = {}, project = 'board' } = {}) {
  const seen = [];
  return resolveHierarchy({
    project, entry, files,
    fetchPage: async request => {
      seen.push(request.key ?? request.urlPath);
      const value = pages[request.key ?? request.urlPath];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error('source_status_404');
      return Buffer.from(value);
    }
  }).then(result => ({ result, seen }));
}
const urls = keys => Object.fromEntries(keys.map(key => [key, `/${key}`]));

test('一份子图文件按两条已声明路径展开为不同实例', async () => {
  const child = page({
    uuid: 'child',
    libraries: library('Logic:U', body('U_1_1', pin('1', 'A', 'input')) + body('U_2_1', pin('2', 'Y', 'output'))),
    symbols: placed({ uuid: 'child-u', library: 'Logic:U', unit: 2, reference: 'U?',
      instances: paths(instance('board', '/root/sheet-a', 'U1', 2), instance('board', '/root/sheet-b', 'U2', 2)) })
  });
  const root = page({ uuid: 'root', sheets: sheet('sheet-a', 'A', 'child.kicad_sch') + sheet('sheet-b', 'B', 'child.kicad_sch') });
  const { result, seen } = await resolver({ '/root': root, 'child.kicad_sch': child },
    { files: urls(['child.kicad_sch']) });
  assert.deepEqual(seen, ['/root', 'child.kicad_sch']);
  assert.equal(result.pages.length, 2);
  assert.equal(result.placements.length, 2);
  assert.deepEqual(result.placements.map(item => item.path), ['/root/sheet-a', '/root/sheet-b']);
  assert.deepEqual(result.placements.map(item => item.reference), ['U1', 'U2']);
  assert.deepEqual(result.placements.map(item => item.unit), [2, 2]);
  assert.deepEqual(result.devices.map(item => item.reference), ['U1', 'U2']);
  assert.equal(result.unresolved.length, 0);
});

test('同一器件跨页多单元按完整路径归并，管脚带标号与装配属性', async () => {
  const child = page({
    uuid: 'child',
    libraries: library('Logic:U', body('U_1_1', pin('1', 'A', 'input')) + body('U_2_1', pin('2', 'Y', 'output'))),
    symbols: placed({ uuid: 'child-u', library: 'Logic:U', unit: 2, reference: 'U?',
      instances: paths(instance('board', '/root/sheet-a', 'U1', 2)),
      flags: ' (dnp yes) (in_bom no) (on_board yes)' })
  });
  const root = page({
    uuid: 'root',
    libraries: library('Logic:U', body('U_1_1', pin('1', 'A', 'input')) + body('U_2_1', pin('2', 'Y', 'output'))),
    sheets: sheet('sheet-a', 'A', 'child.kicad_sch'),
    symbols: placed({ uuid: 'u-root', library: 'Logic:U', unit: 1,
      instances: paths(instance('board', '/root', 'U1', 1)), flags: ' (in_bom yes)' })
  });
  const { result } = await resolver({ '/root': root, 'child.kicad_sch': child },
    { files: urls(['child.kicad_sch']) });
  assert.equal(result.devices.length, 1);
  const [device] = result.devices;
  assert.equal(device.reference, 'U1');
  assert.deepEqual(device.units.map(unit => unit.unit), [1, 2]);
  assert.deepEqual(device.units.map(unit => unit.pins.map(item => item.number)), [['1'], ['2']]);
  assert.deepEqual(device.pins.map(item => [item.number, item.path]),
    [['1', '/root'], ['2', '/root/sheet-a']]);
  assert.equal(device.assembly.dnp, 'yes');
  // The page placements disagree about in_bom; both declarations are kept and
  // the conflict is flagged rather than collapsed to one value.
  assert.deepEqual(device.assembly.in_bom, ['yes', 'no']);
  assert.equal(device.assembly.on_board, 'yes');
  assert.ok(device.assembly_conflict.includes('in_bom'));
  assert.ok(result.unresolved.some(item => item.kind === 'assembly_conflict' && item.field === 'in_bom'));
  for (const item of device.pins) {
    assert.equal(item.reference, 'U1');
    assert.ok(item.assembly && typeof item.assembly === 'object');
  }
});

test('缺子图与缺库定义保留可追查未决项，不用别页同名符号补', async () => {
  const root = page({
    uuid: 'root',
    libraries: library('Other:U', body('U_1_1', pin('9', 'Z'))),
    sheets: sheet('sheet-a', 'A', 'absent.kicad_sch') + sheet('sheet-b', 'B', 'blank.kicad_sch'),
    symbols: placed({ uuid: 'u-root', library: 'Logic:Missing', unit: 1, reference: 'U?',
      instances: paths(instance('board', '/root', 'U7', 1)) })
  });
  const { result } = await resolver({ '/root': root, 'blank.kicad_sch': '' },
    { files: urls(['blank.kicad_sch', 'absent.kicad_sch']) });
  const kinds = result.unresolved.map(item => [item.kind, item.reason]);
  assert.ok(kinds.some(([kind, reason]) => kind === 'missing_page' && reason === 'source_status_404'));
  assert.ok(kinds.some(([kind, reason]) => kind === 'invalid_page'));
  assert.ok(kinds.some(([kind, reason]) => kind === 'missing_library' && reason === 'library_definition_absent'));
  const libraryItem = result.unresolved.find(item => item.kind === 'missing_library');
  assert.equal(libraryItem.path, '/root');
  assert.equal(libraryItem.reference, 'U7');
  assert.equal(libraryItem.library, 'Logic:Missing');
  assert.deepEqual(result.placements[0].pins, []);
  // The same-named-but-undeclared unit pin from another library is not used.
  assert.equal(result.devices[0].pins.length, 0);
});

test('未映射子图文件不猜测，环被表达为未决项', async () => {
  const root = page({
    uuid: 'root',
    sheets: sheet('loop', 'Loop', 'root.kicad_sch') + sheet('gone', 'Gone', 'nowhere.kicad_sch')
  });
  const { result } = await resolver({ '/root': root }, { files: { 'root.kicad_sch': '/root' } });
  assert.ok(result.unresolved.some(item => item.kind === 'cycle' && item.sheet_path === '/root/loop'));
  assert.ok(result.unresolved.some(item => item.kind === 'missing_page' && item.reason === 'sheet_file_unmapped'));
  assert.equal(result.placements.length, 0);
});

test('路径声明缺失或仍是占位符时保留原状态', async () => {
  const root = page({
    uuid: 'root',
    libraries: library('Logic:U', body('U_1_1', pin('1', 'A'))),
    symbols: placed({ uuid: 'u-a', library: 'Logic:U', unit: 1, reference: 'U?' }) +
      placed({ uuid: 'u-b', library: 'Logic:U', unit: 1, reference: 'U3' })
  });
  const { result } = await resolver({ '/root': root });
  assert.equal(result.placements.length, 2);
  assert.equal(result.placements[0].reference, null);
  assert.equal(result.placements[0].status, 'unresolved');
  assert.ok(result.unresolved.some(item => item.kind === 'instance_mismatch' && item.reason === 'reference_absent'));
  assert.ok(result.unresolved.some(item => item.kind === 'instance_mismatch' && item.reason === 'path_declaration_absent'));
  // A concrete property reference is kept without inventing a path instance.
  assert.equal(result.placements[1].reference, 'U3');
  assert.equal(result.placements[1].reference_source, 'property');
});

test('同页 extends 继承库定义，别页同名定义不被借用', async () => {
  const base = body('U_1_1', pin('1', 'A')) + body('U_2_1', pin('2', 'B'));
  const child = page({
    uuid: 'child',
    // The child page defines a same-named symbol with a different pin. It is a
    // legitimate definition for the child page, but never a substitute for the
    // unresolved "Absent:U" placement on the root page.
    libraries: library('Absent:U', body('U_1_1', pin('9', 'Z'))) +
      `(symbol "Derived:U" (extends "Absent:U"))`,
    symbols: placed({ uuid: 'child-u', library: 'Derived:U', unit: 1, reference: 'U?',
      instances: paths(instance('board', '/root/sheet-a', 'U3', 1)) })
  });
  const root = page({
    uuid: 'root',
    libraries: library('Logic:U', base) + `(symbol "Derived:M" (extends "Logic:U"))`,
    sheets: sheet('sheet-a', 'A', 'child.kicad_sch'),
    symbols: placed({ uuid: 'u-a', library: 'Derived:M', unit: 2, reference: 'U?',
      instances: paths(instance('board', '/root', 'U1', 2)) }) +
      placed({ uuid: 'u-b', library: 'Absent:U', unit: 1, reference: 'U?',
        instances: paths(instance('board', '/root', 'U2', 1)) })
  });
  const { result } = await resolver({ '/root': root, 'child.kicad_sch': child },
    { files: urls(['child.kicad_sch']) });
  const derived = result.placements.find(item => item.library === 'Derived:M');
  assert.deepEqual(derived.pins.map(item => item.number), ['2']);
  assert.equal(derived.library_resolved, true);
  const childDerived = result.placements.find(item => item.library === 'Derived:U');
  assert.deepEqual(childDerived.pins.map(item => [item.number, item.name]), [['9', 'Z']]);
  const absent = result.placements.find(item => item.library === 'Absent:U');
  assert.equal(absent.library_resolved, false);
  assert.equal(absent.status, 'unresolved');
  assert.deepEqual(absent.pins, []);
  const missing = result.unresolved.find(item => item.reason === 'library_definition_absent' &&
    item.library === 'Absent:U' && item.page === '/root');
  // The child page definition is reported as a lead to investigate, not used.
  assert.deepEqual(missing.declaring_pages, ['child.kicad_sch']);
});

test('库定义缺失时仍交出放置实例自身的管脚声明', async () => {
  const root = page({
    uuid: 'root',
    symbols: `(symbol (uuid "u-x") (lib_id "Logic:NoDef") (unit 1) (pin "4" (uuid "p4"))` +
      ` (pin "5" (uuid "p5")) (property "Reference" "U?")` +
      ` (instances (project "board" (path "/root" (reference "U8") (unit 1)))))`
  });
  const { result } = await resolver({ '/root': root });
  const [placement] = result.placements;
  assert.equal(placement.reference, 'U8');
  assert.deepEqual(placement.pins.map(item => [item.number, item.library_defined]),
    [['4', false], ['5', false]]);
  assert.deepEqual(result.devices[0].pins.map(item => [item.number, item.library_defined]),
    [['4', false], ['5', false]]);
});

test('单元越界和同器件重复单元都保留未决项', async () => {
  const root = page({
    uuid: 'root',
    libraries: library('Logic:U', body('U_1_1', pin('1', 'A'))),
    symbols: [1, 2].map(index => placed({ uuid: `u-${index}`, library: 'Logic:U', unit: 3, reference: 'U?',
      instances: paths(instance('board', '/root', 'U4', 3)) })).join('')
  });
  const { result } = await resolver({ '/root': root });
  assert.equal(result.devices.length, 1);
  const [device] = result.devices;
  assert.deepEqual(device.library_units, [1]);
  // The device only declares unit 3, so unit 1 of the library is unused. That
  // is an informational gap, not a claim that a placement is missing.
  assert.deepEqual(device.unplaced_library_units, [1]);
  assert.ok(result.unresolved.some(item => item.kind === 'unit_mismatch' && item.reason === 'unit_absent_from_library'));
  assert.equal(result.duplicates.length, 1);
  assert.deepEqual(result.duplicates[0].paths, ['/root', '/root']);
  assert.deepEqual(result.duplicates[0].placements.map(item => item.symbol_uuid), ['u-1', 'u-2']);
  assert.ok(result.unresolved.some(item => item.kind === 'duplicate_placement'));
});

test('同一文件的不同路径实例不合并，同一路径的器件才合并', async () => {
  const child = page({
    uuid: 'child',
    libraries: library('Logic:U', body('U_1_1', pin('1', 'A')) + body('U_2_1', pin('2', 'B'))),
    symbols: placed({ uuid: 'child-u', library: 'Logic:U', unit: 1, reference: 'U?',
      instances: paths(instance('board', '/root/left', 'U1', 1), instance('board', '/root/right', 'U2', 1)) })
  });
  const root = page({
    uuid: 'root',
    sheets: sheet('left', 'Left', 'child.kicad_sch') + sheet('right', 'Right', 'child.kicad_sch')
  });
  const { result } = await resolver({ '/root': root, 'child.kicad_sch': child },
    { files: urls(['child.kicad_sch']) });
  assert.equal(result.pages.length, 2);
  assert.equal(result.devices.length, 2);
  assert.deepEqual(result.devices.map(device => device.reference), ['U1', 'U2']);
  assert.deepEqual(result.devices.map(device => device.placements.length), [1, 1]);
  assert.deepEqual(result.devices.map(device => device.placements[0].path), ['/root/left', '/root/right']);
});

test('库符号、放置实例与器件是三层不同记录', async () => {
  const { result } = await resolver({ '/root': (await fixture('primary.bin')).toString() }, {});
  assert.equal(result.library_symbols.length, 1);
  assert.equal(result.library_symbols[0].units.length, 2);
  assert.equal(result.placements.length, 1);
  assert.equal(result.devices.length, 1);
  assert.deepEqual(result.devices[0].units.map(unit => unit.unit), [1]);
  const single = inspect(await fixture('primary.bin'));
  assert.equal(single.symbols[0].uuid, 'u-root');
  assert.equal(single.symbols[0].library, 'Logic:U');
  assert.equal(single.symbols[0].instances[0].reference, 'U1');
});
