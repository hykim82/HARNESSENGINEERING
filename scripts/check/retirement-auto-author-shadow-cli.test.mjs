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
import { spawnSync, execFileSync } from "node:child_process";
import { buildShadowLine } from "./retirement-auto-author-shadow-cli.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(CHECK_DIR, "retirement-auto-author-shadow-cli.mjs");

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// HYK-412 1R -- 아래 픽스처들이 재현하는 실물 모양: 링크드 워크트리
// (workerDir, 실 워커 워크트리의 대응물)와 그 워크트리가 속한 메인 저장소
// (mainRepoDir)를 진짜 `git worktree add`로 만든다. mainRepoDir/.harness/
// admission-ledger-path.json 포인터는 mainRepoDir에만 두고 workerDir/
// .harness/에는 절대 두지 않는다 -- coder-task.md §2 함정 문단이 실측한
// "워커 워크트리의 .harness/에는 그 포인터 파일이 없다"는 바로 이 모양이다.
// ⛔실물 관제실 경로는 절대 쓰지 않는다 -- 포인터가 가리키는 ledger/receipt
// 파일도 이 픽스처 안의 격리 사본이다(§0).
function initGitRepo(dir) {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.test",
    },
  });
}

function addWorktree(mainRepoDir, workerDir, branch) {
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, workerDir], {
    cwd: mainRepoDir,
  });
}

function writeLedgerFixture(ledgerPath) {
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      schema_version: "admission-ledger/v1",
      epoch: "2026-01-01T00:00:00.000Z",
      reservations: {},
    }),
    "utf8",
  );
}

function makeLinkedWorktreeFixture(prefix) {
  const mainRepoDir = tmpDir(`${prefix}-main-`);
  const workerDir = join(tmpDir(`${prefix}-holder-`), "worker");
  initGitRepo(mainRepoDir);
  addWorktree(mainRepoDir, workerDir, `${prefix}-branch`);
  const harnessDir = join(workerDir, ".harness");
  mkdirSync(join(harnessDir, "rounds"), { recursive: true });
  return { mainRepoDir, workerDir, harnessDir };
}

function cleanupLinkedWorktreeFixture({ mainRepoDir, workerDir }) {
  rmSync(dirname(workerDir), { recursive: true, force: true });
  rmSync(mainRepoDir, { recursive: true, force: true });
}

function withoutShadowEnv(fn) {
  const prior = {
    ADMISSION_LEDGER_PATH: process.env.ADMISSION_LEDGER_PATH,
    DISPATCH_RECEIPT_PATH: process.env.DISPATCH_RECEIPT_PATH,
  };
  delete process.env.ADMISSION_LEDGER_PATH;
  delete process.env.DISPATCH_RECEIPT_PATH;
  try {
    return fn();
  } finally {
    for (const key of Object.keys(prior)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
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

// ---------------------------------------------------------------------------
// HYK-412 1R -- env 없이도 판정에 도달하는지(완료 조건 1) + 경로 못 찾음과
// 진짜 부재를 구별하는지(완료 조건 2)를 직접 고정한다.
// ---------------------------------------------------------------------------

test("HYK-412: env 없이도(포인터 파일만으로) 링크드 워크트리에서 조립이 성공해 JUDGED에 도달한다", () => {
  const fixture = makeLinkedWorktreeFixture("hyk412-resolve-ok");
  const sideDir = tmpDir("hyk412-resolve-ok-side-");
  try {
    const ledgerPath = join(sideDir, "ledger.json");
    const receiptPath = join(sideDir, "receipts.jsonl");
    writeLedgerFixture(ledgerPath);
    writeFileSync(receiptPath, "", "utf8");
    mkdirSync(join(fixture.mainRepoDir, ".harness"), { recursive: true });
    writeFileSync(
      join(fixture.mainRepoDir, ".harness", "admission-ledger-path.json"),
      JSON.stringify({ ledgerPath }),
      "utf8",
    );
    writeFileSync(
      join(fixture.harnessDir, "dispatch-receipt-path.txt"),
      receiptPath,
      "utf8",
    );

    const line = withoutShadowEnv(() =>
      buildShadowLine({
        role: "coder",
        taskId: "HYK-412-RESOLVE-1",
        harnessDir: fixture.harnessDir,
        doneAt: "2026-09-03 20:00:00 KST",
      }),
    );
    assert.match(
      line,
      /^retire-author-shadow: JUDGED reason=\S+ label=HYK-412-RESOLVE-1 \(shadow -- 아무것도 차단하지 않음\)$/,
      `조립이 판정까지 도달해야 한다, 실제: ${line}`,
    );
  } finally {
    rmSync(sideDir, { recursive: true, force: true });
    cleanupLinkedWorktreeFixture(fixture);
  }
});

test("HYK-412: env도 포인터 파일도 없으면 LEDGER_PATH_UNRESOLVABLE/RECEIPT_PATH_UNRESOLVABLE(경로를 못 찾음 -- '모른다')", () => {
  const fixture = makeLinkedWorktreeFixture("hyk412-unresolvable");
  try {
    const line = withoutShadowEnv(() =>
      buildShadowLine({
        role: "coder",
        taskId: "HYK-412-UNRESOLVABLE-1",
        harnessDir: fixture.harnessDir,
        doneAt: "2026-09-03 20:00:00 KST",
      }),
    );
    assert.match(
      line,
      /^retire-author-shadow: ASSEMBLE_FAILED reason=LEDGER_PATH_UNRESOLVABLE label=HYK-412-UNRESOLVABLE-1/,
      `포인터 파일이 아예 없으면 "경로를 못 찾음"이어야 한다, 실제: ${line}`,
    );
  } finally {
    cleanupLinkedWorktreeFixture(fixture);
  }
});

test("HYK-412: 포인터 파일은 있는데 가리키는 ledger가 진짜 없으면 여전히 LEDGER_UNREADABLE(진짜 부재 -- fail-closed 유지, 완료 조건 2)", () => {
  const fixture = makeLinkedWorktreeFixture("hyk412-genuine-absent");
  try {
    mkdirSync(join(fixture.mainRepoDir, ".harness"), { recursive: true });
    writeFileSync(
      join(fixture.mainRepoDir, ".harness", "admission-ledger-path.json"),
      JSON.stringify({
        ledgerPath: join(fixture.mainRepoDir, "definitely-not-there.json"),
      }),
      "utf8",
    );

    const line = withoutShadowEnv(() =>
      buildShadowLine({
        role: "coder",
        taskId: "HYK-412-GENUINE-ABSENT-1",
        harnessDir: fixture.harnessDir,
        doneAt: "2026-09-03 20:00:00 KST",
      }),
    );
    assert.match(
      line,
      /^retire-author-shadow: ASSEMBLE_FAILED reason=LEDGER_UNREADABLE label=HYK-412-GENUINE-ABSENT-1/,
      `경로는 확보했으나 그 파일이 진짜 없으면 LEDGER_UNREADABLE(구별된 사유)이어야 한다, 실제: ${line}`,
    );
    assert.doesNotMatch(
      line,
      /LEDGER_PATH_UNRESOLVABLE/,
      "경로를 찾았다면 '경로를 못 찾음' 사유로 뭉뚱그리면 안 된다",
    );
  } finally {
    cleanupLinkedWorktreeFixture(fixture);
  }
});

test("HYK-412: env가 있으면 여전히 최우선(포인터 파일보다 env가 이긴다) -- 회귀 방지", () => {
  const fixture = makeLinkedWorktreeFixture("hyk412-env-priority");
  const sideDir = tmpDir("hyk412-env-priority-side-");
  try {
    const wrongLedgerDir = tmpDir("hyk412-env-priority-wrong-ledger-");
    mkdirSync(join(fixture.mainRepoDir, ".harness"), { recursive: true });
    writeFileSync(
      join(fixture.mainRepoDir, ".harness", "admission-ledger-path.json"),
      JSON.stringify({
        ledgerPath: join(wrongLedgerDir, "should-not-be-used.json"),
      }),
      "utf8",
    );
    const envLedgerPath = join(sideDir, "env-ledger.json");
    const envReceiptPath = join(sideDir, "env-receipts.jsonl");
    writeLedgerFixture(envLedgerPath);
    writeFileSync(envReceiptPath, "", "utf8");

    const prior = {
      ADMISSION_LEDGER_PATH: process.env.ADMISSION_LEDGER_PATH,
      DISPATCH_RECEIPT_PATH: process.env.DISPATCH_RECEIPT_PATH,
    };
    process.env.ADMISSION_LEDGER_PATH = envLedgerPath;
    process.env.DISPATCH_RECEIPT_PATH = envReceiptPath;
    let line;
    try {
      line = buildShadowLine({
        role: "coder",
        taskId: "HYK-412-ENV-PRIORITY-1",
        harnessDir: fixture.harnessDir,
        doneAt: "2026-09-03 20:00:00 KST",
      });
    } finally {
      for (const key of Object.keys(prior)) {
        if (prior[key] === undefined) delete process.env[key];
        else process.env[key] = prior[key];
      }
    }
    assert.match(
      line,
      /^retire-author-shadow: JUDGED /,
      `env가 있으면 그 값으로 조립이 성공해야 한다(잘못된 포인터 파일 값을 쓰면 실패한다), 실제: ${line}`,
    );
    rmSync(wrongLedgerDir, { recursive: true, force: true });
  } finally {
    rmSync(sideDir, { recursive: true, force: true });
    cleanupLinkedWorktreeFixture(fixture);
  }
});
