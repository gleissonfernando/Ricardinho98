import assert from "node:assert/strict";
import test from "node:test";
import type { DmSettings, SummonsRecord, SummonsSettings } from "../apiClient";
import { createDmMessageModal, createSummonsMessageModal, dmPayload, summonsDmPayload, summonsPanel } from "../communicationService";

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

const summonsSettings: SummonsSettings = {
  authorizedRoleIds: ["111111"],
  bannerUrl: null,
  botId: "bot",
  categoryId: null,
  color: "#f59e0b",
  defaultMessage: "Responda neste canal.",
  deleteDelaySeconds: 10,
  dmButtonText: "Responder intimação",
  dmDescription: "Acesse o canal para responder.",
  dmTitle: "Você recebeu uma intimação",
  enabled: true,
  guildId: "guild",
  id: "settings",
  logChannelId: null,
  moderatorRoleIds: ["222222"],
  publicResponsibleName: "Equipe NPD",
  temporaryCategoryId: null,
  transcriptEnabled: true
};

const summons: SummonsRecord = {
  botId: "bot", channelId: "444444", closedAt: null, closedBy: null, createdAt: new Date().toISOString(),
  deleteAt: null, dmDeliveryError: null, dmDeliveryStatus: "sent", dmMessageId: "555555", guildId: "333333",
  id: "summons-id", notes: null, panelMessageId: "666666", reason: "Comparecimento", requesterId: "777777",
  settingsSnapshot: {}, status: "active", targetId: "888888", transcript: null, updatedAt: new Date().toISOString()
};

test("painel e DM de intimação ocultam o criador real", () => {
  const panel = JSON.stringify(summonsPanel(summonsSettings, summons));
  const dm = JSON.stringify(summonsDmPayload(summonsSettings, summons, summons.guildId, summons.channelId!));
  assert.doesNotMatch(panel, new RegExp(summons.requesterId));
  assert.doesNotMatch(dm, new RegExp(summons.requesterId));
  assert.match(panel, /Equipe AB/);
  assert.match(dm, /Acessar conversa/);
  assert.ok(dm.includes("discord.com/channels/333333/444444"));
});

test("modal da Equipe AB possui somente a descrição obrigatória", () => {
  const modal = createSummonsMessageModal("888888").toJSON();
  const rows = modal.components as Array<{ components: Array<{ custom_id?: string; max_length?: number; required?: boolean }> }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.components[0]?.custom_id, "description");
  assert.equal(rows[0]?.components[0]?.max_length, 1000);
  assert.equal(rows[0]?.components[0]?.required, true);
});
