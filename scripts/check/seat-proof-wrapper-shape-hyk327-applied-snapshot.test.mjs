// HYK-327-wire-1 (coder-task.md §2-6) -- "적용 후" 합성 표적 계약 시험,
// seat-proof-wrapper-shape 쪽. dispatch-arg-contract-hyk327-applied-
// snapshot.test.mjs의 자매 시험이다(같은 원본 계열 픽스처, 다른 검사기).
//
// 이 시험이 확인하는 것: coder-task.md §2가 제안한 세 조각(HYK-315·
// HYK-323·HYK-319)을 적용해도 Invoke-SeatProofGate 함수 «본문 자체»는
// 건드리지 않으므로(세 조각 모두 그 함수 호출부보다 앞쪽에서만
// 삽입/이동한다), 함수 본문 지문은 그대로 유지되고
// WRAPPER_CHANGED: NO가 유지된다는 것을 미리 고정해 둔다(coder-task.md
// §0 비타협8 "열리지 않는 문을 만들지 마라").
//
// HYK-415-canonical-sync-2 (2026-09-01): 이 시험은 원래 공유 픽스처
// `dispatch-worker-snapshot-2026-08-20-hyk327-applied.ps1.txt`를 읽었으나,
// canonical.json이 post-HYK-271 지문으로 갱신되면서 그 공유 픽스처(여전히
// pre-HYK-271 본문)와 정본이 어긋나게 됐다. 그 공유 픽스처는
// control-room-patch-apply-hyk286-collect.test.mjs·
// control-room-patch-apply-hyk327-wire.test.mjs·
// dispatch-arg-contract-hyk327-applied-snapshot.test.mjs·
// dispatch-arg-contract-snapshot.test.mjs·codex-snapshot-behavior.test.mjs
// 5개 시험이 **정확한 SHA-256 자기대조**로 고정해 두고 있어(각 파일의
// SOURCE_SHA256/EXPECTED_SHA256 상수), 그 파일 자체를 고치면 이 5개가
// 전부 깨진다 -- 이 시험이 필요로 하는 것(Invoke-SeatProofGate 본문이
// 정본과 일치)과 무관한 회귀다. 그래서 공유 픽스처는 그대로 두고, 그
// 파일에서 Invoke-SeatProofGate 함수 본문만 post-HYK-271로 치환한 전용
// 사본(`...-hyk271-synced.ps1.txt`, control-room-patch-canonical-sync.mjs
// 의 PINNED_FUNCTION_REGISTRY에도 등록됨)을 새로 만들어 이 시험만 그
// 사본을 읽도록 바꿨다 -- 이 파일 밖 5개 시험은 원본 공유 픽스처를 계속
// 그대로 쓰므로 무영향이다.
//
// ⛔관제실 실물 파일 무변경, 이 저장소 픽스처만 대상(§0 비타협2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { judgeSeatProofWrapper } from "./seat-proof-wrapper-shape.mjs";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "./fixtures/dispatch-worker-snapshot-2026-08-20-hyk327-applied-hyk271-synced.ps1.txt",
    import.meta.url,
  ),
);
const CANONICAL_PATH = fileURLToPath(
  new URL("./seat-proof-wrapper-canonical.json", import.meta.url),
);

test("적용 후 합성 픽스처는 seat-proof-wrapper-shape 검사기에서 WRAPPER_CHANGED: NO다(함수 본문 무변경 확인)", async () => {
  const scriptText = readFileSync(FIXTURE_PATH, "utf8");
  const canonical = JSON.parse(readFileSync(CANONICAL_PATH, "utf8"));
  const result = await judgeSeatProofWrapper(scriptText, canonical);
  assert.equal(
    result.verdict,
    "OK",
    `적용 후 합성본에서 래퍼 함수 지문이 달라졌다(WRAPPER_CHANGED: YES, reasonCode=${result.reasonCode}) -- coder-task.md §2 제안 문면이 Invoke-SeatProofGate 함수 본문을 건드리지 않는다는 전제가 깨졌을 수 있다: ${JSON.stringify(result)}`,
  );
});
