export function sexpression(text) {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g) ?? [];
  const stack = []; let root;
  for (const token of tokens) {
    if (token === '(') {
      const item = [];
      if (stack.length) stack.at(-1).push(item); else if (root) throw new Error('multiple_roots'); else root = item;
      stack.push(item);
    } else if (token === ')') {
      if (!stack.length) throw new Error('unbalanced_close');
      stack.pop();
    } else {
      if (!stack.length) throw new Error('atom_outside_root');
      stack.at(-1).push(token.startsWith('"') ? JSON.parse(token) : token);
    }
  }
  if (stack.length || !root) throw new Error('unbalanced_document');
  return root;
}

export const ATTRIBUTE_NAMES = ['dnp', 'in_bom', 'on_board', 'exclude_from_sim'];

const children = (node, name) => Array.isArray(node)
  ? node.filter(item => Array.isArray(item) && item[0] === name) : [];
const first = (node, name) => children(node, name)[0];
const atom = node => Array.isArray(node) && typeof node[1] === 'string' ? node[1] : null;

/** Preserve the raw declaration: undefined means the file did not declare it. */
function attributes(node) {
  const result = {};
  for (const name of ATTRIBUTE_NAMES) {
    const item = first(node, name);
    if (item) result[name] = typeof item[1] === 'string' ? item[1] : true;
  }
  return result;
}

function properties(node) {
  return children(node, 'property')
    .filter(item => typeof item[1] === 'string')
    .map(item => ({ name: item[1], value: item[2] }));
}
const propertyMap = list => Object.fromEntries(list.map(item => [item.name, item.value]));
function property(list, ...names) {
  for (const name of names) {
    const found = list.find(item => item.name === name);
    if (found) return found.value;
  }
  return null;
}

function parsePin(pin) {
  return {
    number: atom(first(pin, 'number')),
    name: atom(first(pin, 'name')),
    // pin[1] is the electrical type, pin[2] its graphical shape (not the
    // symbol body style, which is part of the enclosing unit name).
    type: typeof pin[1] === 'string' ? pin[1] : null,
    shape: typeof pin[2] === 'string' ? pin[2] : null
  };
}

function parseLibrarySymbol(symbol) {
  const declaredProperties = properties(symbol);
  const units = [];
  for (const unitNode of children(symbol, 'symbol')) {
    const match = /_(\d+)_(\d+)$/.exec(unitNode[1] ?? '');
    units.push({
      name: unitNode[1] ?? null,
      unit: match ? Number(match[1]) : 0,
      bodyStyle: match ? Number(match[2]) : null,
      pins: children(unitNode, 'pin').map(parsePin)
    });
  }
  // A handful of generated libraries put pins directly on the outer symbol.
  // Those are common to every unit, not a replacement for missing units.
  const directPins = children(symbol, 'pin').map(parsePin);
  if (directPins.length) {
    units.push({ name: symbol[1] ?? null, unit: 0, bodyStyle: null, pins: directPins });
  }
  return {
    name: symbol[1] ?? null,
    properties: declaredProperties,
    propertyMap: propertyMap(declaredProperties),
    attributes: attributes(symbol),
    units,
    pins: units.flatMap(unit => unit.pins.map(pin => ({
      ...pin, unit: unit.unit, bodyStyle: unit.bodyStyle
    })))
  };
}

function parseInstances(node) {
  const result = [];
  for (const container of children(node, 'instances')) {
    for (const project of children(container, 'project')) {
      for (const path of children(project, 'path')) {
        result.push({
          project: project[1] ?? null,
          path: path[1] ?? null,
          reference: atom(first(path, 'reference')),
          unit: atom(first(path, 'unit'))
        });
      }
    }
  }
  return result;
}

/**
 * Parse one KiCad schematic page without resolving hierarchy.
 * Library symbols and placed symbols deliberately remain separate: a library
 * definition is a template, a placed symbol is an occurrence in one path.
 */
export function parseSchematic(bytes) {
  const root = sexpression(bytes.toString('utf8'));
  if (root[0] !== 'kicad_sch') throw new Error('schematic_root');
  const library = first(root, 'lib_symbols');
  const librarySymbols = children(library, 'symbol').map(parseLibrarySymbol);
  const symbols = children(root, 'symbol').map(symbol => {
    const declaredProperties = properties(symbol);
    return {
      uuid: atom(first(symbol, 'uuid')),
      library: atom(first(symbol, 'lib_id')),
      libId: atom(first(symbol, 'lib_id')),
      unit: atom(first(symbol, 'unit')),
      bodyStyle: atom(first(symbol, 'body_style')),
      properties: declaredProperties,
      propertyMap: propertyMap(declaredProperties),
      instances: parseInstances(symbol),
      attributes: attributes(symbol),
      ...attributes(symbol)
    };
  });
  const sheets = children(root, 'sheet').map(sheet => {
    const declaredProperties = properties(sheet);
    return {
      uuid: atom(first(sheet, 'uuid')),
      properties: declaredProperties,
      propertyMap: propertyMap(declaredProperties),
      name: property(declaredProperties, 'Sheetname', 'SheetName'),
      file: property(declaredProperties, 'Sheetfile', 'SheetFile'),
      instances: parseInstances(sheet)
    };
  });
  return {
    kind: 'schematic-page',
    uuid: atom(first(root, 'uuid')),
    version: atom(first(root, 'version')),
    generator: atom(first(root, 'generator')),
    librarySymbols,
    symbols,
    sheets
  };
}

export function inspect(bytes) {
  const page = parseSchematic(bytes);
  return {
    kind: page.kind,
    uuid: page.uuid,
    version: page.version,
    generator: page.generator,
    librarySymbols: page.librarySymbols,
    symbols: page.symbols.map(symbol => ({
      uuid: symbol.uuid,
      library: symbol.library,
      libId: symbol.libId,
      unit: symbol.unit,
      bodyStyle: symbol.bodyStyle,
      properties: symbol.properties.map(item => [item.name, item.value]),
      propertyMap: symbol.propertyMap,
      instances: symbol.instances,
      attributes: symbol.attributes,
      dnp: symbol.dnp,
      in_bom: symbol.in_bom,
      on_board: symbol.on_board
    })),
    sheets: page.sheets.map(sheet => ({
      uuid: sheet.uuid,
      properties: sheet.properties.map(item => [item.name, item.value]),
      propertyMap: sheet.propertyMap,
      name: sheet.name,
      file: sheet.file
    }))
  };
}
