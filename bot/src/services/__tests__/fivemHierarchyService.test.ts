import assert from 'node:assert/strict';
import test from 'node:test';
import { collectHierarchyMembersForPanel, getHierarchyPanelVisualIds } from '../fivemHierarchyService';

test('gera ids de visual exclusivos para cada painel de hierarquia', () => {
  assert.deepStrictEqual(
    getHierarchyPanelVisualIds('fivem-hierarchy'),
    ['fivem-hierarchy', ...Array.from({ length: 7 }, (_, index) => `fivem-hierarchy-banner-${index + 2}`)]
  );

  assert.deepStrictEqual(
    getHierarchyPanelVisualIds('panel-abc'),
    ['panel-abc', ...Array.from({ length: 7 }, (_, index) => `panel-abc-banner-${index + 2}`)]
  );
});

test('mantem o mesmo membro em todos os paineis onde possui cargo', () => {
  const member = fakeMember('user-1', ['role-daf', 'role-swat']);
  const guild = fakeGuild([member]);
  const dafPanel = fakePanel('panel-daf', 'daf', 'role-daf');
  const swatPanel = fakePanel('panel-swat', 'swat', 'role-swat');

  const dafMembers = collectHierarchyMembersForPanel(guild as any, dafPanel as any);
  const swatMembers = collectHierarchyMembersForPanel(guild as any, swatPanel as any);

  assert.deepStrictEqual(dafMembers.map((entry) => `${entry.panelId}:${entry.blockId}:${entry.userId}`), ['panel-daf:block-daf:user-1']);
  assert.deepStrictEqual(swatMembers.map((entry) => `${entry.panelId}:${entry.blockId}:${entry.userId}`), ['panel-swat:block-swat:user-1']);
});

test('usa a colecao de membros retornada pelo fetch para montar o painel', () => {
  const member = fakeMember('user-1', ['role-traffic']);
  const members = fakeMemberCollection([member]);
  const panel = fakePanel('panel-traffic', 'traffic', 'role-traffic');

  const trafficMembers = collectHierarchyMembersForPanel(members as any, panel as any);

  assert.deepStrictEqual(trafficMembers.map((entry) => `${entry.panelId}:${entry.blockId}:${entry.userId}`), ['panel-traffic:block-traffic:user-1']);
});

test('mantem o mesmo membro em dez paineis independentes quando ele possui dez cargos', () => {
  const units = ['daf', 'swat', 'pf', 'prf', 'trafico', 'bope', 'core', 'exercito', 'rota', 'pc'];
  const member = fakeMember('user-10', units.map((unit) => `role-${unit}`));
  const guild = fakeGuild([member]);

  const keys = units.flatMap((unit) => {
    const panel = fakePanel(`panel-${unit}`, unit, `role-${unit}`);
    return collectHierarchyMembersForPanel(guild as any, panel as any).map((entry) => `${entry.panelId}:${entry.blockId}:${entry.userId}`);
  });

  assert.equal(keys.length, 10);
  assert.deepStrictEqual(keys, units.map((unit) => `panel-${unit}:block-${unit}:user-10`));
});

test('mantem o mesmo membro em cinco paineis independentes sem escolher cargo principal', () => {
  const units = ['daf', 'swat', 'pf', 'prf', 'bope'];
  const member = fakeMember('user-5', units.map((unit) => `role-${unit}`));
  const guild = fakeGuild([member]);

  const appearances = units.map((unit) => {
    const panel = fakePanel(`panel-${unit}`, unit, `role-${unit}`);
    return collectHierarchyMembersForPanel(guild as any, panel as any);
  });

  assert.equal(appearances.flat().length, 5);
  assert.ok(appearances.every((entries) => entries.length === 1 && entries[0]?.userId === 'user-5'));
});

test('remove apenas do painel cujo cargo foi perdido', () => {
  const before = fakeMember('user-1', ['role-daf', 'role-swat']);
  const after = fakeMember('user-1', ['role-swat']);
  const dafPanel = fakePanel('panel-daf', 'daf', 'role-daf');
  const swatPanel = fakePanel('panel-swat', 'swat', 'role-swat');

  assert.equal(collectHierarchyMembersForPanel(fakeGuild([before]) as any, dafPanel as any).length, 1);
  assert.equal(collectHierarchyMembersForPanel(fakeGuild([after]) as any, dafPanel as any).length, 0);
  assert.equal(collectHierarchyMembersForPanel(fakeGuild([after]) as any, swatPanel as any).length, 1);
});

test('deduplica apenas dentro do mesmo bloco do mesmo painel', () => {
  const member = fakeMember('user-1', ['role-shared']);
  const guild = fakeGuild([member]);
  const panel = fakePanelWithHierarchies('panel-shared', [
    { active: true, id: 'block-a', roleId: 'role-shared' },
    { active: true, id: 'block-b', roleId: 'role-shared' },
    { active: true, id: 'block-a', roleId: 'role-shared' }
  ]);

  const keys = collectHierarchyMembersForPanel(guild as any, panel as any).map((entry) => `${entry.panelId}:${entry.blockId}:${entry.userId}`);

  assert.deepStrictEqual(keys, ['panel-shared:block-a:user-1', 'panel-shared:block-b:user-1']);
});

function fakeMember(id: string, roleIds: string[]) {
  return {
    displayName: `Member ${id}`,
    id,
    roles: {
      cache: new Map(roleIds.map((roleId) => [roleId, { id: roleId }]))
    }
  };
}

function fakeGuild(members: Array<ReturnType<typeof fakeMember>>) {
  const cache = fakeMemberCollection(members);
  return { members: { cache } };
}

function fakeMemberCollection(members: Array<ReturnType<typeof fakeMember>>) {
  const cache = new Map(members.map((member) => [member.id, member])) as Map<string, ReturnType<typeof fakeMember>> & {
    filter: (predicate: (member: ReturnType<typeof fakeMember>) => boolean) => Map<string, ReturnType<typeof fakeMember>>;
  };
  cache.filter = (predicate) => new Map([...cache].filter(([, member]) => predicate(member)));
  return cache;
}

function fakePanel(id: string, unitId: string, roleId: string) {
  return {
    displayMode: 'mention',
    hierarchies: [{ active: true, id: `block-${unitId}`, roleId }],
    id,
    unitId
  };
}

function fakePanelWithHierarchies(id: string, hierarchies: Array<{ active: boolean; id: string; roleId: string }>) {
  return {
    displayMode: 'mention',
    hierarchies,
    id,
    unitId: id
  };
}
