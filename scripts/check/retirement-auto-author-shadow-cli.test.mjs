// HYK-419-wire-1 -- retirement-auto-author-shadow-cli.mjs 단위/CLI 시험.
// buildShadowLine을 직접 호출하는 단위 시험과, 실제 `node ...cli.mjs`
// 서브프로세스를 spawnSync로 돌리는 CLI 시험 둘 다 포함한다(relay-
// handshake.mjs가 실제로 스폰하는 것과 같은 모양).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildShadowLine } from "./retirement-auto-author-shadow-cli.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(CHECK_DIR, "retirement-auto-author-shadow-cli.mjs");

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// buildShadowLine 단위 시험 -- 형식 고정(되돌림 변이 ⓓ의 실제 대상).
// ---------------------------------------------------------------------------

test("buildShadowLine: harnessDir가 없으면(존재하지 않는 role/taskId) ASSEMBLE_FAILED, 형식 고정", () => {
  const line = buildShadowLine({
    role: "coder",
    taskId: "HYK-419-CLI-1",
    harnessDir: "C:/definitely/not/a/real/path",
    doneAt: "2026-08-01 07:10:05 KST",
  });
  assert.match(
    line,
    /^retire-author-shadow: ASSEMBLE_FAILED reason=MISSING_ARGS label=HYK-419-CLI-1 \(shadow -- 아무것도 차단하지 않음\)$/,
  );
});

test("buildShadowLine: 항상 정확히 한 줄이고, 접두어/접미어가 고정이다(인자가 비어도 예외 없이)", () => {
  const line = buildShadowLine({});
  assert.match(line, /^retire-author-shadow: /);
  assert.match(line, /\(shadow -- 아무것도 차단하지 않음\)$/);
  assert.equal(line.includes("\n"), false);
});

// ---------------------------------------------------------------------------
// 실제 서브프로세스 CLI 시험 -- relay-handshake.mjs가 스폰하는 것과 같은
// 모양(node <cli> <role> <taskId> <harnessDir> <doneAt>).
// ---------------------------------------------------------------------------

test("CLI: 실제 harnessDir(빈 rounds/, ledger/receipt 미설정)를 넘기면 stdout에 한 줄, exit 0", () => {
  const harnessDir = tmpDir("hyk419-shadow-cli-");
  try {
    mkdirSync(join(harnessDir, "rounds"), { recursive: true });
    const res = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "coder",
        "HYK-419-CLI-2",
        harnessDir,
        "2026-08-01 07:10:05 KST",
      ],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const lines = res.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^retire-author-shadow: /);
    assert.match(lines[0], /label=HYK-419-CLI-2/);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
});

test("CLI: 인자가 아예 없어도 exit 0, 한 줄만 찍는다(운영 오용에도 절대 nonzero로 안 죽는다)", () => {
  const res = spawnSync(process.execPath, [CLI_PATH], { encoding: "utf8" });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const lines = res.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^retire-author-shadow: /);
});

test("CLI: rounds/가 파일이라(디렉터리 아님) 조립이 실제로 실패해도 exit 0", () => {
  const harnessDir = tmpDir("hyk419-shadow-cli-");
  const ledgerDir = tmpDir("hyk419-shadow-cli-ledger-");
  try {
    const ledgerPath = join(ledgerDir, "l.json");
    const receiptPath = join(ledgerDir, "r.jsonl");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: "admission-ledger/v1",
        epoch: "2026-01-01T00:00:00.000Z",
        reservations: {},
      }),
      "utf8",
    );
    writeFileSync(receiptPath, "", "utf8");
    writeFileSync(join(harnessDir, "rounds"), "not a directory", "utf8");
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, "coder", "HYK-419-CLI-3", harnessDir, "x"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ADMISSION_LEDGER_PATH: ledgerPath,
          DISPATCH_RECEIPT_PATH: receiptPath,
        },
      },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(
      res.stdout.trim(),
      /^retire-author-shadow: ASSEMBLE_FAILED reason=ROUNDS_DIR_UNREADABLE/,
    );
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
