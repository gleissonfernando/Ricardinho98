import assert from "node:assert/strict";
import test from "node:test";
import type { DmSettings } from "../apiClient";
import { createDmMessageModal, dmPayload } from "../communicationService";

const settings: DmSettings = {
  authorizedRoleIds: [],
  bannerUrl: null,
  blockBots: true,
  botId: "bot",
  buttons: [],
  color: "#5865f2",
  defaultText: "Você recebeu uma nova mensagem da equipe.",
  defaultTitle: "Mensagem da equipe",
  enabled: true,
  footerText: null,
  guildId: "guild",
  id: "settings",
  imagePosition: "none",
  imageUrl: null,
  logChannelId: null
};

test("modal de DM possui somente titulo e mensagem com limites curtos", () => {
  const modal = createDmMessageModal(settings, "123456").toJSON();
  const rows = modal.components as Array<{ components: Array<{ custom_id?: string; max_length?: number }> }>;
  assert.equal(modal.components.length, 2);
  assert.deepEqual(rows.map((row) => row.components[0]?.custom_id), ["title", "description"]);
  assert.deepEqual(rows.map((row) => row.components[0]?.max_length), [60, 300]);
});

test("DM Components V2 mostra identidade da equipe sem expor o staff", () => {
  const payload = dmPayload(settings, "Aviso", "Mensagem curta", "Human Resources - NPD");
  const serialized = JSON.stringify(payload);
  assert.equal(payload.flags, 32768);
  assert.match(serialized, /Mensagem da equipe/);
  assert.match(serialized, /Equipe Human Resources - NPD/);
  assert.doesNotMatch(serialized, /staff|responsável/i);
});
