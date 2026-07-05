import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDafConfig } from "../policeFlightService";

test("usa panelChannelId como canal canonico mesmo quando a lista legada aponta para outro canal", () => {
  const config = normalizeDafConfig({
    enabled: true,
    panelChannelId: "222222",
    panelChannelIds: ["111111"]
  });

  assert.equal(config.panelChannelId, "222222");
  assert.deepEqual(config.panelChannelIds, ["222222"]);
});

test("migra o primeiro canal legado somente quando panelChannelId nao existe", () => {
  const config = normalizeDafConfig({
    enabled: true,
    panelChannelIds: ["111111"]
  });

  assert.equal(config.panelChannelId, "111111");
  assert.deepEqual(config.panelChannelIds, ["111111"]);
});

test("respeita limites de pilotos e atiradores configurados na dashboard", () => {
  const config = normalizeDafConfig({
    maxPilots: 2,
    maxShooters: 3,
    pilotIds: ["111111", "222222", "333333"],
    shooterIds: ["444444", "555555", "666666", "777777"]
  });

  assert.equal(config.maxPilots, 2);
  assert.equal(config.maxShooters, 3);
  assert.deepEqual(config.pilotIds, ["111111", "222222"]);
  assert.deepEqual(config.shooterIds, ["444444", "555555", "666666"]);
});

test("usa enterButtonText da dashboard como fallback dos botoes de entrada", () => {
  const config = normalizeDafConfig({
    enterButtonText: "Entrar na escala"
  });

  assert.equal(config.enterPilotButtonText, "Entrar na escala");
  assert.equal(config.enterShooterButtonText, "Entrar na escala");
});

test("migra textos padrao antigos para o novo fluxo de entrar sair e encerrar", () => {
  const config = normalizeDafConfig({
    closeButtonText: "Fechar Escalacao",
    enterButtonText: "Abrir Escalacao de Voo"
  });

  assert.equal(config.enterButtonText, "Entrar na Escalacao");
  assert.equal(config.leaveButtonText, "Sair da Escalacao");
  assert.equal(config.closeButtonText, "Encerrar Escalacao");
});
