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
