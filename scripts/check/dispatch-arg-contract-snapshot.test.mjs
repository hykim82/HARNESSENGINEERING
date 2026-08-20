// HYK-319-argcheck-3 (coder-task.md §2-2, 책임자 판정 2026-08-20 11:31
// "가. 재설계 지시") -- 회귀 방지 시험 2종 중 두 번째: **실물 스냅샷
// 계약 시험**.
//
// ★뿌리(같은 검토 2R P1): 기존 "(§2-5 실물 1회)" 시험
// (dispatch-arg-contract-core.test.mjs)은 라이브 관제실 경로
// (`D:\문서관리\하네스-관제실\dispatch-worker.ps1`)를 직접 읽고,
// 그 파일이 없으면(CI) 조용히 건너뛴다 -- CI에서는 아예 안 돈다. 이
// 시험은 그 실물 경로에 의존하지 않는다: 오늘(2026-08-20) 그 파일의
// 내용을 이 저장소 «안» 픽스처로 그대로 떠 두고, 그 고정 사본에 대해
// 검사기를 돌린 «기대 판정»(MISSING_ARGS + --admission-ledger-path)을
// 하드코딩으로 고정한다. 레지스트리에서 --admission-ledger-path 선언이
// 지워지면(검토 2R이 재현한 바로 그 변이) 이 시험은 그 사본에 대해
// ALL_OK를 관측하고 하드코딩된 기대(MISSING_ARGS)와 어긋나 RED다(§2-3
// 변이 표적 ⓑ의 절반; 나머지 절반은 대조 로직 자체를 "항상 통과"로
// 바꾸는 변이, 아래 두 번째 시험).
//
// ★스냅처 출처(픽스처 옆 문서 -- 이 헤더가 그 문서다):
//   원본: D:\문서관리\하네스-관제실\dispatch-worker.ps1
//   뜬 시각: 2026-08-20 11:40 KST 무렵(이 라운드 CODER 좌석 실행)
//   원본 SHA-256: 8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58
//   (HYK-323 문서·HYK-319 1R/2R 결과 파일이 기록한 값과 동일 -- 그
//   시점부터 지금까지 관제실 파일이 바뀌지 않았다는 반복 확인)
//   행수: 573줄
//   뜬 방법: `cp` 그대로 복사(변환 없음) -- 아래 시험이 픽스처 SHA-256을
//   재확인해 복사 과정에서 바이트가 상하지 않았음을 매 실행마다
//   스스로 증명한다.
//
// ★★책임자 조건② (갱신 절차, 반드시 그대로 유지) — **관제실 배달기가
// 이 인자(`--admission-ledger-path`)를 넘기도록 정당하게 고쳐지면 이
// 스냅샷과 기대 판정을 함께 갱신한다 -- 갱신하지 않으면 이 시험이 거짓
// 실패를 낸다.** 절차: ⑴ 새 관제실 파일을 다시
// `scripts/check/fixtures/dispatch-worker-snapshot-<날짜>.ps1.txt`로 뜬다
// ⑵ 이 파일 위 "스냅샷 출처" 주석의 SHA-256·시각·행수를 갱신한다 ⑶
// `EXPECTED_SNAPSHOT_*` 상수를 새 실물 판정에 맞게 고친다(예: 인자가
// 채워지면 dispatch-gate-decision도 PASS로) ⑷ 이 변경은 코드 변경이므로
// 검토 라운드를 거친다(HYK-306 방식과 동일 원칙) ⑸ 새 유지 의무를
// 조용히 만들지 않는다 -- 이 시험이 CI에서 매번 도는 한, 스냅샷을 안
// 갱신하면 다음 커밋의 CI가 반드시 그 사실을 드러낸다(빨간불).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runContractCheck, REASON } from "./dispatch-arg-contract-core.mjs";

const SNAPSHOT_PATH = fileURLToPath(
  new URL(
    "./fixtures/dispatch-worker-snapshot-2026-08-20.ps1.txt",
    import.meta.url,
  ),
);
const EXPECTED_SNAPSHOT_SHA256 =
  "8b1d717688d14f93ad31df87a1a441951a01830a946c2f354940c733a6722b58";

// 기대 판정 -- 하드코딩(레지스트리에서 파생하지 않음). 오늘의 실물이
// --admission-ledger-path를 넘기지 않는다는 사실 자체를 못박는다.
const EXPECTED_SNAPSHOT_VERDICTS = Object.freeze({
  "dispatch-gate-decision": {
    reasonCode: REASON.MISSING_ARGS,
    missingIncludes: "--admission-ledger-path",
  },
  "admission-cli-admit": { reasonCode: REASON.PASS },
  "dispatch-receipt-cli": { reasonCode: REASON.PASS },
  "dispatch-worker-seat-proof-gate": { reasonCode: REASON.PASS },
  "dispatch-start-confirm-cli": { reasonCode: REASON.PASS },
});

test("스냅샷 픽스처 자체가 뜬 시점의 원본과 여전히 바이트 동일하다(복사 상함 없음 자체 확인)", () => {
  const text = readFileSync(SNAPSHOT_PATH);
  const actualSha256 = createHash("sha256").update(text).digest("hex");
  assert.equal(
    actualSha256,
    EXPECTED_SNAPSHOT_SHA256,
    "픽스처 SHA-256이 헤더에 기록한 값과 다르다 -- 픽스처가 손상됐거나, 관제실이 바뀐 뒤 픽스처를 갱신하지 않고 헤더 SHA-256만 옛 값 그대로 뒀을 수 있다(책임자 조건② 절차를 따르지 않은 경우)",
  );
});

test("스냅샷 계약: 오늘의 실물 배달기 사본을 대조하면 dispatch-gate-decision이 MISSING_ARGS(--admission-ledger-path)이고 나머지 4개는 PASS다", () => {
  const scriptText = readFileSync(SNAPSHOT_PATH, "utf8");
  const result = runContractCheck(scriptText);
  for (const finding of result.findings) {
    const expected = EXPECTED_SNAPSHOT_VERDICTS[finding.id];
    assert.ok(expected, `스냅샷 기대 판정에 '${finding.id}' 항목이 없다`);
    assert.equal(
      finding.reasonCode,
      expected.reasonCode,
      `${finding.id}: 기대=${expected.reasonCode} 실제=${finding.reasonCode} (${finding.detail}) -- ` +
        `레지스트리에서 필수 선언이 지워졌거나(§2-3 변이 ⓑ 전반부) 대조 로직이 손상됐을 수 있다`,
    );
    if (expected.missingIncludes) {
      assert.ok(
        finding.missing.includes(expected.missingIncludes),
        `${finding.id}: missing 목록에 '${expected.missingIncludes}'가 없다 -- missing=[${finding.missing.join(",")}]`,
      );
    }
  }
  assert.equal(
    result.ok,
    false,
    "이 스냅샷은 오늘의 실물 결함(HYK-315)을 그대로 담고 있으므로 전체 판정은 REJECT여야 한다",
  );
});
