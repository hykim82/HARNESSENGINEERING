import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Design report §7's minimum skeleton, verbatim section order -- schema
// tested below (G10) so a future edit that silently drops a section is
// caught mechanically, not just by eyeballing a sample report.
export const REPORT_SECTIONS = ["run_id", "요약", "인벤토리", "스모크", "드리프트", "한계·판정불가", "영수증"];

// Tallies inventory results into the fixed 5-state summary line.
export function summarizeInventory(inventoryResults) {
  const summary = { ALIVE: 0, SILENT_BROKEN: 0, DRIFT: 0, UNJUDGABLE: 0, NOT_INSTALLED: 0 };
  for (const r of inventoryResults) summary[r.status]++;
  return summary;
}

// Every non-ALIVE inventory result becomes a drift row -- severity is the
// status itself (NOT_INSTALLED/SILENT_BROKEN/DRIFT/UNJUDGABLE all count as
// "needs a human/ORCH look," not just literal DRIFT), owner comes from the
// manifest entry, repair is the check's own evidence string (already a
// human-actionable reason, not re-summarized), due is left blank (this
// task's scope is detection, not scheduling a fix).
export function buildDriftRows(inventoryResults, manifestById) {
  return inventoryResults
    .filter((r) => r.status !== "ALIVE")
    .map((r) => ({
      id: r.id,
      severity: r.status,
      owner: manifestById[r.id]?.owner ?? "unknown",
      repair: r.evidence.join("; "),
      due: manifestById[r.id]?.known_drift_note ? "이월(사이클3)" : "다음 selfcheck 실행 전",
    }));
}

function mdEscape(cell) {
  return String(cell ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function table(headers, rows) {
  const headerLine = `| ${headers.join(" | ")} |`;
  const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.map((row) => `| ${row.map(mdEscape).join(" | ")} |`);
  return [headerLine, sepLine, ...bodyLines].join("\n");
}

// Pure function: every value the report needs is a parameter (no file I/O,
// no Date.now()/process.version reads inside) -- same text-in/struct-out
// shape as every other check module in this repo, so it's fully unit
// testable without a real filesystem or a real check run.
export function buildReport({
  runId,
  taskId,
  capturedAt,
  repoHead,
  runtimeVersions,
  nextDue,
  manifestById,
  inventoryResults,
  smokeCases,
  limitations = [],
  receipts = [],
}) {
  const summary = summarizeInventory(inventoryResults);
  const driftRows = buildDriftRows(inventoryResults, manifestById);

  const lines = [];
  lines.push(`# 강제층 자가검증 리포트 (selfcheck, HYK-129)`);
  lines.push("");
  lines.push(`run_id: ${runId}`);
  lines.push(`task_id: ${taskId}`);
  lines.push(`captured_at: ${capturedAt}`);
  lines.push(`repo HEAD: ${repoHead}`);
  lines.push(`runtime versions: ${runtimeVersions}`);
  lines.push(`next_due: ${nextDue}`);
  lines.push("");
  lines.push(`## 요약`);
  lines.push(
    `ALIVE ${summary.ALIVE} · SILENT_BROKEN ${summary.SILENT_BROKEN} · DRIFT ${summary.DRIFT} · UNJUDGABLE ${summary.UNJUDGABLE} · NOT_INSTALLED ${summary.NOT_INSTALLED}`,
  );
  lines.push("");
  lines.push(`## 인벤토리`);
  lines.push(
    table(
      ["id", "substrate", "install target", "expected", "observed", "status", "evidence"],
      inventoryResults.map((r) => {
        const entry = manifestById[r.id] ?? {};
        const targets = (entry.install_targets ?? []).map((t) => t.location ?? t.kind).join(", ") || "(direct/indirect)";
        return [r.id, entry.substrate ?? "?", targets, entry.expected_good ?? "?", r.status, r.status, r.evidence.join("; ")];
      }),
    ),
  );
  lines.push("");
  lines.push(`## 스모크`);
  lines.push(
    table(
      ["id", "bad result", "good result", "exit/reason", "Claude feedback", "status"],
      smokeCases.map((c) => [
        c.id,
        c.variant === "bad" ? (c.pass ? "PASS" : "FAIL") : "-",
        c.variant === "good" ? (c.pass ? "PASS" : "FAIL") : "-",
        c.actualExit !== undefined ? `exit=${c.actualExit}` : `ok=${c.actualOk}`,
        "N/A (temp fixture CLI/logic smoke, not a live Claude Stop canary -- see 한계)",
        c.pass ? "PASS" : "FAIL",
      ]),
    ),
  );
  lines.push("");
  lines.push(`## 드리프트`);
  lines.push(
    driftRows.length > 0
      ? table(
          ["id", "severity", "owner", "repair action", "due"],
          driftRows.map((d) => [d.id, d.severity, d.owner, d.repair, d.due]),
        )
      : "(없음 -- 이번 실행에서 전 항목 ALIVE)",
  );
  lines.push("");
  lines.push(`## 한계·판정불가`);
  for (const l of limitations) lines.push(`- ${l}`);
  if (limitations.length === 0) lines.push("- (없음)");
  lines.push("");
  lines.push(`## 영수증`);
  for (const r of receipts) lines.push(`- ${r}`);
  if (receipts.length === 0) lines.push("- (없음)");
  lines.push("");

  return lines.join("\n");
}

export function writeReport(path, text) {
  writeFileSync(path, text, "utf8");
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/selfcheck-report.mjs");
if (invokedDirectly) {
  console.error("selfcheck-report.mjs is a library invoked by selfcheck.mjs; it has no standalone CLI mode of its own.");
  process.exit(1);
}
