// HYK-387 3R §3 (완료조건 1/3): «설정된 상태가 실제로 발동함을 시험으로».
// 2R까지는 env(`DISPATCH_RECEIPT_PATH`, 3R 이름 정합 이전엔
// `DISPATCH_RECEIPT_LEDGER_PATH`)만 있었고, 그 env를 실제로 채우는 곳이
// 라이브에 하나도 없었다(coder-task.md §1 ORCH 실측). 3R은 두 번째
// fallback 단계 -- `<harnessDir>/dispatch-receipt-path.txt` 포인터
// 파일(관제실 패치 문서 `HYK-387-receipt-path-pointer.md`가 배달기 쪽에
// 심는다) -- 을 소비 쪽(`resolveDispatchLedgerPath`)에 추가했다. 이
// 시험은 그 소비 쪽 fallback 자체를 실 진입점(실 CLI spawn)으로 구동해
// 확인한다 -- 배달기 쪽(관제실 패치)이 실제로 쓰는지는 별개 시험
// (control-room-patch-apply-hyk387-receipt-pointer-effect.test.mjs)의
// 몫이다. 둘을 합쳐야 "배달기가 적고 → 소비 쪽이 읽는다"는 전체 경로가
// 증명된다.
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 이 워크트리 «안»의 mkdtemp
// 디렉터리에만 쓴다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkRelayHandshake } from "./relay-handshake.mjs";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "relay-handshake.mjs");
// HYK-394-test-leak-3 §2 Q1 (검토자 rejected 판정, 2026-08-30 실사고):
// 이전에는 이 워크트리 자신의 라이브 `.harness/` 아래(`hyk387-3r-scratch`)
// 였다 -- 오늘 밤 그 형태로 실제 검토 결과·영수증이 소실됐다.
// `os.tmpdir()`는 저장소 밖이라 git status에 안 잡히면서(과거 git-status
// 오염 회피 근거 유지) 라이브 `.harness/`와도 물리적으로 분리된다.
const SCRATCH_ROOT = join(tmpdir(), "hyk387-3r-scratch");

function withFixtureDir(prefix, fn) {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

function kstStamp(ms, { seconds = false } = {}) {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  const base = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(
    d.getUTCDate(),
  )} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return seconds ? `${base}:${p2(d.getUTCSeconds())} KST` : `${base} KST`;
}

function writeCoderRound(dir, { taskId = "HYK-387-3R-T" } = {}) {
  const now = Date.now();
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${kstStamp(now - 20 * 60 * 1000)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ ${kstStamp(now - 10 * 60 * 1000, {
      seconds: true,
    })}\n`,
    "utf8",
  );
}

function ledgerLine(record) {
  return JSON.stringify(record) + "\n";
}

function receipt({ role = "coder", taskId = "HYK-387-3R-T" } = {}) {
  return {
    recorded_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    runtime_task_id: "RT-3R",
    dispatch_id: "DISPATCH-3R",
    assignee_pane_key: "pane-3r",
    role,
    harness_task_label: taskId,
  };
}

function runCli(args, { env } = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env: isolatedChildEnv(env ?? {}),
  });
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// 완료조건 1/3: 포인터 파일만 있으면(env도 인자도 없이) 기본 호출이 실제로
// 발동한다 -- 실 CLI 구동.
// ---------------------------------------------------------------------------
test("(hyk387-3r-1)★ 포인터 파일(<harnessDir>/dispatch-receipt-path.txt)만 있고 env/인자는 전혀 없음 -> 기록 0건 원장을 가리키면 실 CLI가 거부한다", () => {
  withFixtureDir("pointer-absent-", (dir) => {
    writeCoderRound(dir);
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(ledgerPath, "", "utf8"); // 원장은 있으나 0건
    writeFileSync(join(dir, "dispatch-receipt-path.txt"), ledgerPath, "utf8");
    const res = runCli(["coder", dir]); // env도 인자도 없음
    assert.notEqual(res.exit, 0, "포인터 파일만으로도 이 축이 발동해야 한다");
    assert.match(res.stderr, /DISPATCH_RECORD_ABSENT/);
  });
});

test("(hyk387-3r-2)★ 포인터 파일이 가리키는 원장에 실제 매칭 항목이 있으면 통과(위양성 0)", () => {
  withFixtureDir("pointer-present-", (dir) => {
    writeCoderRound(dir);
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(ledgerPath, ledgerLine(receipt()), "utf8");
    writeFileSync(join(dir, "dispatch-receipt-path.txt"), ledgerPath, "utf8");
    const res = runCli(["coder", dir]);
    assert.equal(res.exit, 0, `정상 라운드는 통과해야 한다: ${res.stderr}`);
  });
});

test("(hyk387-3r-3) 포인터 파일 내용에 trailing whitespace/개행이 있어도(배달기 쪽 Set-Content -NoNewline이 안 지켜진 경우 대비) trim해서 읽는다", () => {
  withFixtureDir("pointer-whitespace-", (dir) => {
    writeCoderRound(dir);
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(ledgerPath, ledgerLine(receipt()), "utf8");
    writeFileSync(
      join(dir, "dispatch-receipt-path.txt"),
      `  ${ledgerPath}\r\n`,
      "utf8",
    );
    const res = runCli(["coder", dir]);
    assert.equal(
      res.exit,
      0,
      `공백/개행이 섞여도 통과해야 한다: ${res.stderr}`,
    );
  });
});

test("(hyk387-3r-4) 명시 인자 > env > 포인터 파일 우선순위: 명시 인자가 있으면 포인터 파일(가리키는 원장이 다름)은 무시된다", () => {
  withFixtureDir("pointer-precedence-arg-", (dir) => {
    writeCoderRound(dir);
    const realLedger = join(dir, "real.jsonl");
    writeFileSync(realLedger, ledgerLine(receipt()), "utf8");
    const wrongPointerTarget = join(dir, "does-not-exist.jsonl");
    writeFileSync(
      join(dir, "dispatch-receipt-path.txt"),
      wrongPointerTarget,
      "utf8",
    );
    // in-process 직접 호출로 명시 인자 우선순위를 확인한다(CLI는 인자를
    // 안 넘기므로 이 축은 in-process로만 확인 가능).
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      dispatchLedgerPath: realLedger,
    });
    assert.equal(
      result.ok,
      true,
      `명시 인자가 포인터 파일보다 우선해야 한다: ${JSON.stringify(result)}`,
    );
  });
});

test("(hyk387-3r-5) 무회귀: 포인터 파일도 env도 인자도 전부 없으면 여전히 스킵된다(하드코딩된 실물 경로로 떨어지지 않는다, §4 급소 1 증명)", () => {
  withFixtureDir("pointer-none-", (dir) => {
    writeCoderRound(dir);
    const res = runCli(["coder", dir]);
    assert.equal(
      res.exit,
      0,
      `아무것도 없으면 이 축은 스킵돼야 한다: ${res.stderr}`,
    );
  });
});

test("(hyk387-3r-6)★ 되돌림 변이: 포인터 파일 fallback(readDispatchReceiptPointerFile) 자체를 무력화하면, 포인터 파일만 있는 상태에서 기록 0건 라운드가 다시 통과해버린다(RED)", () => {
  withFixtureDir("mutation-pointer-red-", (dir) => {
    const stageDir = join(dir, "stage");
    const nestedDir = join(stageDir, "scripts", "check");
    mkdirSync(nestedDir, { recursive: true });
    const original = readFileSync(join(HERE, "relay-handshake.mjs"), "utf8");
    const marker =
      "function resolveDispatchLedgerPath(explicit, harnessDir) {\n  if (explicit !== undefined) return explicit;\n  return readDispatchReceiptPointerFile(harnessDir);\n}";
    assert.ok(
      original.includes(marker),
      "mutation anchor drifted -- resolveDispatchLedgerPath 소스와 더 이상 일치하지 않는다",
    );
    const mutated = original.replace(
      marker,
      "function resolveDispatchLedgerPath(explicit, harnessDir) {\n  if (explicit !== undefined) return explicit;\n  return undefined; // HYK-387 3R 되돌림 변이: 포인터 파일 fallback 제거\n}",
    );
    assert.notEqual(mutated, original);
    writeFileSync(join(nestedDir, "relay-handshake.mjs"), mutated, "utf8");
    for (const dep of [
      "reject-streak.mjs",
      "envelope-archive.mjs",
      "time-authority.mjs",
    ]) {
      writeFileSync(
        join(nestedDir, dep),
        readFileSync(join(HERE, dep), "utf8"),
        "utf8",
      );
    }

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir);
    const ledgerPath = join(roundDir, "dispatch-receipts.jsonl");
    writeFileSync(ledgerPath, "", "utf8");
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutatedRes = spawnSync(
      process.execPath,
      [join(nestedDir, "relay-handshake.mjs"), "coder", roundDir],
      { encoding: "utf8", env: isolatedChildEnv({}) },
    );
    assert.equal(
      mutatedRes.status,
      0,
      `되돌림 변이가 포인터 파일 fallback을 실제로 제거했다면, 포인터 파일만 있는 라운드도 «잘못» 통과해야 한다(RED). stderr: ${mutatedRes.stderr}`,
    );

    // 대조: 무력화 안 된 원본은 같은 표본을 반드시 거부한다(GREEN).
    const originalRes = runCli(["coder", roundDir]);
    assert.notEqual(originalRes.exit, 0, "원본은 반드시 거부해야 한다(대조군)");
    assert.equal(originalRes.exit === 0, false);
  });
});
