# HYK-464-teardown-shadow-1 — 아카이브 전제 축 4개 + 그림자 설계안 (PR 1)

이 문서는 ORCH-129 상신(`D:\문서관리\통역\받는함\2026-11-02-2122-★상신-ORCH129-후보3 2단계 조사-판정코어 미소비봉투 못봄 병합축 없음-추천 가 그림자 먼저.md`)의 판정 ①을 구현한 PR 1(그림자)의 설계 기록이다. 판정②③(보존 사유 파일 이름 · 무장 기준 n값)도 여기 함께 못박는다.

## 0. 범위

PR 1은 **판정만** 한다 — 파괴(`orca worktree rm`/`terminal close`)는 이 라운드 어디에도 없다 (`armed`는 항상 `false`로 고정, 실행 argv 0건). 변경 파일은 정확히 셋이다:

- `scripts/relay/teardown-core.mjs` — 아카이브 전제 축 4개 + `judgeArchiveEligibility`.
- `scripts/relay/adapters/teardown-inventory-adapter.mjs` — 그 중 ⓐⓒⓓ의 관측(읽기 전용).
- `scripts/supervisor/watch-run.mjs` — 축C(자원 잔재)가 켜진 회차에 워크트리마다 이 판정을 그림자로 구동 + watch.log 세그먼트 + 받는함 1줄(ELIGIBLE≥1일 때만, 집합이 안 바뀌면 재통지 0).

`scripts/relay/adapters/orca-adapter.mjs`는 무접촉이다 — 무장(실제 실행) 결선은 PR 2의 몫이다.

## 1. 왜 `judgeTeardown`/`classifyEligibility`에 섞지 않았는가

기존 `classifyEligibility`(seat-teardown 판정, HYK-171)는 `checkDispatchCorrelationProven`에서 `policy.dispatchCorrelationProven === true`가 아니면 **항상** 차단한다. 그 가드의 주석은 명시적으로 다짐한다:

> 4b-2가 권위 있는 배정↔좌석 상관 수단을 만들기 전까지 이 전제조건을 절대 완화하지 않는다 — 이 사이클의 프로덕션 호출자는 아무도 이 값을 true로 주지 않는다.

아카이브 판정(이 라운드)은 "좌석이 지금 이 배정과 상관됐는가"를 전혀 묻지 않는다 — 묻는 것은 ⓐ병합 완료 ⓑ미소비 라운드 0 ⓒ보존 사유 파일 없음 ⓓ아카이브 목록뿐이다. 그 네 축을 기존 체인 안에 끼워 넣으려면 둘 중 하나가 필요했다:

1. 그림자 호출자가 `dispatchCorrelationProven: true`를 준다 — 위 다짐을 깨는 "완화".
2. 그 가드 자체에 새 우회 조건을 추가한다 — `worker-dispatch-rule.md` deviation_rule이 금지하는 "기존 ELIGIBILITY 판정 순서·사유 변경".

둘 다 이 라운드의 범위 밖(§2 비타협)이라, **완전히 독립된 함수** `judgeArchiveEligibility`로 둔다. 효과: `judgeTeardown`/`classifyEligibility`는 이 라운드로 단 한 글자도 바뀌지 않는다(기존 58건 시험이 변경 전후로 byte-identical하게 통과 — coder.md §시험 참조). 네 축은 "근거가 주어지지 않으면 판정 불가"라는 **같은 성질**이라 `ELIGIBILITY`/`REASON` 이름공간은 공유하되, 평가 경로는 완전히 나눈다.

## 2. ⓑ(미소비 라운드 0)을 재구현하지 않는 법

`watch-run.mjs`는 `orch-stall-detect.mjs`를 **자식 프로세스로만** 부르고 절대 import하지 않는다(이 저장소가 이미 세운 경계 — 같은 파일 §재사용 주석, `orch-stall-detect.test.mjs`의 "no PRODUCTION code imports orch-stall-detect.mjs" 경계 시험이 강제한다). 그래서 HYK-185의 `judgeUnconsumedAcrossWorktrees`를 직접 호출할 수 없다.

대신 이 러너가 이미 child-process stdout에서 뽑아 둔 `detectorResult.unconsumedWorstWorktrees`(HYK-328/HYK-185, `worstWorktreePaths` 필드)를 그대로 재사용한다: 어떤 워크트리가 그 배열에 없으면 "미소비 라운드 0"으로, 있으면 "미소비 라운드 있음"으로 본다. 이것은 HYK-185 판정의 **"발화 등급"** 정의를 그대로 물려받는 것이라 새 재구현이 아니다.

**은퇴 기록 = 소비됨**: `.harness/retirements/<role>-retire-r<N>.json`이 하나라도 있으면 그 워크트리의 미소비를 "소비됨"으로 센다. ★이 검사는 **파일 존재로만** 한다(JSON 내용을 열어 라벨을 대조하지 않는다) — HYK-412(은퇴 기록 판정 설계)의 코드를 이 라운드가 import하거나 재구현하지 않기 위한 의도적 단순화다(§2 범위 밖 "412 코드 무접촉"). 412가 아직 병합되지 않은 브랜치와 병렬로 이 라운드를 착수할 수 있는 것도 이 단순화 덕분이다(교집합 = 파일 하나 존재 여부뿐).

## 3. 보존 사유 파일 이름 (판정②)

**`.harness/keep-reason.md`** — HYK-464 09-16 추기 문면 그대로 확정. 첫 줄 = 사유 1문장, 둘째 줄 = 쓴 날짜, 그 외 자유. 파일이 있으면(관측 가능할 때) 무조건 거부(`TEARDOWN_KEEP_REASON_PRESENT`), 첫 줄을 evidence에 싣는다.

## 4. 무장 기준 (판정③)

**n=5** — 그림자 판정이 ORCH의 손 B-15(수동 아카이브) 실제 대상과 **5회 연속 전부 일치**해야 PR 2(무장)를 책임자에게 재확정 받는다. "일치"의 정의는 비대칭이다(안전 쪽으로):

- 그림자 ELIGIBLE 집합 **⊆** ORCH가 실제로 B-15 한 집합(그림자가 놓치는 것은 허용 — ORCH가 손으로 더 챙긴 것은 과소판정일 뿐 위험하지 않다).
- 거짓 ELIGIBLE **0건** — 그림자가 ELIGIBLE이라고 했는데 ORCH가 실제로는 건드리지 않은(또는 건드리면 안 됐던) 워크트리가 하나라도 있으면 그 자리에서 **카운트 리셋 + 상신**(5회를 다시 센다, 조용히 넘어가지 않는다).

이 기준의 집계(그림자 로그 vs ORCH 실제 B-15 대상의 대조) 자체는 **이 라운드의 범위 밖**이다 — ORCH가 아침 브리핑/B-15 수행 기록을 보며 손으로 센다(watch.log의 `teardown_shadow_*` 세그먼트 + 받는함 통지가 그 셈을 위한 재료다).

## 5. 정직 한계

- 이 라운드는 파괴 0 — 무장은 PR 2(5회 일치 · 책임자 재확정)로 미룬다.
- `ls-remote`는 네트워크 의존이다 — 실패하면(또는 주입 함수가 없으면) 그 회차는 판정 불가(`MERGE_STATUS_UNKNOWN`, ELIGIBLE 아님)로 fail-closed한다.
- 미소비 판정은 HYK-185(정확히는 그 판정이 `detectorResult.unconsumedWorstWorktrees`로 표면화하는 범위)까지만 본다 — 그 판정이 못 보는 것은 이 축도 못 본다.
- "일치"의 정의는 §4 그대로이고, 그 셈은 ORCH 몫이다(이 라운드는 재료만 만든다).
- 은퇴 기록 검사는 파일 존재만 본다 — 그 파일이 정말 "이 라운드"를 가리키는지는 대조하지 않는다(의도적 단순화, §2). 그림자(파괴 0) 단계라 과대판정의 대가가 "틀린 아카이브 후보가 로그에 한 줄 더 뜨는 것"뿐이라 감수한다 — 무장(PR 2) 전에 이 단순화를 재검토해야 한다.
