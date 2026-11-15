import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, sexpression } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('单页符号与两次子图放置是不同原声明',()=>{
  const result=inspect(primary);assert.equal(result.sheets.length,2);
  assert.notEqual(result.sheets[0].uuid,result.sheets[1].uuid);assert.equal(result.symbols[0].library,'Logic:U');
});
test('复用子图的路径实例仍保存在原件内',async()=>{
  const raw=(await resource('/child.kicad_sch')).toString();
  assert.match(raw,/root\/sheet-a/);assert.match(raw,/root\/sheet-b/);
  assert.equal(inspect(Buffer.from(raw)).symbols[0].unit,'2');
});
test('平衡检查和根类型校验',()=>{
  assert.throws(()=>sexpression('(a (b)'));assert.throws(()=>sexpression('(a))'));
  assert.throws(()=>inspect(Buffer.from('(not_schematic)')));
});
