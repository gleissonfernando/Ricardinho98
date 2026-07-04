import assert from "node:assert/strict";
import test from "node:test";
import { normalizeArchiveReason } from "../policePatrolReportService";

test("normaliza motivo de finalizacao para arquivamento", () => {
  assert.equal(normalizeArchiveReason("  Relatório encerrado  "), "Relatório encerrado");
  assert.equal(normalizeArchiveReason("   "), null);
  assert.equal(normalizeArchiveReason(null), null);
});
