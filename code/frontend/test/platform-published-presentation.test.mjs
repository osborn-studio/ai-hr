import test from 'node:test';
import assert from 'node:assert/strict';
import {graphEdges, operatorBindingLabel, workflowCanvasNodes} from '../src/platform-model.mjs';

test('published label-free graph has readable finite display nodes without changing its source', () => {
  const graph={nodes:[{id:'s',type:'start',next:'a'},{id:'a',type:'approval',role_codes:['group_hr'],next:'n'},{id:'n',type:'notify',recipient_ids:['9007199254740993'],next:'e'},{id:'e',type:'end'}]};
  const original=JSON.stringify(graph),nodes=workflowCanvasNodes(graph,{roles:[{code:'group_hr',name:'集团HR总监'}],operators:[{id:'9007199254740993',display_name:'宋知行'}]});
  assert.deepEqual(nodes.map(n=>n.label),['开始','集团HR总监 · 审批','宋知行 · 抄送','结束']);
  assert.ok(nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)));
  assert.equal(graphEdges({nodes}).length,3);assert.equal(JSON.stringify(graph),original);
});
test('explicit names and coordinates remain exact while absent private options use a generic type', () => {
  const nodes=workflowCanvasNodes({nodes:[{id:'a',type:'approval',label:'门店复核',x:23,y:47},{id:'n',type:'notify',approver_ids:['99']},{id:'x',type:'future'}]});
  assert.equal(nodes[0].label,'门店复核');assert.equal(nodes[0].x,23);assert.equal(nodes[0].y,47);
  assert.equal(nodes[1].label,'抄送');assert.equal(nodes[2].label,'流程节点');
});
test('binding display distinguishes a disclosed empty binding from a hidden field', () => {
  assert.equal(operatorBindingLabel({person_id:'9007199254740993',person_number:'TY-2026-004'}),'TY-2026-004');
  assert.equal(operatorBindingLabel({person_id:'9007199254740993'}),'#9007199254740993');
  assert.equal(operatorBindingLabel({person_id:null,person_number:null}),'未绑定人员');
  assert.equal(operatorBindingLabel({}),'未获授权');
});
