// HYK-378-derive-single-source-1 (coder-task.md §2) -- derive-claude-project-
// dir-cli.mjs 의 §2 세 단정을 자동 시험으로 고정한다.
//
// ★§2 항3(변이 RED)은 이 파일이 아니라 결과 파일에 «수동 절차»로
// 기록한다(queue-observation-mutation-ledger.md와 같은 방식 -- 실제로
// 정본 함수 호출을 자체 계산으로 되돌려 이 스위트를 재실행하고, RED를
// 확인한 뒤 `git checkout`으로 원복 + sha256 대조까지 한다). 이 파일에
// 상시로 남기면 "정본을 안 부르는 코드"를 저장소에 영구히 심어 두는
// 꼴이라(§1 요구와 정면 충돌) 자동 시험으로는 만들지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeProjectDirName } from "./derive-claude-project-dir-cli.mjs";
import { deriveClaudeProjectDirName } from "./rate-limit-stall-adapter.mjs";

const CLI_PATH = fileURLToPath(
  new URL("./derive-claude-project-dir-cli.mjs", import.meta.url),
);

// ★코드포인트로 구성한다(coder-task.md §2 경고 -- 한글을 소스에 그대로
// 쓰면 인코딩 사고로 시험이 약화될 수 있어 회피하지 말라고 했으므로,
// 회피가 아니라 명시적으로 코드포인트를 밝혀 둔다: 모바일마크다운에디터
// = U+BAA8 U+BC14 U+C77C U+B9C8 U+D06C U+B2E4 U+C6B4 U+C5D0 U+B514
// U+D130, 10글자).
const HANGUL_10 = String.fromCodePoint(
  0xbaa8,
  0xbc14,
  0xc77c,
  0xb9c8,
  0xd06c,
  0xb2e4,
  0xc6b4,
  0xc5d0,
  0xb514,
  0xd130,
);
const FIXTURE_INPUT = `C:\\Users\\Administrator\\orca\\workspaces\\${HANGUL_10}\\hyk304-firstpaint-1`;
const FIXTURE_EXPECTED =
  "C--Users-Administrator-orca-workspaces------------hyk304-firstpaint-1";

// ★§2 항2(음성 대조) -- 옛 배달기 ps1(514행)이 실제로 썼던 계산을 시험
// 안에서 대조군으로 재현한다(저장소 소스에는 심지 않는다 -- 이건 "이미
// 죽은 결함"의 재현일 뿐, 정본과 나란히 둘 대상이 아니다).
function oldPs1DerivedName(worktreeAbsPath) {
  return String(worktreeAbsPath).replace(/[\\/:]/g, "-");
}

test("§2-1 정본 경로 단정: 실물 고정물 입력 -> 정확한 문자열 출력", () => {
  assert.equal(deriveClaudeProjectDirName(FIXTURE_INPUT), FIXTURE_EXPECTED);
  assert.equal(
    computeProjectDirName(FIXTURE_INPUT).projectDirName,
    FIXTURE_EXPECTED,
  );
});

test("§2-2 음성 대조: 옛 ps1 계산은 같은 입력에서 «다른» 값을 내고, 한글을 접지 않는다", () => {
  const oldValue = oldPs1DerivedName(FIXTURE_INPUT);
  assert.equal(
    oldValue,
    `C--Users-Administrator-orca-workspaces-${HANGUL_10}-hyk304-firstpaint-1`,
  );
  assert.ok(
    oldValue.includes(HANGUL_10),
    "옛 계산은 한글을 그대로 남겨야 한다(오늘 사고의 결함 그 자체)",
  );
  assert.notEqual(
    oldValue,
    FIXTURE_EXPECTED,
    "옛 계산과 정본 계산은 반드시 달라야 한다 -- 같으면 이 시험이 오늘의 결함을 못 잡는다는 뜻",
  );
});

test("computeProjectDirName: 빈 입력/미상 타입은 WORKTREE_PATH_MISSING", () => {
  assert.deepEqual(computeProjectDirName(""), {
    ok: false,
    reasonCode: "WORKTREE_PATH_MISSING",
  });
  assert.deepEqual(computeProjectDirName(null), {
    ok: false,
    reasonCode: "WORKTREE_PATH_MISSING",
  });
  assert.deepEqual(computeProjectDirName(undefined), {
    ok: false,
    reasonCode: "WORKTREE_PATH_MISSING",
  });
});

test("CLI 프로세스: 성공 시 stdout에 이름 한 줄(개행 1개) + 종료코드 0", () => {
  const out = execFileSync(process.execPath, [CLI_PATH, FIXTURE_INPUT], {
    encoding: "utf8",
  });
  assert.equal(out, FIXTURE_EXPECTED + "\n");
});

test("CLI 프로세스: --json은 worktree·projectDirName을 담은 한 줄 JSON을 낸다", () => {
  const out = execFileSync(
    process.execPath,
    [CLI_PATH, FIXTURE_INPUT, "--json"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    worktree: FIXTURE_INPUT,
    projectDirName: FIXTURE_EXPECTED,
  });
});

test("CLI 프로세스: 인자 없음 -> 비-0 종료코드 + stderr, stdout은 비어 있음", () => {
  let threw = null;
  let result = null;
  try {
    result = execFileSync(process.execPath, [CLI_PATH], {
      encoding: "utf8",
    });
  } catch (err) {
    threw = err;
  }
  assert.equal(result, null, "실패 시 정상 stdout을 내면 안 된다");
  assert.ok(threw, "인자 없음은 비-0 종료코드로 실패해야 한다");
  assert.notEqual(threw.status, 0);
  assert.equal(threw.stdout.toString("utf8"), "");
  assert.match(threw.stderr.toString("utf8"), /usage:/);
});

test("CLI 프로세스: --repo-root/--worktree 플래그도 동일하게 동작한다", () => {
  const viaFlag = execFileSync(
    process.execPath,
    [CLI_PATH, "--repo-root", FIXTURE_INPUT],
    { encoding: "utf8" },
  );
  assert.equal(viaFlag, FIXTURE_EXPECTED + "\n");
  const viaWorktreeFlag = execFileSync(
    process.execPath,
    [CLI_PATH, "--worktree", FIXTURE_INPUT],
    { encoding: "utf8" },
  );
  assert.equal(viaWorktreeFlag, FIXTURE_EXPECTED + "\n");
});
