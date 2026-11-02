import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseFragment } from 'parse5';
import { systemSettingsJsContent } from './ui/js/systemsettings.js';
import { BLOCKED_WORD_PRESETS } from './utils/blocked-word-presets.js';

function settingsContext() {
  const context = vm.createContext({ window: { addEventListener() {} }, document: { body: { dataset: {} }, querySelectorAll() { return []; }, getElementById(id) { return id === 'env-form' ? { addEventListener() {} } : null; }, addEventListener() {} } });
  vm.runInContext(systemSettingsJsContent, context);
  return context;
}

test('generated settings script is executable and classifies only exact presets', () => {
  const context = settingsContext();
  const classify = context.blockedWordKind;
  assert.equal(classify('打卡'), '普通词');
  assert.equal(classify('/foo{1,3}/i'), '其他正则');
  assert.equal(classify('/时间|地区/u'), '其他正则');
  for (const value of BLOCKED_WORD_PRESETS.content) assert.equal(classify(value), '纯数字/符号正则');
  for (const value of BLOCKED_WORD_PRESETS.dates) assert.equal(classify(value), '日期时间正则');
  for (const value of BLOCKED_WORD_PRESETS.regions) assert.equal(classify(value), '地区正则');
  assert.equal(classify(BLOCKED_WORD_PRESETS.dates[0].replace('/u', '/i')), '其他正则');
});

test('grouping preserves original edit indexes and serialized order', () => {
  const context = settingsContext();
  const rows = ['/foo{1,3}/i', '打卡', BLOCKED_WORD_PRESETS.dates[1], '签到', '前排', '来了'];
  const groups = context.groupBlockedWords(rows);
  assert.deepEqual(Array.from(groups, g => g.kind), ['普通词', '日期时间正则', '其他正则']);
  assert.deepEqual(Array.from(groups[0].entries, entry => entry.index), [1, 3, 4, 5]);
  assert.deepEqual(Array.from(context.splitBlockedWords(context.serializeBlockedWords(rows))), rows);
});

function summaryNodes(html) {
 const nodes=[];
 function visit(node) {if(node.tagName)nodes.push(node);for(const child of node.childNodes||[])visit(child);}
 visit(parseFragment(html));return nodes;
}
function nodeText(node) {return node.value||(node.childNodes||[]).map(nodeText).join('');}
function classOf(node) {return node.attrs.find(attr=>attr.name==='class')?.value||'';}
function renderingContext() {
 const context=settingsContext();
 context.escapeHtml=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 return context;
}

test('compact classified previews retain full regex text and identify regex typography',()=>{
 const context=renderingContext();
 const rows=['打卡','签到',...BLOCKED_WORD_PRESETS.dates,...BLOCKED_WORD_PRESETS.regions];
 const html=context.renderBlockedWordSummary(context.serializeBlockedWords(rows));
 const nodes=summaryNodes(html),previews=nodes.filter(n=>classOf(n).split(' ').includes('blocked-word-group-preview'));
 assert.equal(previews.length,3);
 assert.equal(nodeText(previews[0]),'打卡，签到');
 assert.equal(nodeText(previews[1]),BLOCKED_WORD_PRESETS.dates.join('，'));
 assert.equal(nodeText(previews[2]),BLOCKED_WORD_PRESETS.regions.join('，'));
 assert.ok(!classOf(previews[0]).includes('blocked-word-regex-preview'));
 for(const node of previews.slice(1))assert.ok(classOf(node).includes('blocked-word-regex-preview'));
 assert.deepEqual(Array.from(context.splitBlockedWords(context.serializeBlockedWords(rows))),rows);
});

test('blocked-word layout is scoped to its card and leaves other settings unchanged',()=>{
 const context=renderingContext();
 for(const key of ['BLOCKED_WORDS','BLOCK_DOMESTIC_CELEBRITIES','COLOR_POOL']){
  const html=context.renderEnvItem({key,type:'text',value:'打卡',description:'说明'},'danmu',0);
  const card=summaryNodes(html).find(n=>classOf(n).split(' ').includes('env-item'));
  assert.equal(classOf(card).includes('env-item-blocked-words'),key==='BLOCKED_WORDS');
  assert.equal(summaryNodes(html).filter(n=>n.tagName==='button').length,2);
 }
});
