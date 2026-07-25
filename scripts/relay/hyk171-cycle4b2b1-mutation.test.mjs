import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  OWNERSHIP,
  REASON,
  DEFAULT_MIN_CORROBORATION,
  judgeSeatOwnership,
  resolveMinCorroboration,
} from "./seat-identity-core.mjs";
import {
  normalizeSeatRecord,
  recordSeatCreation,
  createEmptyRegistry,
} from "./seat-registry.mjs";
import {
  fullRecord,
  ownedObservation,
  registryWith,
} from "./hyk171-cycle4b2b1-fixtures.mjs";

// HYK-171 사이클4b-2b-1 (coder-task.md §3, 재작업1 §2, 재작업2 §3) -- 좌석
// 신원 substrate mutation 원장. 총 13건(원래 9건 + REVIEW review-1이 요구한
// #10/#11/#12 + review-2가 요구한 #13), 전부 프로덕션 진입점
// (judgeSeatOwnership/normalizeSeatRecord/recordSeatCreation)을 직접
// 구동한다(helper 조립 금지). "실제 RED 재현" 절차(프로덕션 파일을 실제로
// 변조 -> 이 스위트 재실행 -> RED 확인 -> `git diff --exit-code`로 원복
// 증명)는 결과 보고서(.harness/coder.md)에 별도 기록한다 -- 이 파일 자체는
// 각 위협 시나리오에 대한 "정답(green)" 계약만 담는다(git diff로 재현
// 가능).

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// #1 (★S8 필수) -- title/preview 변조가 판정에 영향을 주면 안 된다(green
// 유지가 정답 -- RED면 여전히 화면 의존이라는 뜻이라 불합격).
// ---------------------------------------------------------------------------
test("mutation #1 (S8): title/preview string tampering never changes the verdict -- the signature doesn't even accept them as evidence", () => {
  const registry = registryWith([fullRecord()]);
  const base = judgeSeatOwnership({ registry, observed: ownedObservation() });
  const tampered = judgeSeatOwnership({
    registry,
    observed: {
      ...ownedObservation(),
      title: "[SPOOFED] totally different agent",
      preview: "gpt-9.9 / ? for shortcuts / bypass permissions",
    },
  });
  assert.equal(base.verdict, OWNERSHIP.OWNED);
  assert.equal(tampered.verdict, base.verdict);
  assert.equal(tampered.reason, base.reason);
});

// ---------------------------------------------------------------------------
// #2 -- ptyId 대신 handle을 소유권 근거로 쓰면(회전 fixture에서) 깨져야
// 한다. 여기서는 정답 구현이 handle 회전에 흔들리지 않음을 증명한다: 생성
// 시 handle과 관측 시 handle이 다른데도(회전) ptyId만 같으면 여전히
// OWNED다.
// ---------------------------------------------------------------------------
test("mutation #2: handle rotated between seat creation and observation -- ptyId-based judgement still resolves OWNED (a handle-keyed judge would flip to NOT_OWNED here)", () => {
  const record = fullRecord({ handle: "term_created_0667a6d3" });
  const registry = registryWith([record]);
  const observedAfterRotation = ownedObservation();
  // 판정 시그니처 자체에 handle 필드가 없다 -- 회전된 handle을 실어 보내도
  // (관측 시점 값) 무시된다.
  const r = judgeSeatOwnership({
    registry,
    observed: { ...observedAfterRotation, handle: "term_rotated_73a88dbf" },
  });
  assert.equal(r.verdict, OWNERSHIP.OWNED);
  assert.equal(r.reason, REASON.SEAT_OWNED);
});

// ---------------------------------------------------------------------------
// #3 -- 대장에 없는 ptyId를 OWNED로 허용하면 안 된다.
// ---------------------------------------------------------------------------
test("mutation #3: ptyId with zero matching registry records -- SEAT_NOT_IN_REGISTRY, never OWNED", () => {
  const registry = registryWith([fullRecord()]);
  const r = judgeSeatOwnership({
    registry,
    observed: ownedObservation({ ptyId: "pty-never-registered" }),
  });
  assert.equal(r.verdict, OWNERSHIP.NOT_OWNED);
  assert.equal(r.reason, REASON.SEAT_NOT_IN_REGISTRY);
});

// ---------------------------------------------------------------------------
// #4 -- provenance 결손(worktreeId: null)을 통과시키면 안 된다.
// ---------------------------------------------------------------------------
test("mutation #4: registry record has worktreeId: null (incomplete provenance) -- SEAT_PROVENANCE_INCOMPLETE, never OWNED", () => {
  const registry = registryWith([fullRecord({ worktreeId: null })]);
  const r = judgeSeatOwnership({ registry, observed: ownedObservation() });
  assert.equal(r.verdict, OWNERSHIP.UNPROVEN);
  assert.equal(r.reason, REASON.SEAT_PROVENANCE_INCOMPLETE);
});

// ---------------------------------------------------------------------------
// #5 -- minCorroboration 검사가 제거되면 축 1개짜리 단독 일치가 OWNED가
// 되어버린다. 정답 구현은 ptyId 축 하나만 일치(worktreeId를 관측이 아예
// 밝히지 않은 경우)로는 OWNED를 내주지 않는다.
//
// 정직 기록(재작업1, P1-1 적용 후): 이 시나리오는 이제 두 안전장치(별도
// worktreeId 필수조건 + corroboration 하한)가 겹쳐서 막는다 -- 재현 시
// 하한 검사만 제거해서는 RED가 안 나고(worktreeId 필수조건이 여전히
// 막는다), 두 검사를 모두 제거해야 RED가 재현된다(재현 로그 참조, mutation
// #11이 worktreeId 필수조건만 단독 제거하는 경우를 별도로 담당한다).
// ---------------------------------------------------------------------------
test("mutation #5: only the ptyId axis corroborates (observation omits worktreeId) -- SEAT_CORROBORATION_INSUFFICIENT, never OWNED on a single axis", () => {
  const registry = registryWith([fullRecord()]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-cycle4b2b1" },
  });
  assert.equal(r.verdict, OWNERSHIP.UNPROVEN);
  assert.equal(r.reason, REASON.SEAT_CORROBORATION_INSUFFICIENT);
  assert.equal(r.corroboration, 1);
});

// ---------------------------------------------------------------------------
// #6 -- 후보 2개일 때 첫 번째를 자동 선택하면 안 된다.
// ---------------------------------------------------------------------------
test("mutation #6: two independently-observed candidates both resolve OWNED -- SEAT_AMBIGUOUS_CANDIDATES, no silent pick of candidate[0]", () => {
  const registry = registryWith([
    fullRecord(),
    fullRecord({ ptyId: "pty-cycle4b2b1-second", paneKey: "seatSecond" }),
  ]);
  const r = judgeSeatOwnership({
    registry,
    observed: [
      ownedObservation(),
      ownedObservation({
        ptyId: "pty-cycle4b2b1-second",
        paneKey: "seatSecond",
      }),
    ],
  });
  assert.equal(r.verdict, OWNERSHIP.AMBIGUOUS);
  assert.equal(r.reason, REASON.SEAT_AMBIGUOUS_CANDIDATES);
  assert.equal(r.candidateCount, 2);
});

// ---------------------------------------------------------------------------
// #7 -- 대장에 같은 ptyId 중복/충돌이 있어도 통과시키면 안 된다.
// ---------------------------------------------------------------------------
test("mutation #7: registry has two records sharing the same ptyId (registry itself corrupted) -- SEAT_REGISTRY_CONFLICT, never OWNED, corroboration 0 (P2-1: the contract field itself, not just verdict/reason)", () => {
  const registry = registryWith([
    fullRecord(),
    fullRecord({ paneKey: "seatDifferent" }),
  ]);
  const r = judgeSeatOwnership({ registry, observed: ownedObservation() });
  assert.equal(r.verdict, OWNERSHIP.AMBIGUOUS);
  assert.equal(r.reason, REASON.SEAT_REGISTRY_CONFLICT);
  assert.equal(r.corroboration, 0);
});

// ---------------------------------------------------------------------------
// #8 -- 사후 terminal list 수집분을 대장에 등록할 수 없어야 한다.
// normalizeSeatRecord/recordSeatCreation은 "생성 응답 객체 하나"만 받는
// 계약이다 -- terminal-list 스타일의 배열을 통째로 넣어도(사후 대량 등록
// 시도) 필드가 전부 null로 접혀야 한다(있는 척 채우지 않는다, 새 레코드로
// 둔갑하지 않는다).
// ---------------------------------------------------------------------------
test("mutation #8: passing a terminal-list-shaped array as a 'creation response' (post-hoc bulk registration attempt) -- every field collapses to null, nothing is fabricated from list entries", () => {
  const terminalListShapedArray = [
    {
      ptyId: "pty-scavenged-1",
      worktreeId: "wt-cycle4b2b1",
      capturedAt: "later",
    },
    {
      ptyId: "pty-scavenged-2",
      worktreeId: "wt-cycle4b2b1",
      capturedAt: "later",
    },
  ];
  const record = normalizeSeatRecord(terminalListShapedArray);
  assert.equal(record.ptyId, null);
  assert.equal(record.worktreeId, null);
  assert.equal(record.capturedAt, null);

  const { registry } = recordSeatCreation(
    createEmptyRegistry(),
    terminalListShapedArray,
  );
  assert.equal(registry.seats.length, 1);
  assert.equal(registry.seats[0].ptyId, null);
  // the scavenged ptyIds never made it into the registry as real records.
  assert.equal(
    registry.seats.some((r) => r.ptyId === "pty-scavenged-1"),
    false,
  );
});

// ---------------------------------------------------------------------------
// #9 -- 판정 코어가 vendor 문자열(orca/pwsh)을 참조하면 안 된다(S6 경계).
// 정적 grep: 신규 코어 파일에 orca/pwsh/pid, 그리고 (paneKey 식별자는
// 예외로 두고) 단독 단어 pane이 0건이어야 한다.
// ---------------------------------------------------------------------------
test("mutation #9 (S6): seat-identity-core.mjs source has zero occurrences of vendor/PID/screen-pane literals (word-boundary grep; the paneKey field identifier is not a 'pane' occurrence)", () => {
  const src = readFileSync(join(__dirname, "seat-identity-core.mjs"), "utf8");
  const forbidden = /\b(orca|pwsh|pid)\b/i;
  assert.equal(forbidden.test(src), false, "found orca/pwsh/pid literal");
  const standalonePane = /\bpane\b/i;
  assert.equal(
    standalonePane.test(src),
    false,
    "found standalone 'pane' literal (paneKey identifier is fine, bare 'pane' is not)",
  );
});

// ---------------------------------------------------------------------------
// #10 (신규, P1-1) -- policy.minCorroboration의 하한 2 강제를 제거.
//
// 정직 기록: judgeSeatOwnership을 통한 end-to-end 시나리오로는 이 mutation을
// 단독으로 RED 재현할 수 없다 -- 별도 worktreeId 필수조건(mutation #11이
// 지키는 그 조건)이 이미 항상 먼저 걸려서, 그 조건을 통과한 경로에서
// corroboration은 항상 최소 2(ptyId축+worktreeId축)이기 때문이다(둘은
// 의도적 다중 방어이지 서로 대체 관계가 아니다 -- seat-identity-core.mjs의
// resolveMinCorroboration 주석 참조). 그래서 이 mutation은
// resolveMinCorroboration의 clamp 계약을 직접 단위 시험한다 -- 그 함수의
// 하한 로직 자체를 제거하면(RED 재현 로그 참조) 아래 assertion들이 깨진다.
// ---------------------------------------------------------------------------
test("mutation #10: resolveMinCorroboration clamps below-floor/invalid values up to DEFAULT_MIN_CORROBORATION(2); only integers >= 2 are honored verbatim", () => {
  for (const badValue of [1, 0, -5, 1.5, "2", null, undefined, NaN]) {
    assert.equal(
      resolveMinCorroboration(badValue),
      DEFAULT_MIN_CORROBORATION,
      `resolveMinCorroboration(${String(badValue)}) should clamp to the default floor`,
    );
  }
  assert.equal(resolveMinCorroboration(2), 2);
  assert.equal(resolveMinCorroboration(3), 3);
  assert.equal(resolveMinCorroboration(10), 10);
});

// ---------------------------------------------------------------------------
// #11 (신규, P1-1) -- observed worktreeId 필수조건을 제거(corroboration
// 총점만으로 판정)하면, worktreeId를 밝히지 않고도 ptyId+paneKey 두 축만
// 우연히 맞아 corroboration이 minCorroboration(2)을 채워 OWNED가 나온다.
// 이 필수조건은 corroboration 계산과 독립적이어야 한다.
// ---------------------------------------------------------------------------
test("mutation #11: observed omits worktreeId entirely but ptyId+paneKey alone would satisfy corroboration>=2 -- the independent worktreeId-confirmed gate still blocks OWNED", () => {
  const registry = registryWith([fullRecord()]);
  const r = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-cycle4b2b1", paneKey: "seatMain" },
  });
  assert.equal(r.verdict, OWNERSHIP.UNPROVEN);
  assert.equal(r.reason, REASON.SEAT_CORROBORATION_INSUFFICIENT);
  assert.equal(r.corroboration, 2);
});

// ---------------------------------------------------------------------------
// #12 (신규, P1-2) -- 출처 강제(생성 응답만 통과)를 제거하면 terminal-list
// 행 형태의 단일 plain object(배열이 아님)도 그대로 등록되고 만다.
// ---------------------------------------------------------------------------
test("mutation #12: a single plain object shaped like a terminal-list row (has ptyId/worktreeId/capturedAt but NO paneKey key) passed straight to recordSeatCreation -- rejected wholesale (all-null record), never registered as a usable identity", () => {
  const terminalListRow = {
    ptyId: "pty-scavenged-single",
    worktreeId: "wt-cycle4b2b1",
    capturedAt: "later",
  };
  const record = normalizeSeatRecord(terminalListRow);
  assert.equal(record.ptyId, null);
  assert.equal(record.worktreeId, null);

  const { registry } = recordSeatCreation(
    createEmptyRegistry(),
    terminalListRow,
  );
  assert.equal(registry.seats.length, 1);
  assert.equal(registry.seats[0].ptyId, null);
  assert.equal(
    registry.seats.some((r) => r.ptyId === "pty-scavenged-single"),
    false,
  );

  // the scavenged ptyId must also fail to resolve to OWNED via the identity
  // core even if someone tried to observe it against this polluted registry.
  const verdict = judgeSeatOwnership({
    registry,
    observed: { ptyId: "pty-scavenged-single", worktreeId: "wt-cycle4b2b1" },
  });
  assert.notEqual(verdict.verdict, OWNERSHIP.OWNED);
});

// ---------------------------------------------------------------------------
// #13 (신규, review-2 P1) -- 마커 검사를 다시 "키 존재만"(hasOwnProperty)
// 으로 되돌리면, `{...terminalListRow, paneKey: undefined}`(어댑터가
// terminal-list 항목에서 `paneKey: t.paneKey`로 필드를 뽑아 조립하는 현실적
// mapping 경로의 정확한 모양 -- 값은 undefined지만 키는 살아남는다)이
// 통과해 등록되고 OWNED가 나온다. 정상 구현에서는 paneKey가 non-empty
// string이 아니므로 전 필드 null로 접혀 NOT_OWNED/SEAT_NOT_IN_REGISTRY다.
// ---------------------------------------------------------------------------
test("mutation #13 (review-2 P1): {...terminalListRow, paneKey: undefined} (the exact realistic adapter-mapping shape) -- rejected wholesale, never registered, never resolves to OWNED", () => {
  const terminalListRow = {
    ptyId: "pty-mapped-from-list",
    worktreeId: "wt-cycle4b2b1",
    capturedAt: "later",
  };
  const forged = { ...terminalListRow, paneKey: undefined };
  assert.equal(Object.prototype.hasOwnProperty.call(forged, "paneKey"), true);

  const record = normalizeSeatRecord(forged);
  assert.equal(record.ptyId, null);
  assert.equal(record.worktreeId, null);
  assert.equal(record.capturedAt, null);

  const { registry } = recordSeatCreation(createEmptyRegistry(), forged);
  assert.equal(registry.seats.length, 1);
  assert.equal(registry.seats[0].ptyId, null);
  assert.equal(
    registry.seats.some((r) => r.ptyId === "pty-mapped-from-list"),
    false,
  );

  const verdict = judgeSeatOwnership({
    registry,
    observed: {
      ptyId: "pty-mapped-from-list",
      worktreeId: "wt-cycle4b2b1",
    },
  });
  assert.notEqual(verdict.verdict, OWNERSHIP.OWNED);
  assert.equal(verdict.verdict, OWNERSHIP.NOT_OWNED);
  assert.equal(verdict.reason, REASON.SEAT_NOT_IN_REGISTRY);
});

// ---------------------------------------------------------------------------
// paired-good (양성 통제) -- 정상 경로: 대장에 있고, 결손 없고, 두 축 이상
// 일치하면 OWNED.
// ---------------------------------------------------------------------------
test("paired-good: complete registry record + matching ptyId/worktreeId/paneKey observation -- OWNED with corroboration 3", () => {
  const registry = registryWith([fullRecord()]);
  const r = judgeSeatOwnership({ registry, observed: ownedObservation() });
  assert.equal(r.verdict, OWNERSHIP.OWNED);
  assert.equal(r.reason, REASON.SEAT_OWNED);
  assert.equal(r.corroboration, 3);
});
