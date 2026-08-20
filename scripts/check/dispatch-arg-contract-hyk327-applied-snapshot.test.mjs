// HYK-327-wire-1 (coder-task.md §2-6) -- "적용 후" 합성 표적 계약 시험.
//
// ★뿌리: dispatch-arg-contract-snapshot.test.mjs가 고정한 "오늘의 실물"
// 픽스처는 HYK-315 결함(--admission-ledger-path 누락)을 그대로 담고
// 있어 REJECT가 기대값이다. 이 시험은 그 반대편 -- coder-task.md §2가
// 제안한 세 조각(HYK-315 한 줄 수리·HYK-323 래퍼 검사·HYK-319 인자
// 대조 결선)을 그 픽스처에 손으로 적용한 "적용 후" 합성본
// (scripts/check/fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt)
// 이 두 검사기를 실제로 통과하는지 미리 고정해 둔다(coder-task.md §0
// 비타협8 "열리지 않는 문을 만들지 마라" -- 이 시험이 저장소 쪽에서
// 그 확인을 담당하는 유일한 축이다).
//
// ⛔이 시험은 관제실 실물 파일을 건드리지 않는다(§0 비타협2) -- 합성본은
// 이 저장소 안 픽스처일 뿐이다. 관제실 적용은 ORCH가 6단계 전례 절차로
// 집행한다(docs/control-room-patches/HYK-327-wire-two-checkers.md).
//
// 갱신 절차: ORCH가 실제로 관제실 파일에 이 문서의 문면을 적용하면, 이
// 시험과 픽스처는 그 실물을 검증하는 목적을 다했으므로 폐기해도 된다
// (또는 실물 SHA-256으로 갱신해 계속 앵커로 쓸 수도 있다 -- 그건 다음
// 트랙 판단).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runContractCheck } from "./dispatch-arg-contract-core.mjs";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "./fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_FIXTURE_SHA256 =
  "29fb025f23dbf8ae14f9adf81305de20975996ab0312ef1a352f67413aa707e6";

test("적용 후 합성 픽스처 자체가 손상되지 않았다(바이트 동일성 자체 확인)", () => {
  const text = readFileSync(FIXTURE_PATH);
  const actualSha256 = createHash("sha256").update(text).digest("hex");
  assert.equal(
    actualSha256,
    EXPECTED_FIXTURE_SHA256,
    "픽스처 SHA-256이 헤더에 기록한 값과 다르다 -- 픽스처가 손상됐거나 갱신 후 이 상수를 안 고쳤을 수 있다",
  );
});

test("적용 후 합성 픽스처는 dispatch-arg-contract 검사기를 ALL_OK로 통과한다(HYK-315 수리 + HYK-319 결선 확인)", () => {
  const scriptText = readFileSync(FIXTURE_PATH, "utf8");
  const result = runContractCheck(scriptText);
  assert.equal(
    result.ok,
    true,
    `적용 후 합성본이 REJECT다(열리지 않는 문 -- coder-task.md §0 비타협8 위반) -- findings=${JSON.stringify(result.findings)}`,
  );
});
