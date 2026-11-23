// The card's Build offer (#14 HANDOFF-12): held to the fog line, as the Fog lens measures fog (#44 FOG-05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/model/tree.js';
import { BUILD_FOG, buildOffer } from '../src/model/build.js';

const body = (rows) => `Part of #1\n\n## Why\n\nBecause.\n\n## Behaviours\n\n${rows.join('\n')}\n`;
const rows = (clear, foggy) => [...Array.from({ length: clear }, (_, i) => `- AB-${i + 1} Given a, when b, then c.`), ...Array.from({ length: foggy }, (_, i) => `- AB-${clear + i + 1} Not worked out yet: d.`)];
const item = (id, parentId, behaviours, extra = {}) => ({ id, parentId, title: `#${id.slice(1)} ${id}`, kind: 'task', status: 'ready', body: behaviours ? body(behaviours) : 'Part of #1', url: `https://github.com/o/r/issues/${id.slice(1)}`, ...extra });

test('HANDOFF-12 Build is offered only under 15% fog, the share of behaviours not worked out yet; above it the card says how foggy and why, always as a percentage', () => {
  const tree = buildTree([
    { id: 'root', kind: 'project', title: 'App' },
    item('i1', 'root', null, { kind: 'feature' }),
    item('i2', 'i1', rows(2, 0)),
    item('i3', 'i1', rows(3, 2)),
    item('i5', 'root', rows(6, 1)),
    item('i4', 'root', null),
  ]);
  const builds = { buildable: { 'issue-2': ['AB-1', 'AB-2'], 'issue-3': ['AB-1', 'AB-2', 'AB-3'], 'issue-5': ['AB-1'] }, missing: { 'issue-4': ['It has no behaviours yet: write them.'] } };
  assert.equal(BUILD_FOG, 15);

  const clear = buildOffer(tree.byId.get('i2'), builds);
  assert.deepEqual([clear.fog, clear.offer, clear.foggy], [0, ['AB-1', 'AB-2'], false], 'every behaviour worked out: Build is offered');
  assert.deepEqual(buildOffer(tree.byId.get('i5'), builds).offer, ['AB-1'], '1 of 7 not worked out is 14%, under the line');

  const foggy = buildOffer(tree.byId.get('i3'), builds);
  assert.deepEqual([foggy.fog, foggy.offer, foggy.foggy, foggy.why], [40, [], true, ['2 of 5 behaviours not worked out yet']], 'too foggy: no Build, and the card says why');

  const parent = buildOffer(tree.byId.get('i1'), builds);
  assert.ok(Number.isInteger(parent.fog) && parent.fog >= BUILD_FOG && parent.fog < foggy.fog, `a parent is as foggy as its parts: ${parent.fog}%`);
  assert.deepEqual(parent.why, ['#3 i3: 2 of 5 behaviours not worked out yet'], 'and names the foggy part');

  const bare = buildOffer(tree.byId.get('i4'), builds);
  assert.deepEqual([bare.fog, bare.offer], [100, []], 'no behaviours is all fog');
  assert.deepEqual(bare.missing, ['It has no behaviours yet: write them.'], 'what the server says it lacks comes with it');
});
