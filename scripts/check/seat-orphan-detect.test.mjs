import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendLaunchRecord,
  buildLaunchRecord,
} from "./seat-origin-registry.mjs";
import {
  detectOrphans,
  formatOrphanReport,
  runSeatOrphanDetectCli,
} from "./seat-orphan-detect.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_PATH = join(
  REPO_ROOT,
  "scripts",
  "check",
  "seat-orphan-detect.mjs",
);

const AGENT_PREVIEW = "✻ Welcome to Claude Code!\n  bypass permissions on\n";
const EMPTY_SHELL_PREVIEW = "PS C:\\Users\\Administrator\\somewhere>";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "seat-orphan-detect-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ★양방향 확인(coder-task.md 완료조건 464-ⓒ): 유령은 잡히고 정본은
// 안 잡히는지 하나의 시험에서 함께 확인한다.
test("detectOrphans: bidirectional -- ghost (unregistered) is flagged, canonical (registered) is not", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "seat-launch-registry.jsonl");
    // 정본: orca-worker-seat.ps1을 거쳐 등록부에 기록된 좌석.
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({
        paneKey: "canon-tab:canon-leaf",
        role: "REVIEW",
        engine: "claude",
      }),
    );
    const terminals = [
      {
        handle: "term_canonical",
        worktreePath: "C:/wt/canon",
        title: "REVIEW seat",
        tabId: "canon-tab",
        leafId: "canon-leaf",
        preview: AGENT_PREVIEW,
      },
      {
        // 유령: STATUS.md HYK-464 실측 형태 재현 -- 에이전트로 보이는데
        // 등록부에 없다(아무도 정본 런처로 띄운 기록이 없다).
        handle: "term_ghost",
        worktreePath: "",
        title: "관리자: pwsh",
        tabId: "ghost-tab",
        leafId: "ghost-leaf",
        preview: AGENT_PREVIEW,
      },
      {
        handle: "term_blank",
        worktreePath: "C:/wt/canon",
        title: "빈 셸",
        tabId: "blank-tab",
        leafId: "blank-leaf",
        preview: EMPTY_SHELL_PREVIEW,
      },
    ];
    const result = detectOrphans({ terminals, registryPath });
    const flaggedHandles = result.orphanCandidates.map((c) => c.handle);
    assert.deepEqual(flaggedHandles, ["term_ghost"]);
    assert.ok(
      !flaggedHandles.includes("term_canonical"),
      "registered seat must NOT be flagged",
    );
    assert.ok(
      !flaggedHandles.includes("term_blank"),
      "empty shell is never a disposal candidate",
    );
  });
});

test("detectOrphans: empty registry flags every agent-looking seat (cold-start behavior, documented)", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl"); // never written
    const terminals = [
      { handle: "term_a", tabId: "a", leafId: "a", preview: AGENT_PREVIEW },
    ];
    const result = detectOrphans({ terminals, registryPath });
    assert.equal(result.orphanCandidates.length, 1);
    assert.match(result.coldStartWarning, /콜드 스타트/);
  });
});

test("detectOrphans: never returns a close/stop action -- report-only shape", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl");
    const result = detectOrphans({
      terminals: [
        { handle: "term_a", tabId: "a", leafId: "a", preview: AGENT_PREVIEW },
      ],
      registryPath,
    });
    for (const key of Object.keys(result)) {
      assert.equal(/close|stop|kill/.test(key.toLowerCase()), false);
    }
    assert.match(formatOrphanReport(result), /닫지 않는다/);
  });
});

test("detectOrphans: seat with no paneKey resolvable is skipped, not force-classified", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl");
    const result = detectOrphans({
      terminals: [{ handle: "term_weird", preview: AGENT_PREVIEW }], // no tabId/leafId
      registryPath,
    });
    assert.equal(result.orphanCandidates.length, 0);
  });
});

test("formatOrphanReport: lists each candidate with paneKey and reason", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl");
    const result = detectOrphans({
      terminals: [
        {
          handle: "term_ghost",
          tabId: "t",
          leafId: "l",
          preview: AGENT_PREVIEW,
        },
      ],
      registryPath,
    });
    const text = formatOrphanReport(result);
    assert.match(text, /term_ghost/);
    assert.match(text, /UNREGISTERED_PANE/);
  });
});

test("runSeatOrphanDetectCli: --terminal-list-file + --registry-path work fully offline (CI-safe)", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl");
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({ paneKey: "t:l", role: "CODER" }),
    );
    const listFile = join(dir, "terminals.json");
    writeFileSync(
      listFile,
      JSON.stringify({
        result: {
          terminals: [
            {
              handle: "term_ok",
              tabId: "t",
              leafId: "l",
              preview: AGENT_PREVIEW,
            },
            {
              handle: "term_ghost",
              tabId: "g",
              leafId: "g",
              preview: AGENT_PREVIEW,
            },
          ],
        },
      }),
      "utf8",
    );
    const outcome = runSeatOrphanDetectCli([
      "--terminal-list-file",
      listFile,
      "--registry-path",
      registryPath,
    ]);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.orphanCandidates.length, 1);
    assert.equal(outcome.result.orphanCandidates[0].handle, "term_ghost");
  });
});

test("runSeatOrphanDetectCli: missing --registry-path fails cleanly", () => {
  const outcome = runSeatOrphanDetectCli(["--terminal-list-file", "x.json"]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "MISSING_REGISTRY_PATH");
});

test("CLI end-to-end: spawned process --json reproduces the bidirectional result", () => {
  withTempDir((dir) => {
    const registryPath = join(dir, "reg.jsonl");
    appendLaunchRecord(
      registryPath,
      buildLaunchRecord({ paneKey: "t:l", role: "CODER" }),
    );
    const listFile = join(dir, "terminals.json");
    writeFileSync(
      listFile,
      JSON.stringify({
        result: {
          terminals: [
            {
              handle: "term_ok",
              tabId: "t",
              leafId: "l",
              preview: AGENT_PREVIEW,
            },
            {
              handle: "term_ghost",
              tabId: "g",
              leafId: "g",
              preview: AGENT_PREVIEW,
            },
          ],
        },
      }),
      "utf8",
    );
    const stdout = execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        "--terminal-list-file",
        listFile,
        "--registry-path",
        registryPath,
        "--json",
      ],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.orphanCandidates.length, 1);
    assert.equal(parsed.orphanCandidates[0].handle, "term_ghost");
  });
});
