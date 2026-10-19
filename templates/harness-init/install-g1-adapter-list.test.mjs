// install-g1-adapter-list.test.mjs -- HYK-209-install-list-g1-adapter-1.
//
// Reproduced fact (coder.md §1, ORCH-73's editor-reinstall-4 review P2-1/
// P2-2): relay-handshake-g1-dispatch-check.test.mjs (the §1 "result file
// top 3 lines" G1 dispatch-verification machine check) and admission-
// completion-adapter.mjs (the retirement-completion adapter relay-
// handshake.mjs spawns by path) were both entirely absent from
// ENFORCEMENT_CHECK_FILES -- an installed target repo's own CI had no
// regression net for either axis. install-copylist-closure.test.mjs's
// generic, list-wide import-closure check already covers requirement (b)
// (the two files' own static import closure) once the two names -- and
// admission-completion-adapter.mjs's own previously-missing dependency,
// ledger-pointer-shared.mjs -- are in the list (proven green by that file's
// existing "ⓐ' install copy-list closure" test; this file does not
// duplicate that proof). What that generic test does NOT cover is (a)
// whether these two SPECIFIC names remain in the list at all and (c)
// whether an actual installed target's dry-run output names them as
// install targets (the closure test never shells out to the installer).
//
// 2R (review 1R P1-1): the generic closure test being green does NOT mean
// an installed copy actually LOADS -- it only follows static `import`/
// `export ... from` specifiers. ledger-pointer-shared.test.mjs (added to
// the list by 1R, now deliberately kept OUT, see install.mjs's own
// ENFORCEMENT_CHECK_FILES comment) does a module-top-level `readFileSync`
// of "../supervisor/orch-stall-detect.mjs" -- a plain fs read, invisible to
// that regex-based closure walk -- and orch-stall-detect.mjs is not on any
// copy-list axis, so an installed copy of that one test file dies at
// import time (ENOENT) even though the closure test stayed green. (b)
// below is the machine-checked net for exactly that class of gap: it uses
// the REAL installer (`install.mjs`, not a `--dry-run`, which never
// actually loads anything) to install into a real `git init` target
// outside this worktree, and then actually RUNS (via a child `node --test`
// against the installed copy, not just an import()/load probe -- see (b)'s
// own comment for the H2 history of that change) the two newly-listed test
// files there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENFORCEMENT_CHECK_FILES } from "./install.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const INSTALLER_PATH = path.join(
  REPO_ROOT,
  "templates",
  "harness-init",
  "install.mjs",
);
const CHECK_SRC_DIR = path.join(REPO_ROOT, "scripts", "check");

const NAMES = [
  "relay-handshake-g1-dispatch-check.test.mjs",
  "admission-completion-adapter.mjs",
];

// (a) 두 이름이 목록에 있다. 보조 함수로 뽑아 둔다 -- 아래 V1/V2 음성
// 대조가 "이름과 다르게 (a) 단언을 줄인 목록에 다시 돌리지 않는다"(검토
// 1R P2-1)던 지적을 고치려면, 대조 쪽이 바로 이 함수를 다시 불러야 한다.
function assertNamePresent(list, name) {
  assert.ok(
    list.includes(name),
    `expected ENFORCEMENT_CHECK_FILES to include ${name}`,
  );
}

test("(a) ENFORCEMENT_CHECK_FILES contains both relay-handshake-g1-dispatch-check.test.mjs and admission-completion-adapter.mjs", () => {
  for (const name of NAMES) {
    assertNamePresent(ENFORCEMENT_CHECK_FILES, name);
  }
});

// 2R P2-1 수리: V1/V2 음성 대조는 "이름이 빠졌는지"를 배열 멤버십으로
// 직접 다시 확인하는 동어반복이었다(검토 1R 지적) -- (a)가 쓰는 단언
// 함수 자체를 줄인 목록에 다시 돌려 그 단언이 실제로 RED(throw)가 되는지
// 본다. neither name is imported by anything ELSE already in
// ENFORCEMENT_CHECK_FILES with ONE exception, measured live via `grep
// -rn`: nothing anywhere imports relay-handshake-g1-dispatch-check
// .test.mjs back (only a comment-text mention in hyk387-dispatch-record-
// required.test.mjs) -- V1 relies on this file's own (a) assertion as its
// ONLY regression net. admission-completion-adapter.mjs is different: its
// OWN pair test, admission-completion-adapter.test.mjs (already in this
// same list, this round), statically imports it back
// (`import { autoCompleteAdmission, completeAdmissionReservation } from
// "./admission-completion-adapter.mjs"`) -- so install-copylist-closure
// .test.mjs's generic, list-wide closure check ALSO catches V2 on its own
// (2R P3-2 correction of coder.md 1R's "어댑터는 아무것도 되돌려 import
// 하지 않는다", which was wrong about this specific name; three OTHER
// files outside this list -- hyk209-mask-readers.test.mjs, hyk461-archive-
// evidence.test.mjs, hyk468-3r-three-readers.test.mjs -- also import it
// but are invisible to that generic check since they are not list members
// themselves). V2's control below still has teeth of its own regardless:
// it is a second, independent net for the same name.
for (const removedName of NAMES) {
  test(`V1/V2 negative control: removing "${removedName}" from the (in-memory) list fails the (a) presence assertion`, () => {
    const reduced = ENFORCEMENT_CHECK_FILES.filter((n) => n !== removedName);
    assert.ok(
      reduced.length === ENFORCEMENT_CHECK_FILES.length - 1,
      `${removedName} must actually be present in the real list for this control to mean anything`,
    );
    assert.throws(
      () => assertNamePresent(reduced, removedName),
      /expected ENFORCEMENT_CHECK_FILES to include/,
      `(a)의 존재 단언을 "${removedName}"이 빠진 목록에 다시 돌렸는데도 RED가 나지 않았다 -- 대조가 이빨이 없다는 뜻`,
    );
  });
}

// 고정 칸 ⓐ (2R §2 요구 2): ledger-pointer-shared.test.mjs는 "짝 시험
// 동반" 관례의 의도적 예외다 -- install.mjs의 ENFORCEMENT_CHECK_FILES
// 자신의 주석(바로 그 이름 줄 위)이 이유를 적고 있다: 이 시험은 설치되지
// 않는 scripts/supervisor/orch-stall-detect.mjs를 모듈 최상위에서
// readFileSync하므로, 설치 대상에 이 시험 파일만 올리면 로드 단계에서
// ENOENT로 죽는다(검토 1R P1-1, 이 파일의 (b)가 아래에서 실측으로
// 재현한다). 본체 ledger-pointer-shared.mjs는 그대로 목록에 있다
// (admission-completion-adapter.mjs의 폐쇄상 필수, install-copylist-
// closure.test.mjs의 PAST_INCIDENTS가 이미 그 이빨을 증명한다).
test("(a2) ENFORCEMENT_CHECK_FILES deliberately excludes ledger-pointer-shared.test.mjs (the paired-test convention's documented exception, review 1R P1-1) while keeping ledger-pointer-shared.mjs itself", () => {
  assert.ok(
    !ENFORCEMENT_CHECK_FILES.includes("ledger-pointer-shared.test.mjs"),
    "ledger-pointer-shared.test.mjs must stay OUT of the list -- installing it reads a never-installed supervisor file at module top level and ENOENTs (see (b) below)",
  );
  assertNamePresent(ENFORCEMENT_CHECK_FILES, "ledger-pointer-shared.mjs");
});

function makeSyntheticTarget(prefix) {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  const targetRepo = path.join(base, "target-repo");
  mkdirSync(targetRepo, { recursive: true });
  execFileSync("git", ["-C", targetRepo, "init", "-q"]);
  return { base, targetRepo };
}

function runInstallDryRun(args) {
  return execFileSync("node", [INSTALLER_PATH, ...args, "--dry-run"], {
    encoding: "utf8",
  });
}

// (c) 합성 대상 dry-run 출력에 두 파일이 "설치 대상"으로 나온다.
test("(c) solo-full synthetic dry-run names both files as would-install targets", () => {
  const { base, targetRepo } = makeSyntheticTarget("hyk209-g1-adapter-dry-");
  try {
    const out = runInstallDryRun([
      "--profile",
      "solo-full",
      "--repo-path",
      targetRepo,
      "--control-room-path",
      path.join(base, "fake-control-room"),
      "--github-repo",
      "someorg/somerepo",
      "--bot-account",
      "bot-x",
      "--verify-cmd",
      "npm test",
      "--notify-dir",
      path.join(base, "notify"),
      "--approver-login",
      "approver-x",
      "--approver-id",
      "1",
      "--workspaces-root",
      path.join(base, "workspaces"),
      "--main-repo-path",
      path.join(base, "main-repo"),
    ]);
    for (const name of NAMES) {
      assert.match(
        out,
        new RegExp(
          `\\[dry-run\\] would install:.*scripts[\\\\/]check[\\\\/]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
        `expected dry-run output to name scripts/check/${name} as a would-install target`,
      );
    }
    // ledger-pointer-shared.test.mjs must NOT be a would-install target --
    // a direct dry-run-level restatement of (a2) above.
    assert.doesNotMatch(
      out,
      /\[dry-run\] would install:.*scripts[\\/]check[\\/]ledger-pointer-shared\.test\.mjs/,
      "expected dry-run output to NOT name scripts/check/ledger-pointer-shared.test.mjs as a would-install target",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ⓑ 고정 칸 -- HYK-434 H2(책임자 판정 2026-10-15 15:39 §3, H3 검토 2R
// P2-1/P3-1/P3-2 수리): 이전 판(2R)은 "평평한 날복사 + import() 프로브"
// 였다 -- 그 방식은 설치기(install.mjs) 자신의 복사 로직을 전혀 거치지
// 않고 이 시험 파일이 직접 재구현한 별도 경로였다(목록이 진짜로
// 설치되는지가 아니라, 이 시험이 스스로 흉내 낸 로직이 맞는지만
// 증명했다). 이제 **실제 설치기**(`install.mjs`, `--dry-run` 없이)로
// 워크트리 밖 빈 `git init` 대상에 실제로 설치하고, 새로 실리는 두
// `.test.mjs`(g1 시험·어댑터 짝 시험)를 그 설치된 자리에서 `node --test`
// 로 **실제 실행**해 실패 0을 본다(ⓒ가 이미 쓰는 것과 같은 CLI 인자
// 모양을 그대로 재사용한다 -- 로직을 새로 발명하지 않는다).
function installerArgsFor(base, targetRepoPath) {
  return [
    "--profile",
    "solo-full",
    "--repo-path",
    targetRepoPath,
    "--control-room-path",
    path.join(base, "fake-control-room"),
    "--github-repo",
    "someorg/somerepo",
    "--bot-account",
    "bot-x",
    "--verify-cmd",
    "npm test",
    "--notify-dir",
    path.join(base, "notify"),
    "--approver-login",
    "approver-x",
    "--approver-id",
    "1",
    "--workspaces-root",
    path.join(base, "workspaces"),
    "--main-repo-path",
    path.join(base, "main-repo"),
  ];
}

function runRealInstall(base, targetRepoPath) {
  return execFileSync(
    "node",
    [INSTALLER_PATH, ...installerArgsFor(base, targetRepoPath)],
    { encoding: "utf8" },
  );
}

// HYK-359's admission-ledger-env-isolation.mjs's own AMBIENT_LEDGER_ENV_KEYS
// -- duplicated here by name (not imported: that file lives under
// scripts/check/, this test under templates/harness-init/, and importing
// across that boundary just to strip three well-known keys is not worth
// the coupling) so a floating ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/
// DISPATCH_RECEIPT_PATH in the invoking shell cannot leak into the child
// `node --test` process this file now actually runs against the installed
// target.
function ledgerIsolatedEnv() {
  const env = { ...process.env };
  delete env.ADMISSION_LEDGER_PATH;
  delete env.ADMISSION_LOCK_PATH;
  delete env.DISPATCH_RECEIPT_PATH;
  // 측정 live(HYK-434 H2): 이 시험 파일 자신이 `node --test`로 돌 때 node
  // 자신이 NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID를 이미 환경에 심어 둔다
  // -- 이걸 그대로 물려주면 아래에서 설치된 대상에 또 거는 "자식"
  // `node --test`가 "run()이 같은 테스트 파일 안에서 재귀 호출됐다"고
  // 오인해 파일을 «돌리지도 않고» 조용히 exit 0(tests 0/pass 0)으로
  // 접는다 -- 실패 0이 아니라 "실행 자체가 0"이 되는 거짓 초록이었다.
  // 지우지 않으면 (b)/(b-negative) 둘 다 즉시 통과하는 헛시험이 된다.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

// HYK-434 H2 3R (책임자 판정 §2, 선례 scripts/check/hyk359-ambient-env-
// regression.test.mjs 머리 주석 60~90행과 그 파일의 runSweepAndAssert):
// 로컬(Node 26)과 CI가 고정하는 Node 20은 `node --test`의 기본 리포터를
// 다르게 고른다 -- Node 26은 파이프 출력이라도 무조건 spec(`ℹ tests N`)을
// 내고, Node 20은 TTY가 아닌 파이프에서 tap(`# tests N`)을 낸다(이 PC에서
// 직접 대조: 위 두 reporter 모양, `--test-reporter` 없이 파이프로 받으면
// 이 PC는 늘 `ℹ tests N`). PR #317 CI run 751/752가 그 차이로 결정론적
// 빨강이었다(1b_shown). 고침: 자식 리포터를 `tap`으로 명시해 Node 버전과
// 무관하게 출력 형식을 고정한다. `maxBuffer`도 HYK-359 4R의 같은 교훈(기본
// 1MB로는 조용히 잘려 "0건"으로 오독될 수 있다)을 그대로 적용해 넉넉히
// 올린다.
function runInstalledNodeTest(installedCheckDir, names, timeoutMs = 300000) {
  return spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", ...names],
    {
      cwd: installedCheckDir,
      encoding: "utf8",
      env: ledgerIsolatedEnv(),
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

// HYK-464 §2 ⓒ (책임자 판정 원문): "첫 일치"가 아니라 "마지막 일치 또는
// 요약 블록"으로 읽는다 -- 자식 출력 중간에 또 다른 `# tests N`/`# fail N`
// 짝(예: 설치된 시험 파일 자신이 내부적으로 또 다른 `node --test`를 띄우거나,
// 어떤 서브테스트가 그 모양의 텍스트를 우연히 찍는 경우)이 먼저 나타나면,
// 첫 일치만 보는 옛 판독은 그 가짜 요약을 집어 진짜 마지막 요약(예: 진짜
// `# tests 300`/`# fail 2`)을 놓친다(검토 3R P2-1 재현, 합성 표본 300 -> 7).
//
// 고침: `# tests N` 줄 바로 뒤(사이에 0개 이상의 다른 `# ...` 줄이 와도 됨)에
// 오는 가장 "마지막" `# fail N` 줄만 하나의 쌍으로 묶어 읽는다 -- tests와
// fail을 각자 독립적으로 "마지막 일치"를 구하면, 중간에 끼인 가짜 블록의
// fail 값과 진짜 마지막 tests 값이 서로 다른 블록에서 와 짝이 깨질 수 있다
// (예: 가짜 "tests 7/fail 2" 뒤에 진짜 "tests 300/fail 0"이 오면, fail만
// 독립적으로 "마지막 비0 매치"를 구하는 방식은 가짜 쪽의 2를 고를 수 있다).
// 이 정규식은 tests와 fail을 "같은 블록"에서 함께 캡처해 그 함정을 막는다.
// `[\s\S]*?`가 아니라 `(?:#.*\r?\n)*?`로 제한한 것은 TAP의 YAML 본문/서브테스트
// 줄(`#`로 시작하지 않음)을 건너뛰지 않게 해 "다음 요약 블록 전체를 통째로
// 삼키는" 과매칭을 막기 위함이다(P2-2 요구: `^` 앵커·문자 클래스가 느슨해지면
// 변이 시험에서 드러나야 한다).
//
// `# fail 0` 줄도 이제 그대로 매치한다(`\d+`, 옛 `[1-9]\d*`와 달리) -- tests와
// fail을 같은 블록에서 묶어 뽑으므로 "못 찾으면 0으로 채운다"는 옛 우회가 더
// 필요 없다. 요약 쌍 자체를 전혀 못 찾으면(`# tests N` 뒤에 짝이 되는 `# fail
// N`이 전혀 없음 -- 리포터가 TAP이 아니거나 출력이 잘렸다는 뜻) null을
// 돌려준다.
//
// HYK-464 2R (검토 1R P2-3, rounds/REVIEW-r1.md ⓔ 표 S6/S7/S8): 위 1R
// 정규식의 `(?:#.*\r?\n)*?`는 "#"로 시작하는 줄이면 무엇이든 건너뛴다 --
// 그래서 짝 없는 bare `# tests 7` 줄 바로 뒤에 진짜 블록이 오면
// (`# tests 300\n# suites 0\n...# fail 2`), 가짜 tests(7)와 진짜 fail(2)이
// 서로 다른 블록에서 잘못 묶인다(S6). 건너뛸 수 있는 줄을 "다른 요약
// 필드 이름"으로만 좁힌다(suites/pass/cancelled/skipped/todo/duration_ms --
// 이 함수가 안 읽는 필드들) -- `# Subtest: ...`도 "또 다른 # tests N"도
// 건너뛸 수 없으므로, 그 경계에서 매치 시도가 멈춘다. runner-receipt-
// writer.mjs의 parseTapSummaryCounts(프로덕션, HYK-464 2R)와 같은 규칙,
// 같은 근거 -- 공유 모듈은 두지 않는다(coder-task.md §2 ⓑ, 프로덕션
// 모듈 신설 금지).
//
// 마지막 완결 블록 뒤에 짝 없는 `# tests N`이 또 있으면(S7: 새 블록이
// 시작됐다가 못 끝났다) null -- 그 앞의(무관할 수 있는) 블록을 "진짜인
// 척" 돌려주지 않는다(판정 불가, "앞 블록" 아님 -- runner-receipt-
// writer.mjs의 같은 판단과 같은 근거: hasTapCompletion류 소비자가 잘린
// 꼬리를 과거 블록으로 메우면 거짓 완결로 읽을 위험).
// HYK-209 H4-2 (P2-C, REVIEW-r2.md §2 ⓓ / §3): 위 2R 고침까지도 "완결 블록"을
// tests→fail 2필드만으로 정의했다 -- 생산 parseTapSummaryCounts
// (runner-receipt-writer.mjs)는 tests→pass→fail→skipped 4필드(pass·skipped도
// 필수, suites/cancelled/todo/duration_ms만 건너뛸 수 있음)를 요구한다. 그
// 차이 때문에, 진짜 "# tests 300" 바로 뒤에 가짜 "# fail 5"가 끼고 그 뒤에
// 진짜 나머지 필드(진짜 fail 0 포함)가 오는 모양(1R 원 서술 S8, 검토 2R
// R8-orig)에서 이 2필드 판독은 가짜 쪽을 "완결"로 오인해 300/5를 돌려줬다
// (생산은 null -- 판정 불가). pass·skipped를 skippable에서 빼 필수로 올려
// 생산과 같은 4필드 요구로 좁힌다(공통 모듈 신설 없이 이 파일 안에서만).
const TAP_SKIPPABLE_FIELD_LINE =
  "(?:# (?:suites|cancelled|todo) \\d+|# duration_ms [\\d.]+)\\r?\\n";
const TAP_SUMMARY_PAIR_RE = new RegExp(
  "^# tests (\\d+)\\r?\\n" +
    `(?:${TAP_SKIPPABLE_FIELD_LINE})*?` +
    "# pass \\d+\\r?\\n" +
    `(?:${TAP_SKIPPABLE_FIELD_LINE})*?` +
    "# fail (\\d+)\\r?\\n" +
    `(?:${TAP_SKIPPABLE_FIELD_LINE})*?` +
    "# skipped \\d+\\r?$",
  "gm",
);
function parseTapSummary(text) {
  const t = text ?? "";
  const pairs = [...t.matchAll(TAP_SUMMARY_PAIR_RE)];
  if (pairs.length > 0) {
    const last = pairs[pairs.length - 1];
    const tail = t.slice(last.index + last[0].length);
    if (/^# tests \d+/m.test(tail)) return null;
    return { tests: Number(last[1]), fail: Number(last[2]) };
  }
  // No paired "tests...fail" block found at all -- fall back to whether
  // ANY bare "# tests N" line exists, so a tests-line-but-no-nearby-fail
  // shape (malformed/truncated output) is distinguishable from "not TAP at
  // all" by callers that want that distinction (install-g1-adapter-list's
  // own (b) test checks `summary` truthiness first, then `summary.fail`).
  const testsOnly = [...t.matchAll(/^# tests (\d+)$/gm)];
  if (testsOnly.length === 0) return null;
  return { tests: Number(testsOnly[testsOnly.length - 1][1]), fail: 0 };
}
// HYK-209 H4-2 (P3-2, REVIEW-r2.md §3 P3-2): the "생산과 같은 4필드" claim
// above (line ~347) holds only at the regex level (TAP_SUMMARY_PAIR_RE
// itself requires the same 4 fields production's parseTapSummaryCounts
// does). This fallback still means the FUNCTION's returned value differs
// from production (null) on 3 of 13 REVIEW-r1.md ⓛ samples (R8orig, R12,
// R7b_noFake) -- all three fail the 4-field regex but still have a bare
// "# tests N" line, so the fallback reads them as `{ tests: N, fail: 0 }`
// instead of null. Consumer (b) below asserts `result.status === 0` before
// ever touching `summary`, so this gap is not a direct false-green path in
// this file today -- but a future caller that trusts `summary.fail === 0`
// without that prior status check would not be protected by the 4-field
// regex alone.

// HYK-434 H2 3R 요구 3: 판독 함수 자체를 Node 20 TAP 출력 모양을 문자열로
// 박은 합성 표본으로 단위 시험한다 -- (b)/(b-negative)는 실제 설치·실행을
// 거치므로 "이 PC(Node 26)가 실제로 내는 TAP"만 증명하고, "Node 20이 내는
// 모양을 이 함수가 제대로 읽는지"는 이 PC에서 Node 20을 못 돌리므로 직접
// 재현할 수 없다(책임자 판정 §2 요구 3 원문: "Node 20 실행은 이 PC에서 못
// 한다면 «못 쟀다»"). 대신 Node 20 TAP reporter의 공개된 요약 줄 모양을
// 문자열로 고정해 넣어 판독만 단위로 본다.
//
// 표본 출처 〔전사〕: 요약 줄 모양(`# tests N` / `# pass N` / `# fail N` /
// `# cancelled N` / `# skipped N` / `# todo N` / `# duration_ms N`)은 이
// PC의 Node 26에서 `--test-reporter=tap`으로 작은 시험을 돌려 직접 본
// 원문(위 함수 도입 전 측정, 이 코멘트 작성 시점 재확인: `node --test
// --test-reporter=tap`을 임시 파일 하나에 돌려 그대로 복사)과 같은 줄
// 모양이다. 앞의 `TAP version 13`/`# Subtest:`/`ok`/`not ok`/YAML 블록도
// 실제 TAP 출력에서 그대로 가져왔다. 〔못쟀다〕: 이 PC에 Node 20이 없어
// "Node 20 자신이 정말 이 모양을 내는지"는 직접 대조하지 못했다 -- 공개된
// TAP reporter 계약과 이 PC의 Node 26 `--test-reporter=tap` 출력이 같은
// 모양이라는 점으로 대신한다(coder.md 한계 문단에 그대로 적는다).
const NODE20_TAP_PASS_SAMPLE = `TAP version 13
# Subtest: some test
ok 1 - some test
  ---
  duration_ms: 1.234
  type: 'test'
  ...
1..1
# tests 123
# suites 0
# pass 123
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 456.789
`;

const NODE20_TAP_FAIL_SAMPLE = `TAP version 13
# Subtest: a failing test
not ok 1 - a failing test
  ---
  duration_ms: 2.5
  type: 'test'
  ...
# tests 10
# suites 0
# pass 8
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 50.0
`;

const NODE_SPEC_SAMPLE = `ℹ tests 123
ℹ suites 0
ℹ pass 123
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 456.789
`;

test("parseTapSummary reads Node 20 TAP's '# tests N'/'# fail N' summary lines (pass sample, fail 0)", () => {
  assert.deepEqual(parseTapSummary(NODE20_TAP_PASS_SAMPLE), {
    tests: 123,
    fail: 0,
  });
});

test("parseTapSummary reads Node 20 TAP's '# tests N'/'# fail N' summary lines (fail sample, fail 2)", () => {
  assert.deepEqual(parseTapSummary(NODE20_TAP_FAIL_SAMPLE), {
    tests: 10,
    fail: 2,
  });
});

test("parseTapSummary returns null on the spec-reporter shape (ℹ tests N) -- 두 형식을 겸용하지 않는다, Node 버전과 무관하게 한 형식만 신뢰한다", () => {
  assert.equal(parseTapSummary(NODE_SPEC_SAMPLE), null);
});

// HYK-464 §2 ⓒ-2 (책임자 판정 원문 합성 표본): 자식이 먼저 가짜 요약
// "# tests 7"/"# fail 0"을 찍고, 그 뒤에 진짜 요약 "# tests 300"/"# fail 2"가
// 온다 -- 첫 일치만 보던 옛 판독은 7/0을 집어 틀렸다. 이 표본은 실제 node
// --test tap reporter가 찍는 완전한 요약 블록 모양(NODE20_TAP_*_SAMPLE과
// 동일한 8줄)을 두 번 반복해, 중첩 자식의 요약이 먼저 끼어든 모양을
// 재현한다.
const NODE20_TAP_NESTED_CHILD_THEN_REAL_SAMPLE = `TAP version 13
# Subtest: nested child sweep (its own node --test summary leaks into this parent's TAP stream)
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 12.3
ok 1 - nested child sweep
  ---
  duration_ms: 20
  type: 'test'
  ...
1..1
# tests 300
# suites 0
# pass 298
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4567.89
`;

test("parseTapSummary 합성 표본 (HYK-464 §2 ⓒ-2, 책임자 판정 원문): 중첩 자식의 가짜 요약 '# tests 7'/'# fail 0'보다 뒤에 오는 진짜 요약 '# tests 300'/'# fail 2'을 읽는다 -- 첫 일치가 아니라 마지막 요약 블록", () => {
  assert.deepEqual(parseTapSummary(NODE20_TAP_NESTED_CHILD_THEN_REAL_SAMPLE), {
    tests: 300,
    fail: 2,
  });
});

// 역방향 표본: 중첩 자식 쪽이 fail>0(비정상), 진짜(마지막) 쪽이 fail=0인
// 경우 -- tests/fail을 "같은 블록"에서 짝으로 뽑지 않고 각자 독립적으로
// "마지막 일치"만 구했다면, fail은 `[1-9]`류 정규식 때문에 "마지막 비0
// 매치"인 중첩 쪽의 2를 잘못 고를 위험이 있었다(옛 코드의 "매치 없으면 0"
// 우회가 바로 이 함정이었다). 짝으로 묶어 뽑으면 진짜 마지막 블록의
// tests=300/fail=0이 함께 나온다.
const NODE20_TAP_NESTED_NONZERO_THEN_REAL_ZERO_SAMPLE = `TAP version 13
# tests 5
# suites 0
# pass 3
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1.0
# tests 300
# suites 0
# pass 300
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 999.0
`;

test("parseTapSummary: 중첩 블록의 비0 fail이 진짜(마지막) 블록의 fail=0으로 새지 않는다 -- tests/fail은 같은 블록에서 짝으로 뽑는다, 독립적인 '마지막 일치'가 아니다", () => {
  assert.deepEqual(
    parseTapSummary(NODE20_TAP_NESTED_NONZERO_THEN_REAL_ZERO_SAMPLE),
    { tests: 300, fail: 0 },
  );
});

// P2-2 (단위 칸이 `^` 앵커 제거 같은 변이를 잡는가): "# tests 999"가 줄
// 맨 앞이 아니라 다른 텍스트 중간에 박혀 있으면(실제 TAP 요약 줄이 아니라
// 사람이 쓴 로그 문장 안의 우연한 문자열) `^` 앵커가 있어야 이를 진짜
// 요약으로 오인하지 않는다 -- 앵커를 지우는 변이는 이 표본을 거짓으로
// {tests:999,...}로 읽어 이 시험을 RED로 만든다.
test("parseTapSummary mutation guard (P2-2, `^` 앵커): '# tests N'이 줄의 맨 앞이 아니라 다른 텍스트 바로 뒤에 붙어 있으면(그래도 그 뒤에 진짜 개행 + '# fail N' 줄이 옴) 요약으로 오인하지 않는다 -- 앞쪽 `^` 앵커를 지우는 변이는 이 표본을 거짓으로 매치해 RED가 된다", () => {
  const midline = "xyz-prefix# tests 999\n# fail 999\n";
  assert.equal(parseTapSummary(midline), null);
});

// HYK-464 2R P2-3 (검토 1R ⓔ 표 S6/S7/S8, runner-receipt-writer.test.mjs의
// 같은 세 표본과 같은 규칙 -- coder-task.md §2 ⓑ "세 판독 공통 규칙").
test("parseTapSummary: S6 -- a bare orphan '# tests N' line directly before the real block's own '# tests M' is not paired with the real block's fail (fixed answer = the real block, 300/2)", () => {
  const s6 = [
    "1..1",
    "# tests 7",
    "# tests 300",
    "# suites 0",
    "# pass 298",
    "# fail 2",
    "# cancelled 0",
    "# skipped 1",
    "# todo 0",
    "# duration_ms 5.0",
  ].join("\n");
  assert.deepEqual(parseTapSummary(s6), { tests: 300, fail: 2 });
});

test("parseTapSummary: S7 -- a complete fake block followed by a truncated real one (cut off before '# fail') returns null (판정 불가), not the preceding fake block's values", () => {
  const s7 = [
    "# tests 7",
    "# suites 0",
    "# pass 7",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 1.0",
    "# tests 300",
    "# suites 0",
    "# pass 298",
  ].join("\n");
  assert.equal(parseTapSummary(s7), null);
});

test("parseTapSummary: S8 -- a trailing decoy line that is NOT '# tests ...' after the real complete block does not trigger the trailing-orphan null guard", () => {
  const s8 = [
    "# tests 300",
    "# suites 0",
    "# pass 298",
    "# fail 2",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 5.0",
    "# fail 999",
  ].join("\n");
  assert.deepEqual(parseTapSummary(s8), { tests: 300, fail: 2 });
});

test("parseTapSummary: CRLF line endings (Windows shape) parse identically to LF (M3 mutation guard)", () => {
  const crlf = NODE20_TAP_NESTED_CHILD_THEN_REAL_SAMPLE.replace(/\n/g, "\r\n");
  assert.deepEqual(parseTapSummary(crlf), { tests: 300, fail: 2 });
});

test("parseTapSummary: M4 mutation guard -- picks the LAST block (tests 5), not the one with the largest tests value (tests 300)", () => {
  const m4 = [
    "# tests 300",
    "# suites 0",
    "# pass 299",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 999.0",
    "# tests 5",
    "# suites 0",
    "# pass 5",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 1.0",
  ].join("\n");
  assert.deepEqual(parseTapSummary(m4), { tests: 5, fail: 0 });
});

// HYK-209 H4-2 (P2-C, REVIEW-r2.md ⓓ row "R8-orig(1R 원 서술)"): a real
// "# tests 300" immediately followed by a FAKE "# fail 5" line (no "# pass"
// between them), then the real remaining fields of that same block
// (including the real fail 0). The old 2-field pair regex treated the fake
// "# fail 5" as already a complete block and returned {tests:300, fail:5}
// (wrong -- production's parseTapSummaryCounts returns null/판정 불가 for
// this exact shape, REVIEW-r2.md §2 ⓓ). Requiring pass+skipped (4 fields,
// matching production) makes the main pair regex fail to match this shape
// at all; the bare "# tests N"-only fallback below still returns a non-null
// {tests:300, fail:0} rather than true null (REVIEW-r2.md §3 P2-C: a
// test-helper-only residual gap, not production-path -- documented here,
// not closed further by this round).
test("parseTapSummary mutation guard (P2-C, R8-orig shape): a fake '# fail N' line sitting directly between a real '# tests N' and that block's own real pass/skipped fields must not be read as the block's fail value", () => {
  const r8orig = [
    "# tests 300",
    "# fail 5",
    "# suites 0",
    "# pass 298",
    "# fail 0",
    "# cancelled 0",
    "# skipped 2",
    "# todo 0",
    "# duration_ms 999.0",
  ].join("\n");
  const result = parseTapSummary(r8orig);
  assert.notDeepEqual(
    result,
    { tests: 300, fail: 5 },
    `the fake '# fail 5' line must not be read as this block's fail value -- got ${JSON.stringify(result)}`,
  );
});

// HYK-209 H4-2 (⑨, 판정 2245 §4 결정론 단언): a fixed, non-randomized
// scratch-root call (path-joining the OS temp dir with a hardcoded name,
// outside mkdtempSync) collides across concurrent runs of this file (or
// concurrent CI jobs) that reach for the same literal -- every scratch root
// in this file must instead go through mkdtempSync (which appends a random
// suffix). This scans this file's OWN source text (not a shared production
// module) so a future edit that reintroduces a bare literal root is caught
// here, not just in the 6 other files tracked by the 다음조각후보표
// ORCH106 13행 ⓕ list. The needle is built from fragments (not written
// literally in this comment/this test's own strings) so this test does not
// trip over its own source when it scans itself.
test("HYK-209 H4-2 정적 금지 단언 (⑨): this file's own source never pairs the OS temp dir with a literal path outside mkdtempSync() -- every scratch root must be randomized", () => {
  const selfSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const joinWord = "join";
  const tmpdirCall = "tmpdir()";
  const BARE_TMPDIR_JOIN_RE = new RegExp(
    `\\b(?:path\\.)?${joinWord}\\(\\s*${tmpdirCall.replace("(", "\\(").replace(")", "\\)")}\\s*,`,
    "g",
  );
  const offenders = [];
  let m;
  while ((m = BARE_TMPDIR_JOIN_RE.exec(selfSource)) !== null) {
    const before = selfSource.slice(0, m.index).replace(/\s+$/, "");
    if (!before.endsWith("mkdtempSync(")) {
      const line = selfSource.slice(0, m.index).split("\n").length;
      offenders.push(`line ${line}: ${m[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `found a ${joinWord}(${tmpdirCall}, ...) call NOT wrapped in mkdtempSync() -- a fixed, non-randomized scratch root reintroduces the literal-root collision class this round forbids: ${offenders.join("; ")}`,
  );
});
// HYK-209 H4-2 (P3-3, REVIEW-r2.md §3 P3-3): this is a textual scan, not a
// parse, so it is an open set -- it does not catch `os.tmpdir()` (a
// different identifier than the bare `tmpdir()` this regex expects),
// `path.resolve(tmpdir(), ...)` (a different join function), or a literal
// routed through an intermediate variable (`const t = tmpdir(); join(t,
// lit)`). This file currently has zero such occurrences (both files here
// import `tmpdir` directly, not `os.tmpdir`), but that is a fact about this
// file's current source, not a guarantee the scan itself enforces.

test("(b) real installer (not --dry-run) installs into a git-init target outside this worktree, and `node --test` on the two newly-listed test files there has 0 failures", () => {
  const { base, targetRepo } = makeSyntheticTarget("hyk209-g1-adapter-real-");
  try {
    runRealInstall(base, targetRepo);
    const installedCheckDir = path.join(targetRepo, "scripts", "check");
    for (const name of [
      "relay-handshake-g1-dispatch-check.test.mjs",
      "admission-completion-adapter.test.mjs",
    ]) {
      assert.ok(
        existsSync(path.join(installedCheckDir, name)),
        `expected the real installer to have copied ${name} into the target`,
      );
    }
    const result = runInstalledNodeTest(installedCheckDir, [
      "relay-handshake-g1-dispatch-check.test.mjs",
      "admission-completion-adapter.test.mjs",
    ]);
    // HYK-434 H2 3R (책임자 판정 §2 요구 1, HYK-359 4R ①의 같은 교훈):
    // spawnSync 자체의 실패(예: maxBuffer를 넘겨 Node가 자식을 죽이면
    // result.error.code === 'ENOBUFS')는 그 자체로 요란하게 실패해야
    // 한다 -- 아래 "0건 실행" 판정으로 재해석되면 안 된다.
    assert.equal(
      result.error,
      undefined,
      `spawnSync itself failed (child may have been killed mid-run, e.g. exceeding maxBuffer) -- error: ${result.error?.message} (code: ${result.error?.code}), signal: ${result.signal}, status: ${result.status}, stdout captured so far: ${(result.stdout ?? "").length} byte(s)`,
    );
    assert.equal(
      result.status,
      0,
      `expected 0 test failures running the installed files via a real install; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const summary = parseTapSummary(result.stdout + result.stderr);
    assert.ok(
      summary,
      `could not find TAP's '# tests N' summary line in the child's output at all -- --test-reporter=tap may not have taken effect, or the output was cut off before the summary. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(
      summary.fail,
      0,
      `expected fail 0 in the node --test TAP summary; stdout:\n${result.stdout}`,
    );
    // ★헛시험 방지(HYK-434 H2 측정 live): "실패 0"은 "실행 자체가 0건"
    // 이어도 참이 된다 -- node:test가 NODE_TEST_CONTEXT를 물려받아
    // "재귀 호출"로 오인해 파일을 돌리지도 않고 tests 0/pass 0으로
    // 조용히 접는 실제 사고를 이 라운드가 겪었다(ledgerIsolatedEnv가
    // 그 축을 지운다). 적어도 100건 이상 실제로 돌았음을 값으로 본다
    // (설치된 두 파일의 실제 시험 수는 100건을 훨씬 넘는다).
    assert.ok(
      summary.tests >= 100,
      `expected at least 100 actually-run tests (not a silent 0-test false-green); stdout:\n${result.stdout}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ⓑ 음성 대조 -- 같은 경로(실제 설치기 + 실제 git 대상)로 재구성한다.
// 설치기(install.mjs) 자신의 ENFORCEMENT_CHECK_FILES는 이 조각의 범위
// 밖(product_scope: install.mjs는 주석 줄만)이라 소스를 고쳐 재설치할
// 수 없다 -- 대신 "메모리상 목록에 ledger-pointer-shared.test.mjs를
// 다시 넣은 판"을 그 목록이 실제로 하는 것과 똑같은 동작(install.mjs
// 자신의 installEnforcementScripts가 ENFORCEMENT_CHECK_FILES의 각
// 항목에 대해 하는 것과 바이트 단위로 같은 `copyFileSync(REPO_ROOT/
// scripts/check/<name>, targetRepo/scripts/check/<name>)` 한 호출)으로
// 재현한다 -- 설치 로직을 다시 구현하는 게 아니라 "그 목록에 있었다면
// 설치기가 했을 바로 그 복사 한 번"을 추가할 뿐이다. orch-stall-
// detect.mjs는 일부러 복사하지 않는다(어떤 축에도 없는 그 상태 자체가
// 결함의 조건이다, 검토 1R P1-1).
test('(b-negative) real installer + one extra copy reproducing "ledger-pointer-shared.test.mjs re-added to the list" fails to load it via `node --test` (ENOENT on orch-stall-detect.mjs)', () => {
  assert.ok(
    !ENFORCEMENT_CHECK_FILES.includes("ledger-pointer-shared.test.mjs"),
    "ledger-pointer-shared.test.mjs must actually be absent from the real list for this control to mean anything",
  );
  const { base, targetRepo } = makeSyntheticTarget(
    "hyk209-g1-ledger-revert-real-",
  );
  try {
    runRealInstall(base, targetRepo);
    const installedCheckDir = path.join(targetRepo, "scripts", "check");
    const name = "ledger-pointer-shared.test.mjs";
    assert.ok(
      !existsSync(path.join(installedCheckDir, name)),
      "expected the real (unaugmented) install to NOT have installed ledger-pointer-shared.test.mjs",
    );
    // install.mjs installEnforcementScripts의 for-loop 본문과 바이트
    // 단위로 같은 한 번의 copyFileSync -- "이 이름이 목록에 있었다면"을
    // 재현하는 것이지, 설치 로직을 다시 만드는 것이 아니다.
    copyFileSync(
      path.join(CHECK_SRC_DIR, name),
      path.join(installedCheckDir, name),
    );

    const result = runInstalledNodeTest(installedCheckDir, [name]);
    assert.notEqual(
      result.status,
      0,
      "expected re-adding ledger-pointer-shared.test.mjs to the list to make a real install fail to load it (it reads an uninstalled supervisor file at module top level)",
    );
    assert.match(
      result.stdout + result.stderr,
      /ENOENT/,
      `expected a module-top-level ENOENT reading orch-stall-detect.mjs; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(
      result.stdout + result.stderr,
      /orch-stall-detect\.mjs/,
      `expected the ENOENT to name orch-stall-detect.mjs specifically; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
