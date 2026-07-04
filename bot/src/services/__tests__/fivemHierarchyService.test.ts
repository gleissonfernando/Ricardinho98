import assert from 'node:assert/strict';
import test from 'node:test';
import { getHierarchyPanelVisualIds } from '../fivemHierarchyService';

test('gera ids de visual exclusivos para cada painel de hierarquia', () => {
  assert.deepStrictEqual(getHierarchyPanelVisualIds('fivem-hierarchy'), [
    'fivem-hierarchy',
    'fivem-hierarchy-banner-2',
    'fivem-hierarchy-banner-3'
  ]);

  assert.deepStrictEqual(getHierarchyPanelVisualIds('panel-abc'), [
    'panel-abc',
    'panel-abc-banner-2',
    'panel-abc-banner-3'
  ]);
});
