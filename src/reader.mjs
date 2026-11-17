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

const children = (node, name) => Array.isArray(node)
  ? node.filter(item => Array.isArray(item) && item[0] === name) : [];
const child = (node, name) => children(node, name)[0];
const atom = (node, name) => child(node, name)?.[1] ?? null;
const text = value => value === null || value === undefined ? null : String(value);
const integer = value => {
  const number = Number(value);
  return value !== null && value !== '' && Number.isInteger(number) ? number : null;
};
const normalize = value => text(value)?.toLowerCase().replace(/[\s_-]+/g, '') ?? null;

function propertyList(node) {
  return children(node, 'property').map(item => [text(item[1]), text(item[2])]);
}
function propertyValue(properties, name) {
  const wanted = normalize(name);
  for (const [key, value] of properties) if (normalize(key) === wanted) return value;
  return null;
}
function declaredValue(node, name, properties) {
  const item = child(node, name);
  if (item) return item.length > 1 && typeof item[1] !== 'object' ? String(item[1]) : 'yes';
  return propertyValue(properties, name);
}
function declaredAssembly(node, properties) {
  return {
    dnp: declaredValue(node, 'dnp', properties),
    in_bom: declaredValue(node, 'in_bom', properties),
    on_board: declaredValue(node, 'on_board', properties)
  };
}

function parsePin(node) {
  const hide = child(node, 'hide');
  return {
    number: text(atom(node, 'number')),
    name: text(atom(node, 'name')),
    electrical_type: text(node[1]),
    graphic_style: text(node[2]),
    hidden: node.includes('hide') || (hide !== undefined && normalize(hide[1] ?? 'yes') !== 'no')
  };
}
function parseLibraryBody(node) {
  const name = text(node[1]);
  const suffix = /_(\d+)_(\d+)$/.exec(name ?? '');
  return {
    name,
    unit: suffix ? Number(suffix[1]) : 0,
    body_style: suffix ? Number(suffix[2]) : 1,
    pins: children(node, 'pin').map(parsePin)
  };
}
function parseLibrarySymbol(node) {
  const name = text(node[1]);
  const bodies = children(node, 'symbol').map(parseLibraryBody);
  const directPins = children(node, 'pin').map(parsePin);
  if (directPins.length) bodies.unshift({ name, unit: 0, body_style: 1, pins: directPins });
  return {
    name,
    extends: text(child(node, 'extends')?.[1]),
    bodies,
    pins: bodies.flatMap(body => body.pins.map(pin => ({
      ...pin, unit: body.unit, body_style: body.body_style
    })))
  };
}

function parseInstances(node) {
  const container = child(node, 'instances');
  if (!container) return [];
  const instances = [];
  const addPath = (project, pathNode) => {
    instances.push({
      project: text(project),
      path: text(pathNode[1]),
      reference: text(atom(pathNode, 'reference')),
      unit: integer(atom(pathNode, 'unit')),
      unit_raw: text(atom(pathNode, 'unit')),
      page: text(atom(pathNode, 'page'))
    });
  };
  for (const projectNode of children(container, 'project')) {
    const project = projectNode[1];
    for (const pathNode of children(projectNode, 'path')) addPath(project, pathNode);
  }
  if (!instances.length) for (const pathNode of children(container, 'path')) addPath(null, pathNode);
  return instances;
}

function parsePlacedSymbol(node) {
  const properties = propertyList(node);
  const unit = atom(node, 'unit');
  const convert = atom(node, 'convert');
  const pins = children(node, 'pin').map(pin => ({
    // Library pins write (number "1"); placed symbols write (pin "1" (uuid ...)).
    number: text(atom(pin, 'number') ?? (typeof pin[1] === 'string' ? pin[1] : null)),
    name: text(atom(pin, 'name')),
    uuid: text(atom(pin, 'uuid')),
    alternate: text(atom(pin, 'alternate'))
  }));
  return {
    uuid: text(atom(node, 'uuid')),
    library: text(atom(node, 'lib_id') ?? atom(node, 'lib_name')),
    lib_id: text(atom(node, 'lib_id')),
    lib_name: text(atom(node, 'lib_name')),
    unit: text(unit),
    unit_number: integer(unit),
    convert: text(convert),
    convert_number: integer(convert),
    properties,
    property_map: Object.fromEntries(properties.filter(([name]) => name !== null)),
    assembly: declaredAssembly(node, properties),
    instances: parseInstances(node),
    pins
  };
}

function parseSheet(node) {
  const properties = propertyList(node);
  const file = propertyValue(properties, 'Sheetfile') ?? text(atom(node, 'file'));
  return {
    uuid: text(atom(node, 'uuid')),
    properties,
    property_map: Object.fromEntries(properties.filter(([name]) => name !== null)),
    name: propertyValue(properties, 'Sheetname'),
    file,
    sheetfile: file,
    instances: parseInstances(node)
  };
}

export function inspect(bytes) {
  const root = sexpression(bytes.toString('utf8'));
  if (!Array.isArray(root) || root[0] !== 'kicad_sch') throw new Error('schematic_root');
  const uuid = text(atom(root, 'uuid'));
  const library = children(root, 'lib_symbols')
    .flatMap(container => children(container, 'symbol'))
    .map(parseLibrarySymbol);
  return {
    kind: 'schematic-page',
    uuid,
    version: text(atom(root, 'version')),
    generator: text(atom(root, 'generator')),
    library_symbols: library,
    symbols: children(root, 'symbol').map(parsePlacedSymbol),
    sheets: children(root, 'sheet').map(parseSheet)
  };
}

// Internal helpers shared with the hierarchy resolver.
export const schematic = { children, child, atom, text, integer, normalize, propertyValue };
