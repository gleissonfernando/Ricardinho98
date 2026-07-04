import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  MessageFlags, ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder, TextInputBuilder,
  TextInputStyle, type ChatInputCommandInteraction, type GuildMember, type Interaction
} from "discord.js";
import type { BotContext } from "../types";
import type { DmButtonConfig, DmSettings, SummonsRecord, SummonsSettings } from "./apiClient";

const DM_PREFIX = "dm_system";
const SUMMONS_PREFIX = "summons";

export async function showDmModal(interaction: ChatInputCommandInteraction, context: BotContext) {
  const settings = await context.api.getDmSettings(interaction.guildId!);
  if (!settings.enabled) return void await interaction.reply({ content: "O Sistema de DM está desativado.", ephemeral: true });
  if (!hasRole(interaction.member as GuildMember, settings.authorizedRoleIds) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return void await interaction.reply({ content: "Você não possui um cargo autorizado.", ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId(`${DM_PREFIX}:send`).setTitle("Enviar mensagem privada");
  modal.addComponents(
    input("target", "ID ou menção do usuário", "123456789012345678", true),
    input("title", "Título", settings.defaultTitle, true),
    input("description", "Descrição", settings.defaultText, true, true),
    input("button_label", "Texto do botão (opcional)", "Abrir painel", false),
    input("button_url", "URL do botão (opcional)", "https://...", false)
  );
  await interaction.showModal(modal);
}

export async function showDmConfigPanel(interaction: ChatInputCommandInteraction, context: BotContext) {
  const settings = await context.api.getDmSettings(interaction.guildId!);
  await interaction.reply(configPayload("Sistema de DM", [
    `**Status:** ${settings.enabled ? "Ativo" : "Inativo"}`,
    `**Cargos autorizados:** ${settings.authorizedRoleIds.length || "Nenhum"}`,
    `**Canal de logs:** ${settings.logChannelId ? `<#${settings.logChannelId}>` : "Não definido"}`,
    `**Cor:** ${settings.color}`
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${DM_PREFIX}:toggle`).setLabel(settings.enabled ? "Desativar" : "Ativar").setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${DM_PREFIX}:visual`).setLabel("Visual e banner").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${DM_PREFIX}:test`).setLabel("Testar envio").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(`${DM_PREFIX}:roles`).setPlaceholder("Cargos autorizados").setMinValues(0).setMaxValues(10)),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${DM_PREFIX}:logs`).setPlaceholder("Canal de logs").setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1))
  ]));
}

export async function showSummonsModal(interaction: ChatInputCommandInteraction, context: BotContext) {
  const settings = await context.api.getSummonsSettings(interaction.guildId!);
  if (!settings.enabled) return void await interaction.reply({ content: "O Sistema de Intimação está desativado.", ephemeral: true });
  if (!hasRole(interaction.member as GuildMember, settings.authorizedRoleIds) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return void await interaction.reply({ content: "Você não possui um cargo autorizado.", ephemeral: true });
  }
  const modal = new ModalBuilder().setCustomId(`${SUMMONS_PREFIX}:create`).setTitle("Criar intimação");
  modal.addComponents(
    input("target", "ID ou menção do usuário", "123456789012345678", true),
    input("reason", "Motivo da intimação", "Descreva o motivo", true, true),
    input("notes", "Observações (opcional)", "Informações adicionais", false, true)
  );
  await interaction.showModal(modal);
}

export async function showSummonsConfigPanel(interaction: ChatInputCommandInteraction, context: BotContext) {
  const settings = await context.api.getSummonsSettings(interaction.guildId!);
  await interaction.reply(configPayload("Sistema de Intimação", [
    `**Status:** ${settings.enabled ? "Ativo" : "Inativo"}`,
    `**Categoria:** ${settings.categoryId ? `<#${settings.categoryId}>` : "Não definida"}`,
    `**Logs:** ${settings.logChannelId ? `<#${settings.logChannelId}>` : "Não definido"}`,
    `**Exclusão:** ${settings.deleteDelaySeconds}s`
  ], [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:toggle`).setLabel(settings.enabled ? "Desativar" : "Ativar").setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:visual`).setLabel("Visual e tempo").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:test`).setLabel("Testar sistema").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${SUMMONS_PREFIX}:category`).setPlaceholder("Categoria dos canais").setChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(1)),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId(`${SUMMONS_PREFIX}:logs`).setPlaceholder("Canal de logs").setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1)),
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(`${SUMMONS_PREFIX}:roles`).setPlaceholder("Cargos autorizados").setMinValues(0).setMaxValues(10)),
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId(`${SUMMONS_PREFIX}:moderators`).setPlaceholder("Corregedoria / moderação").setMinValues(0).setMaxValues(10))
  ]));
}

export async function handleCommunicationInteraction(interaction: Interaction, context: BotContext) {
  if (!(interaction.isMessageComponent() || interaction.isModalSubmit())) return false;
  if (!interaction.isRepliable() || (!interaction.customId.startsWith(`${DM_PREFIX}:`) && !interaction.customId.startsWith(`${SUMMONS_PREFIX}:`))) return false;
  if (!interaction.guildId || !interaction.guild) return false;
  if (interaction.customId.startsWith(`${DM_PREFIX}:`)) await handleDm(interaction, context);
  else await handleSummons(interaction, context);
  return true;
}

async function handleDm(interaction: any, context: BotContext) {
  const action = interaction.customId.split(":")[1];
  const settings = await context.api.getDmSettings(interaction.guildId);
  if (action === "send" && interaction.isModalSubmit()) {
    await interaction.deferReply({ ephemeral: true });
    const targetId = snowflakeFrom(interaction.fields.getTextInputValue("target"));
    const title = interaction.fields.getTextInputValue("title").trim();
    const description = interaction.fields.getTextInputValue("description").trim();
    const label = interaction.fields.getTextInputValue("button_label").trim();
    const url = interaction.fields.getTextInputValue("button_url").trim();
    const button: DmButtonConfig | null = label && /^https?:\/\//i.test(url) ? { id: "custom", label, style: "link", url } : null;
    let status: "sent" | "failed" = "sent"; let error: string | null = null;
    try {
      const user = await context.client.users.fetch(targetId);
      await user.send(dmPayload(settings, title, description, button));
    } catch (caught) { status = "failed"; error = messageOf(caught); }
    await context.api.recordDm({ guildId: interaction.guildId, senderId: interaction.user.id, targetId, title, description, button, status, error });
    await sendDmLog(interaction, settings, targetId, title, status, error);
    await interaction.editReply(status === "sent" ? `DM enviada para <@${targetId}>.` : `Não foi possível enviar a DM: ${error}`);
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return void await interaction.reply({ content: "Você precisa de Gerenciar Servidor.", ephemeral: true });
  if (action === "toggle" && interaction.isButton()) {
    await interaction.deferUpdate(); await context.api.saveDmSettings(interaction.guildId, { enabled: !settings.enabled }); await interaction.editReply({ content: `Sistema ${!settings.enabled ? "ativado" : "desativado"}.`, components: [] }); return;
  }
  if (action === "roles" && interaction.isRoleSelectMenu()) { await interaction.deferUpdate(); await context.api.saveDmSettings(interaction.guildId, { authorizedRoleIds: interaction.values }); await interaction.editReply({ content: "Cargos atualizados.", components: [] }); return; }
  if (action === "logs" && interaction.isChannelSelectMenu()) { await interaction.deferUpdate(); await context.api.saveDmSettings(interaction.guildId, { logChannelId: interaction.values[0] }); await interaction.editReply({ content: "Canal de logs atualizado.", components: [] }); return; }
  if (action === "visual" && interaction.isButton()) {
    const modal = new ModalBuilder().setCustomId(`${DM_PREFIX}:save_visual`).setTitle("Visual da DM").addComponents(input("color", "Cor hexadecimal", settings.color, true), input("title", "Título padrão", settings.defaultTitle, true), input("text", "Texto padrão", settings.defaultText, true, true), input("footer", "Rodapé", settings.footerText ?? "", false), input("banner", "URL do banner", settings.bannerUrl ?? "", false));
    await interaction.showModal(modal); return;
  }
  if (action === "save_visual" && interaction.isModalSubmit()) {
    await interaction.deferReply({ ephemeral: true }); await context.api.saveDmSettings(interaction.guildId, { color: normalizedColor(interaction.fields.getTextInputValue("color")), defaultTitle: interaction.fields.getTextInputValue("title"), defaultText: interaction.fields.getTextInputValue("text"), footerText: nullable(interaction.fields.getTextInputValue("footer")), bannerUrl: nullable(interaction.fields.getTextInputValue("banner")) }); await interaction.editReply("Visual atualizado."); return;
  }
  if (action === "test" && interaction.isButton()) { await interaction.reply({ ...dmPayload(settings, settings.defaultTitle, settings.defaultText, settings.buttons[0] ?? null), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }); }
}

async function handleSummons(interaction: any, context: BotContext) {
  const [action, id] = interaction.customId.split(":").slice(1);
  const settings = await context.api.getSummonsSettings(interaction.guildId);
  if (action === "create" && interaction.isModalSubmit()) {
    await interaction.deferReply({ ephemeral: true });
    const targetId = snowflakeFrom(interaction.fields.getTextInputValue("target"));
    const record = await context.api.createSummons({ guildId: interaction.guildId, targetId, requesterId: interaction.user.id, reason: interaction.fields.getTextInputValue("reason"), notes: nullable(interaction.fields.getTextInputValue("notes")) });
    try {
      const channel = await createSummonsChannel(interaction, settings, record);
      const panel = await channel.send(summonsPanel(settings, record));
      await context.api.updateSummons(record.id, { channelId: channel.id, panelMessageId: panel.id, status: "active" });
      await interaction.editReply(`📢 Intimação criada com sucesso.\nAcesse o canal: <#${channel.id}>`);
      await sendSummonsLog(interaction, settings, record, "criada");
    } catch (error) { await context.api.updateSummons(record.id, { status: "failed" }); await interaction.editReply(`Falha ao criar a intimação: ${messageOf(error)}`); }
    return;
  }
  if (action === "finish" && interaction.isButton()) {
    const record = await context.api.getSummons(id!);
    if (record.requesterId !== interaction.user.id && !hasRole(interaction.member as GuildMember, settings.moderatorRoleIds)) return void await interaction.reply({ content: "Somente o responsável ou a moderação pode finalizar.", ephemeral: true });
    await interaction.reply({ components: [{ type: 17, accent_color: 0xef4444, components: [{ type: 10, content: "## Confirmar finalização\nO transcript será salvo e o canal será removido." }, new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:confirm:${record.id}`).setLabel("Confirmar").setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:cancel:${record.id}`).setLabel("Cancelar").setStyle(ButtonStyle.Secondary))] }], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }); return;
  }
  if (action === "cancel" && interaction.isButton()) return void await interaction.update({ content: "Finalização cancelada.", components: [] });
  if (action === "confirm" && interaction.isButton()) { await closeSummons(interaction, context, settings, id!); return; }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return void await interaction.reply({ content: "Você precisa de Gerenciar Servidor.", ephemeral: true });
  const dashboardPatch = async (patch: Partial<SummonsSettings>, message: string) => { await interaction.deferUpdate(); await context.api.saveSummonsSettings(interaction.guildId, patch); await interaction.editReply({ content: message, components: [] }); };
  if (action === "toggle") return dashboardPatch({ enabled: !settings.enabled }, `Sistema ${!settings.enabled ? "ativado" : "desativado"}.`);
  if (action === "category") return dashboardPatch({ categoryId: interaction.values[0] }, "Categoria atualizada.");
  if (action === "logs") return dashboardPatch({ logChannelId: interaction.values[0] }, "Canal de logs atualizado.");
  if (action === "roles") return dashboardPatch({ authorizedRoleIds: interaction.values }, "Cargos autorizados atualizados.");
  if (action === "moderators") return dashboardPatch({ moderatorRoleIds: interaction.values }, "Cargos de moderação atualizados.");
  if (action === "visual" && interaction.isButton()) { const modal = new ModalBuilder().setCustomId(`${SUMMONS_PREFIX}:save_visual`).setTitle("Visual da intimação").addComponents(input("color", "Cor hexadecimal", settings.color, true), input("message", "Mensagem padrão", settings.defaultMessage, true, true), input("banner", "URL do banner", settings.bannerUrl ?? "", false), input("delay", "Tempo para excluir (segundos)", String(settings.deleteDelaySeconds), true)); await interaction.showModal(modal); return; }
  if (action === "save_visual" && interaction.isModalSubmit()) { await interaction.deferReply({ ephemeral: true }); await context.api.saveSummonsSettings(interaction.guildId, { color: normalizedColor(interaction.fields.getTextInputValue("color")), defaultMessage: interaction.fields.getTextInputValue("message"), bannerUrl: nullable(interaction.fields.getTextInputValue("banner")), deleteDelaySeconds: Number(interaction.fields.getTextInputValue("delay")) }); await interaction.editReply("Configuração visual atualizada."); return; }
  if (action === "test") await interaction.reply({ ...summonsPanel(settings, { id: "test", targetId: interaction.user.id, requesterId: interaction.user.id, reason: "Teste do sistema", notes: null } as SummonsRecord), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
}

async function createSummonsChannel(interaction: any, settings: SummonsSettings, record: SummonsRecord) {
  const target = await interaction.guild.members.fetch(record.targetId);
  const slug = target.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 50) || record.targetId;
  return interaction.guild.channels.create({
    name: `intimacao-${slug}`, type: ChannelType.GuildText, parent: settings.temporaryCategoryId ?? settings.categoryId ?? undefined,
    permissionOverwrites: [
      { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: record.targetId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: record.requesterId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
      ...settings.moderatorRoleIds.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }))
    ],
    reason: `Intimação ${record.id}`
  });
}

async function closeSummons(interaction: any, context: BotContext, settings: SummonsSettings, id: string) {
  await interaction.deferUpdate();
  const record = await context.api.getSummons(id);
  const channel = interaction.channel;
  const transcript = settings.transcriptEnabled && channel?.isTextBased() ? await makeTranscript(channel) : null;
  const deleteAt = new Date(Date.now() + settings.deleteDelaySeconds * 1000);
  await context.api.updateSummons(id, { status: "closing", transcript, closedAt: new Date().toISOString(), closedBy: interaction.user.id, deleteAt: deleteAt.toISOString() });
  await channel?.send({ components: [{ type: 17, accent_color: 0xef4444, components: [{ type: 10, content: `## Intimação finalizada\nFinalizada por <@${interaction.user.id}>. Este canal será excluído em ${settings.deleteDelaySeconds} segundos.` }] }], flags: MessageFlags.IsComponentsV2 });
  await sendSummonsLog(interaction, settings, record, "finalizada", transcript);
  setTimeout(() => void channel?.delete(`Intimação ${id} finalizada`).then(() => context.api.updateSummons(id, { status: "closed" })).catch(() => undefined), settings.deleteDelaySeconds * 1000).unref();
}

function dmPayload(settings: DmSettings, title: string, description: string, button: DmButtonConfig | null) {
  const components: any[] = [{ type: 10, content: `# ${title}\n${description}${settings.footerText ? `\n\n-# ${settings.footerText}` : ""}` }];
  if (settings.bannerUrl) components.unshift({ type: 12, items: [{ media: { url: settings.bannerUrl }, description: title }] });
  const selected = button ?? settings.buttons[0] ?? null;
  if (selected?.url) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel(selected.label).setURL(selected.url).setStyle(ButtonStyle.Link)));
  return { components: [{ type: 17, accent_color: color(settings.color), components }], flags: MessageFlags.IsComponentsV2 as const };
}
function summonsPanel(settings: SummonsSettings, record: SummonsRecord) {
  const components: any[] = [{ type: 10, content: `# 🔔 Intimação em andamento\n<@${record.targetId}>\n\n**Motivo:** ${record.reason}\n${record.notes ? `**Observações:** ${record.notes}\n` : ""}\n${settings.defaultMessage}` }];
  if (settings.bannerUrl) components.unshift({ type: 12, items: [{ media: { url: settings.bannerUrl }, description: "Painel da Intimação" }] });
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${SUMMONS_PREFIX}:finish:${record.id}`).setLabel("Finalizar Intimação").setStyle(ButtonStyle.Danger)));
  return { components: [{ type: 17, accent_color: color(settings.color), components }], flags: MessageFlags.IsComponentsV2 as const };
}
async function sendDmLog(interaction: any, settings: DmSettings, targetId: string, title: string, status: string, error: string | null) { if (!settings.logChannelId) return; const channel = await interaction.guild.channels.fetch(settings.logChannelId).catch(() => null); if (channel?.isTextBased() && !channel.isDMBased()) await channel.send({ components: [{ type: 17, accent_color: status === "sent" ? 0x22c55e : 0xef4444, components: [{ type: 10, content: `## Log de DM\n**Autor:** <@${interaction.user.id}>\n**Destino:** <@${targetId}>\n**Título:** ${title}\n**Status:** ${status}${error ? `\n**Erro:** ${error}` : ""}` }] }], flags: MessageFlags.IsComponentsV2 }); }
async function sendSummonsLog(interaction: any, settings: SummonsSettings, record: SummonsRecord, action: string, transcript?: string | null) { if (!settings.logChannelId) return; const channel = await interaction.guild.channels.fetch(settings.logChannelId).catch(() => null); if (channel?.isTextBased() && !channel.isDMBased()) await channel.send({ components: [{ type: 17, accent_color: color(settings.color), components: [{ type: 10, content: `## Intimação ${action}\n**ID:** ${record.id}\n**Intimado:** <@${record.targetId}>\n**Responsável:** <@${record.requesterId}>\n**Motivo:** ${record.reason}${transcript ? `\n\n**Transcript:**\n${transcript.slice(0, 2500)}` : ""}` }] }], flags: MessageFlags.IsComponentsV2 }); }
async function makeTranscript(channel: any) { const messages = await channel.messages.fetch({ limit: 100 }); return [...messages.values()].reverse().map((message: any) => `[${message.createdAt.toISOString()}] ${message.author.tag}: ${message.cleanContent || "(anexo/componente)"}`).join("\n").slice(0, 490000); }
function configPayload(title: string, lines: string[], rows: any[]) { return { components: [{ type: 17, accent_color: 0x5865f2, components: [{ type: 10, content: `# ${title}\n${lines.join("\n")}` }, ...rows] }], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 }; }
function input(id: string, label: string, placeholder: string, required: boolean, paragraph = false) { return new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder.slice(0, 100)).setRequired(required).setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)); }
function hasRole(member: GuildMember, roles: string[]) { return roles.some((id) => member.roles.cache.has(id)); }
function snowflakeFrom(value: string) { const match = value.match(/\d{5,32}/); if (!match) throw new Error("Informe um ID ou menção válida."); return match[0]; }
function normalizedColor(value: string) { return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : "#5865f2"; }
function nullable(value: string) { return value.trim() || null; }
function color(value: string) { return Number.parseInt(value.replace("#", ""), 16) || 0x5865f2; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
