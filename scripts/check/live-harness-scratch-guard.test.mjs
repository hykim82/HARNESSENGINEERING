// HYK-394-test-leak-3 §2 Q2 -- live-harness-scratch-guard 실증.
// HYK-394-guard-self-4 §2 Q1 갱신 (검토자 rejected 판정, 2026-08-30):
// 가드 자신이 `--mode ci`(실제 CI 형태)로 자기 자신의 소스/시험 파일을
// 스캔 대상에 포함시켜, ⓐ가 쓰는 합성 위반 문자열(리터럴, 진짜 실행
// 코드 아님)을 "진짜 누수"로 오인해 exit 1을 냈다(2026-08-30 실측).
// 가드 자신(`live-harness-scratch-guard.mjs`)에 정확히 이 두 파일의
// 전체 상대경로만 제외하는 목록을 추가했다 -- 시험 ⓓ가 그 제외가
// "너무 넓지 않은지"(다른 진짜 누수까지 숨기지 않는지)를 고정한다.
//
// 다섯 갈래: ⓐ 실제 오늘 밤 사고 모양(합성)을 잡는지 ⓑ 흔한 안전 패턴
// (mkdtemp 격리 디렉터리 안의 `.harness` 서브디렉터리, 42개 실물 파일이
// 이미 쓰는 관례)을 오탐하지 않는지 ⓒ 지금 이 저장소 전체를 훑어도
// (calibration) 실제로 0건인지(이번 라운드가 고친 3건 포함) ⓓ 가드
// 자신의 두 파일에 대한 자기 제외가 다른 파일에까지 새지 않는지
// ⓔ ★과잉 제외 방지: 제외 대상 두 파일 «안에» 진짜 라이브 쓰기 패턴을
// 넣은 변이가 여전히 안 잡히는 것을 확인하고(=이 두 파일 한정 정직
// 한계), 같은 패턴을 «다른» 파일 이름으로 넣으면 여전히 잡히는 것으로
// 대조해(=탐지 로직 자체는 회귀하지 않았다) 그 한계가 "제외 목록"
// 하나에만 좁게 있다는 것을 증명한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runLiveHarnessScratchGuard,
  listAllScriptFiles,
} from "./live-harness-scratch-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));

test("ⓐ 잡는다: dirname(dirname(...))로 만든 repo-root 식별자 + join(그 식별자, '.harness', ...) -- 오늘 밤 사고의 정확한 모양(합성)", () => {
  const synthetic = `
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const SCRATCH_ROOT = join(REPO_ROOT, ".harness", "some-scratch");
`;
  const result = runLiveHarnessScratchGuard({
    files: ["synthetic-leak.test.mjs"],
    readFileText: () => synthetic,
  });
  assert.equal(result.ok, false, "합성 위반은 반드시 잡혀야 한다");
  assert.match(result.reason, /synthetic-leak\.test\.mjs/);
  assert.match(result.reason, /REPO_ROOT/);
});

test("ⓑ 오탐하지 않는다: 흔한 안전 패턴(mkdtemp 격리 디렉터리 안에 '.harness' 서브디렉터리를 만드는 것) -- REPO_ROOT는 다른 용도로만 쓰인다", () => {
  const synthetic = `
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "check", "some-cli.mjs");
const dir = mkdtempSync(join(tmpdir(), "safe-fixture-"));
mkdirSync(join(dir, ".harness"), { recursive: true });
writeFileSync(join(dir, ".harness", "review.md"), "content", "utf8");
`;
  const result = runLiveHarnessScratchGuard({
    files: ["synthetic-safe.test.mjs"],
    readFileText: () => synthetic,
  });
  assert.equal(
    result.ok,
    true,
    `안전 패턴을 오탐하면 안 된다: ${result.reason}`,
  );
});

test("ⓒ 실측(calibration): 지금 이 저장소 전체(scripts/ 아래 모든 .mjs)를 직접 훑으면 위반 0건이다(이 라운드가 고친 3건 포함, 재발 시 이 시험이 먼저 깨진다) -- 가드 자신의 두 파일도 목록에 «그대로» 포함시켜(자기 제외 없이 미리 거르지 않는다) 가드 자신의 내부 SELF_EXCLUDED_FILES가 실제로 작동하는지까지 함께 증명한다", () => {
  const allFiles = listAllScriptFiles(join(REPO_ROOT, "scripts")).map(
    (f) => `scripts/${f}`,
  );
  // ★HYK-394-guard-self-4 갱신: 여기서 가드 자신의 두 파일을 더 이상
  // 미리 걸러내지 않는다 -- runLiveHarnessScratchGuard 자신이 이제
  // SELF_EXCLUDED_FILES로 내부에서 걸러내므로, 이 시험이 계속 GREEN
  // 이라는 사실 자체가 그 내부 제외가 실제로 작동한다는 증거다(이전
  // 라운드까지는 이 시험 파일이 직접 필터링해서 가드 자신의 결함을
  // 가려 왔다 -- 그 결함이 바로 이번 라운드의 rejected 판정이었다).
  const result = runLiveHarnessScratchGuard({
    files: allFiles,
    readFileText: (_cwd, relPath) =>
      readFileSync(join(REPO_ROOT, relPath), "utf8"),
  });
  assert.equal(
    result.ok,
    true,
    `저장소 실측에서 위반이 발견됐다 -- 즉시 조사할 것: ${result.reason}`,
  );
});

test("ⓓ 자기 제외가 새지 않는다: 가드 자신의 두 파일 «이름과 비슷하지만 다른» 파일에 진짜 위반이 있으면 여전히 잡힌다", () => {
  const synthetic = `
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const SCRATCH_ROOT = join(REPO_ROOT, ".harness", "not-actually-excluded");
`;
  const result = runLiveHarnessScratchGuard({
    files: ["scripts/check/live-harness-scratch-guard-helper.mjs"],
    readFileText: () => synthetic,
  });
  assert.equal(
    result.ok,
    false,
    "이름이 비슷하다는 이유만으로 통과시키면 안 된다 -- 정확한 전체 경로만 제외 대상이다",
  );
});

test("ⓔ ★과잉 제외 방지(Q1 필수): 제외 대상 두 파일 «안에» 진짜 라이브 쓰기 패턴을 넣으면 -- 정직하게 «안 잡힌다»(이 두 파일 한정 정직 한계, 근거는 이 시험의 헤더/live-harness-scratch-guard.mjs 자신의 SELF_EXCLUDED_FILES 주석 참조), 같은 패턴을 다른 파일 이름으로 넣으면 여전히 잡힌다(=탐지 로직 자체는 멀쩡하다, 한계가 «제외 목록» 하나에만 좁게 있다는 증거)", () => {
  const injectedViolation = `
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const SNEAKY_SCRATCH = join(REPO_ROOT, ".harness", "sneaky-scratch-inside-the-guard-itself");
`;

  // (1) 제외 대상 파일 이름 그대로 -- 정직하게 안 잡힌다(이 시험이
  // 그 사실을 "몰랐다"가 아니라 "확인하고 받아들였다"로 고정한다).
  const excludedResult = runLiveHarnessScratchGuard({
    files: ["scripts/check/live-harness-scratch-guard.mjs"],
    readFileText: () => injectedViolation,
  });
  assert.equal(
    excludedResult.ok,
    true,
    "정직 한계 확인: 제외 대상 파일 안의 위반은 이 가드 자신으로는 안 잡힌다(설계상 트레이드오프, 다른 파일명으로는 잡힘을 아래에서 대조한다)",
  );

  // (2) 같은 위반 텍스트를 다른(제외되지 않은) 파일 이름으로 -- 반드시
  // 잡혀야 한다. 이게 실패하면 탐지 로직 자체가 죽은 것이지 "제외
  // 목록이 넓어서"가 아니므로 반드시 구분해서 시험한다.
  const nonExcludedResult = runLiveHarnessScratchGuard({
    files: ["scripts/check/some-other-file.mjs"],
    readFileText: () => injectedViolation,
  });
  assert.equal(
    nonExcludedResult.ok,
    false,
    "탐지 로직 자체 회귀 확인: 같은 패턴이 제외 대상이 아닌 파일에 있으면 반드시 잡혀야 한다",
  );
});
