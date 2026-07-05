import { Collection } from "discord.js";
import { banCommand } from "./ban";
import { advertirCommand } from "./advertir";
import { clearCommand } from "./clear";
import { configCommand } from "./config";
import { deleteServeCommand } from "./deleteServe";
import { dmCommand, dmConfigCommand } from "./dm";
import { emojiClonerCommand } from "./emojiCloner";
import { gravarCommand } from "./gravar";
import { fivemOrdersCommand } from "./fivemOrders";
import { fivemFinanceCommand } from "./fivemFinance";
import { hierarchyCommand } from "../services/fivemHierarchyService";
import { legacyManualRegistrationCommand, manualRegistrationCommand } from "./manualRegistration";
import { missionPanelCommand } from "./missionPanel";
import { musicCommands } from "./music";
import { pingCommand } from "./ping";
import { serverClonerCommand } from "./serverCloner";
import { serverGeneratorCommand } from "./serverGenerator";
import { ticketCommand } from "./ticket";
import { summonsCommand } from "./summons";
import { policePatrolReportCommand, viewPolicePatrolReportCommand } from "./policePatrolReports";
import { policeReportsCommand } from "../services/policeReportsService";
import { notifyOpenPointCommand, notifyOpenPointConfigCommand, notifyOpenPointCounterCommand, notifyOpenPointResetCommand } from "../services/openPointNotificationService";
import { removeCommand } from "../services/absenceRemovalService";
import type { BotCommand } from "../types";

export function createCommandCollection() {
  const commands = new Collection<string, BotCommand>();

  [
    pingCommand,
    advertirCommand,
    banCommand,
    clearCommand,
    configCommand,
    deleteServeCommand,
    dmCommand,
    dmConfigCommand,
    emojiClonerCommand,
    gravarCommand,
    fivemFinanceCommand,
    fivemOrdersCommand,
    hierarchyCommand,
    manualRegistrationCommand,
    legacyManualRegistrationCommand,
    missionPanelCommand,
    ...musicCommands,
    ticketCommand,
    summonsCommand,
    policePatrolReportCommand,
    viewPolicePatrolReportCommand,
    policeReportsCommand,
    notifyOpenPointCommand,
    notifyOpenPointCounterCommand,
    notifyOpenPointResetCommand,
    notifyOpenPointConfigCommand,
    removeCommand,
    serverClonerCommand,
    serverGeneratorCommand
  ].forEach((command) => {
    if (commands.has(command.data.name)) {
      throw new Error(`Comando duplicado registrado: /${command.data.name}`);
    }

    commands.set(command.data.name, command);
  });

  return commands;
}
