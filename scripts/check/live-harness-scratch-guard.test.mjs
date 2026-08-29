// HYK-394-test-leak-3 §2 Q2 -- live-harness-scratch-guard 실증.
//
// 세 갈래: ⓐ 실제 오늘 밤 사고 모양(합성)을 잡는지 ⓑ 흔한 안전 패턴
// (mkdtemp 격리 디렉터리 안의 `.harness` 서브디렉터리, 42개 실물 파일이
// 이미 쓰는 관례)을 오탐하지 않는지 ⓒ 지금 이 저장소 전체를 훑어도
// (calibration) 실제로 0건인지(이번 라운드가 고친 3건 제외하고).
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

test("ⓒ 실측(calibration): 지금 이 저장소 전체(scripts/ 아래 모든 .mjs)를 직접 훑으면 위반 0건이다(이 라운드가 고친 3건 포함, 재발 시 이 시험이 먼저 깨진다)", () => {
  // 이 시험 파일 자신은 제외한다 -- ⓐ가 합성 위반 문자열을 리터럴로
  // 담고 있어(진짜 실행 코드가 아니라 테스트용 텍스트 블록), 저장소
  // 전체 스캔에 포함시키면 자기 자신을 "위반"으로 잡는 자기지시적
  // 오탐이 난다(그 자체가 이 가드의 한계가 아니라 이 시험 파일 고유의
  // 구성 문제).
  const SELF = "scripts/check/live-harness-scratch-guard.test.mjs";
  const allFiles = listAllScriptFiles(join(REPO_ROOT, "scripts"))
    .map((f) => `scripts/${f}`)
    .filter((f) => f !== SELF);
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
