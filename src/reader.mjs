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
export function inspect(bytes) {
  const root = sexpression(bytes.toString('utf8'));
  if (root[0] !== 'kicad_sch') throw new Error('schematic_root');
  const named = (node, name) => node.filter(item => Array.isArray(item) && item[0] === name);
  return { kind: 'schematic-page', uuid: named(root, 'uuid')[0]?.[1],
    symbols: named(root, 'symbol').map(symbol => ({
      uuid: named(symbol, 'uuid')[0]?.[1], library: named(symbol, 'lib_id')[0]?.[1],
      unit: named(symbol, 'unit')[0]?.[1], properties: named(symbol, 'property').map(item => [item[1], item[2]]) })),
    sheets: named(root, 'sheet').map(sheet => ({ uuid: named(sheet, 'uuid')[0]?.[1],
      properties: named(sheet, 'property').map(item => [item[1], item[2]]) })) };
}
