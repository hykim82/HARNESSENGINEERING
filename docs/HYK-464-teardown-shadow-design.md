# HYK-464-teardown-shadow — 아카이브 전제 축 + 그림자 설계안 (PR 1)

이 문서는 ORCH-129 상신(`D:\문서관리\통역\받는함\2026-11-02-2122-★상신-ORCH129-후보3 2단계 조사-판정코어 미소비봉투 못봄 병합축 없음-추천 가 그림자 먼저.md`)의 판정 ①을 구현한 PR 1(그림자)의 설계 기록이다. 판정②③(보존 사유 파일 이름 · 무장 기준 n값)도 여기 함께 못박는다.

**2R 갱신(HYK-464-teardown-shadow-2, REVIEW 1R rejected 수리, 책임자 판정 1012)**: 1R은 CLI가 그림자를 켜지 않았고(P1-1), 본체 체크아웃이 거짓 ELIGIBLE로 나왔고(P1-2), 미소비/은퇴 축이 억제·가림·다른 라운드 은퇴로 과대판정했다(P1-3/P1-5). 아래 §0·§2·§5는 그 수리를 반영해 다시 썼다 — 바뀐 내용은 각 절에 "(2R)"로 표시한다.

## 0. 범위

PR 1은 **판정만** 한다 — 파괴(`orca worktree rm`/`terminal close`)는 이 라운드 어디에도 없다 (`armed`는 항상 `false`로 고정, 실행 argv 0건). **(2R)** 변경 파일은 7개다(1R의 "정확히 셋"은 틀렸다 — 실제로는 시험 3개 + 문서 1개가 늘 함께 바뀌었다):

- `scripts/relay/teardown-core.mjs` — 아카이브 전제 축(병합 완료·미소비 0·보존 사유 없음·아카이브 목록 + 2R이 더한 본체 제외·라운드 증거 0) + `judgeArchiveEligibility`.
- `scripts/relay/adapters/teardown-inventory-adapter.mjs` — 그 중 병합·보존 사유·아카이브 목록의 관측(읽기 전용).
- `scripts/supervisor/watch-run.mjs` — **(2R)** 축C(자원 잔재)가 켜진 CLI 회차면 **새 플래그 없이 기본으로** 워크트리마다 이 판정을 그림자로 구동(1R은 CLI가 이 값을 아예 싣지 않아 한 번도 돌지 않았다, P1-1) + watch.log 세그먼트(사유별 건수 요약) + 받는함(워크트리별 전체 상세, ELIGIBLE≥1일 때만, 집합이 안 바뀌면 재통지 0).
- `scripts/relay/teardown-core.test.mjs` / `scripts/relay/adapters/teardown-inventory-adapter.test.mjs` / `scripts/supervisor/teardown-shadow-wire.test.mjs` — 그 짝 시험.

`scripts/relay/adapters/orca-adapter.mjs`와 `scripts/supervisor/orch-stall-detect.mjs`는 무접촉이다 — 무장(실제 실행) 결선은 PR 2의 몫이다.

## 1. 왜 `judgeTeardown`/`classifyEligibility`에 섞지 않았는가

기존 `classifyEligibility`(seat-teardown 판정, HYK-171)는 `checkDispatchCorrelationProven`에서 `policy.dispatchCorrelationProven === true`가 아니면 **항상** 차단한다. 그 가드의 주석은 명시적으로 다짐한다:

> 4b-2가 권위 있는 배정↔좌석 상관 수단을 만들기 전까지 이 전제조건을 절대 완화하지 않는다 — 이 사이클의 프로덕션 호출자는 아무도 이 값을 true로 주지 않는다.

아카이브 판정(이 라운드)은 "좌석이 지금 이 배정과 상관됐는가"를 전혀 묻지 않는다 — 묻는 것은 ⓐ병합 완료 ⓑ미소비 라운드 0 ⓒ보존 사유 파일 없음 ⓓ아카이브 목록뿐이다. 그 네 축을 기존 체인 안에 끼워 넣으려면 둘 중 하나가 필요했다:

1. 그림자 호출자가 `dispatchCorrelationProven: true`를 준다 — 위 다짐을 깨는 "완화".
2. 그 가드 자체에 새 우회 조건을 추가한다 — `worker-dispatch-rule.md` deviation_rule이 금지하는 "기존 ELIGIBILITY 판정 순서·사유 변경".

둘 다 이 라운드의 범위 밖(§2 비타협)이라, **완전히 독립된 함수** `judgeArchiveEligibility`로 둔다. 효과: `judgeTeardown`/`classifyEligibility`는 이 라운드로 단 한 글자도 바뀌지 않는다(기존 58건 시험이 변경 전후로 byte-identical하게 통과 — coder.md §시험 참조). 네 축은 "근거가 주어지지 않으면 판정 불가"라는 **같은 성질**이라 `ELIGIBILITY`/`REASON` 이름공간은 공유하되, 평가 경로는 완전히 나눈다.

## 2. ⓑ(미소비 라운드 0)을 재구현하지 않는 법

`watch-run.mjs`는 `orch-stall-detect.mjs`를 **자식 프로세스로만** 부르고 절대 import하지 않는다(이 저장소가 이미 세운 경계 — 같은 파일 §재사용 주석, `orch-stall-detect.test.mjs`의 "no PRODUCTION code imports orch-stall-detect.mjs" 경계 시험이 강제한다). 그래서 HYK-185의 `judgeUnconsumedAcrossWorktrees`를 직접 호출할 수 없다.

**(2R, P1-3 수리)** 1R은 이 러너가 이미 뽑아 둔 `detectorResult.unconsumedWorstWorktrees`(발화 **대표값** 목록)만 보고 "그 배열에 없으면 미소비 0"으로 접었다. 그런데 이 목록은 HYK-185 판정 그 자체가 아니라 **발화 등급**(HYK-452 억제·등급 가림 뒤의 투영)이다 — 억제된 미소비(한 번 알린 다음 회차부터 사라짐)·더 높은 등급에 가려진 미소비·워크트리별 수집 실패가 전부 "0건"으로 접혀 거짓 ELIGIBLE이 났다(검토 1R 실측). 2R은 감지기 stdout의 **워크트리별 전체 항목**(`unconsumed.worktrees[]`의 status/verdict/resultFile.path, `pickUnconsumedWorktreeEntries`가 그대로 옮겨 적는다)을 본다: `UNCONSUMED_NOT_APPLICABLE`이거나 `UNCONSUMED_JUDGED`+`CONSUMED`가 아니면 "있음"이고, 그 밖의 status(`COLLECTION_FAILED` 등)는 "판정 불가"다 — HYK-185 판정 자체는 한 글자도 다시 하지 않는다(그 판정이 이미 낸 문자열만 읽는다, 재구현 아님).

**(2R, P1-5/C1 수리) 은퇴 기록 = 소비됨**: 1R은 `.harness/retirements/<role>-retire-r<N>.json`이 **파일 존재로만** 있으면 소비됨으로 셌다 — 다른 역할·다른 회차의 옛 은퇴 기록 1건이 새 회차의 미소비를 가렸다(검토 1R P1-5 실측). 2R은 그 파일을 열어 `JSON.parse`하고, **그 미소비 라운드 자신**의 role(결과 파일명 `.harness/<role>.md`에서 역산) + harnessTaskLabel(그 결과 파일의 `task_id:` 헤더 줄)과 정확히 일치하는 기록이 있을 때만 소비됨으로 센다. **(HYK-464-teardown-shadow-3 수리, 검토 2R P2-C 지적 · 판정 1012 C1 "깨짐·불일치 = 판정 불가")** 못 읽음·깨진 JSON은 그 파일이 실제 일치였는지 알 수 없으므로 **판정 불가**(`TEARDOWN_UNCONSUMED_ROUNDS_UNKNOWN`)로 접는다 — 2R까지는 이것도 "소비 아님"(`TEARDOWN_UNCONSUMED_ROUNDS_PRESENT`)과 같은 이름으로 나갔다. 정상 JSON인데 다른 역할/회차인 경우(= 정상적인 "다른 라운드 은퇴")는 그대로 **소비 아님**으로 확정한다. **(HYK-491-teardown-arm-1 문면 정정, coder-task.md §2 pre-task ⓐ)** 이전 문면("무관한 옛 기록 하나가 깨져 있어도 ... 그 결론은 유지된다 — 전부 깨졌을 때만 판정 불가다")은 실제 코드와 달랐다 — `scanRetirementNames`는 MATCHED가 하나도 없는데 BROKEN이 **하나라도** 있으면 전체를 BROKEN(판정 불가)으로 접는다. 즉 "못읽음·깨짐 + 정상(다른 라운드) 혼합"도 **판정 불가(UNKNOWN)**이고, "소비 아님(PRESENT)"으로 확정되는 것은 스캔한 파일 전부가 정상 JSON이고(BROKEN 0건) 그중 MATCHED가 없을 때뿐이다. 사유 이름은 그대로 `TEARDOWN_UNCONSUMED_ROUNDS_PRESENT`를 쓴다(통일하지 않음). ⛔이것은 HYK-412(은퇴 기록 판정 설계)의 전체 재확인(아카이브 존재·지문·기계 재확인)을 재구현하는 것이 아니다 — 그림자(판정만) 축에 맞는 더 가벼운 자기완결 대조이고, 412 코드를 이 라운드가 import하거나 호출하지 않는다(§2 범위 밖 "412 코드 무접촉" 그대로).

## 2-b. B1(2R 신설) — 본체 제외 + 라운드 증거 0 제외

검토 1R 실물 1회에서 **본체(비연결 작업 트리) 체크아웃**이 그대로 ELIGIBLE로 나왔다(HYK-185 NOT_APPLICABLE·keep-reason 없음·자기 자신의 조상이라는 사실만으로) — 본체는 애초에 `orca worktree rm`의 대상이 될 수 없으므로 거짓 ELIGIBLE이다. `git worktree list --porcelain`은 본체를 항상 인덱스 0으로 낸다(이 저장소에서 실측 — porcelain 출력에 본체를 가리키는 별도 플래그는 없다, `bare`/`locked`/`prunable`은 각각 다른 조건에서만 나온다) — `runTeardownShadowStep`이 그 인덱스를 `mainCheckout.isMain`으로 싣는다.

같은 실물에서 "막 만든 워크트리"(아직 어떤 라운드도 끝낸 적 없음)도 같은 4축을 통과할 것으로 추론됐다(합성 확인은 아님). 소비 영수증(`.harness/receipts/<role>-receipt-r<N>.json`)이 하나도 없으면 "이 워크트리에서 라운드가 끝났다"는 증거가 없으므로 ELIGIBLE(적극적 결론)을 뒷받침할 근거가 없다 — `roundEvidence.count`를 archiveManifest가 이미 수집한 `.harness` 전체 파일 목록에서 `.harness/receipts/` 하위 개수만 세어 구한다(새 fs 호출 0, 기존 관측 재사용).

두 사유(`TEARDOWN_MAIN_CHECKOUT`/`TEARDOWN_NO_ROUND_EVIDENCE`)는 다른 네 축과 같은 성질(근거가 주어지지 않으면 판정 불가 = ELIGIBLE 아님)이다.

## 2-c. 3kinds-1 — 검사 1·6 의 «통과» 분기 두 곳을 넓힌다 (HYK-464 후속)

새 검사를 끼우지 않는다. 검사 순서(`ARCHIVE_ELIGIBILITY_CHECKS`)와 REASON 코드는 그대로이고, 검사 1(병합)과 검사 6(라운드 증거)의 «통과» 분기에 OR 한 묶음씩(`MERGE_OPENERS` · `ROUND_EVIDENCE_OPENERS`)을 더했다. 새 증거 필드(`patchEquivalence` · `pmBinding`)는 `observable === true` 이고 코어가 숫자 불변식을 다시 확인했을 때만 문을 연다. 실패 사유는 기존 `NOT_MERGED_TO_MASTER` · `NO_ROUND_EVIDENCE` 그대로이고 새 필드는 거부 evidence 에만 실린다. ELIGIBLE evidence 의 `openedBy` 가 어느 문으로 열렸는지(`ANCESTOR`/`PATCH_ID` · `RECEIPTS`/`PM_BINDING`)를 적는다.

- ⓑ patch-id 동등(검사 1): HEAD 가 origin/master 의 조상이 «아님» 이 관측된 워크트리에서만 본다. merge-base 이후 병합 커밋 0 · 브랜치 비병합 커밋 1..50 · master 쪽 비병합 커밋 ≤1000 · `git log -p --binary --no-merges` 의 patch-id 줄 수 = 커밋 수(빈 커밋은 patch-id 를 내지 않는다) · 출력 커밋 집합 = 브랜치 커밋 집합 · 브랜치의 모든 patch-id 가 master 쪽에 있음(미대응 0). 코어는 `headSha`/`remoteMasterSha` 가 mergeStatus 와 같은지와 위 숫자를 다시 확인한다.
- ⓒ PM 영수증 결속(검사 6): 영수증이 0 인 워크트리에서만 본다. 관제실 루트(`dirname(--watch-dir)`)의 좌석 등록부 → 배달 원장 → `PM/relay/receipts/PM-receipt-r*.json` 을 라벨(`binding.taskId`)로 묶는다(번호로 묶지 않는다). 등록부 행이 전부 PM · paneKey 가 등록부에서 유일 · 배달이 전부 PM · «모든» 배달에 PM 영수증이 정확히 1개이고 `doneAt` 이 배달 뒤 · `pm-task.md` 가 이 워크트리의 영수증 없는 배달 전 구간이 아님. `watch/` 아래 낡은 사본은 읽지 않는다.
- N13: 판정 결과에 `headSha` 를 싣고, 무장 경로가 실행 직전 HEAD 를 다시 읽어 다르면 그 워크트리만 건너뛴다(`TEARDOWN_ARM_HEAD_MOVED` — 판정 REASON 이 아니라 무장 경로 건너뜀 사유, 다음 회차에 다시 판정).
- 한계: patch-id 동등은 «내용이 master 에 들어갔다» 의 증거이며 이후 master 에서 되돌려졌는지는 보지 않는다(기존 조상 검사와 같은 성질). 스쿼시 병합은 patch-id 가 달라 거부된다. 결속은 «등록부와 배달 원장이 모든 배달을 기록한다» 를 가정한다(원장 완전성은 증명하지 않는다). 사람 승인 은퇴 표지(ⓐ)는 이 절의 범위 밖이다.

## 3. 보존 사유 파일 이름 (판정②)

**`.harness/keep-reason.md`** — HYK-464 09-16 추기 문면 그대로 확정. 첫 줄 = 사유 1문장, 둘째 줄 = 쓴 날짜, 그 외 자유. 파일이 있으면(관측 가능할 때) 무조건 거부(`TEARDOWN_KEEP_REASON_PRESENT`), 첫 줄을 evidence에 싣는다.

## 4. 무장 기준 (판정③)

**n=5** — 그림자 판정이 ORCH의 손 B-15(수동 아카이브) 실제 대상과 **5회 연속 전부 일치**해야 PR 2(무장)를 책임자에게 재확정 받는다. "일치"의 정의는 비대칭이다(안전 쪽으로):

- 그림자 ELIGIBLE 집합 **⊆** ORCH가 실제로 B-15 한 집합(그림자가 놓치는 것은 허용 — ORCH가 손으로 더 챙긴 것은 과소판정일 뿐 위험하지 않다).
- 거짓 ELIGIBLE **0건** — 그림자가 ELIGIBLE이라고 했는데 ORCH가 실제로는 건드리지 않은(또는 건드리면 안 됐던) 워크트리가 하나라도 있으면 그 자리에서 **카운트 리셋 + 상신**(5회를 다시 센다, 조용히 넘어가지 않는다).

이 기준의 집계(그림자 로그 vs ORCH 실제 B-15 대상의 대조) 자체는 **이 라운드의 범위 밖**이다 — ORCH가 아침 브리핑/B-15 수행 기록을 보며 손으로 센다(watch.log의 `teardown_shadow_*` 세그먼트 + 받는함 통지가 그 셈을 위한 재료다).

## 5. 정직 한계

- 이 라운드는 파괴 0 — 무장은 PR 2(5회 일치 · 책임자 재확정)로 미룬다.
- `ls-remote`는 네트워크 의존이다 — 실패하면(또는 주입 함수가 없으면) 그 회차는 판정 불가(`MERGE_STATUS_UNKNOWN`, ELIGIBLE 아님)로 fail-closed한다. **(2R)** 기본 lsRemoteFn은 이제 회차당 1회만 실제로 부른다(`createMemoizedDefaultLsRemoteFn`) — 링크된 워크트리는 전부 같은 저장소(같은 remote 설정)를 공유하므로 결과는 달라지지 않는다.
- 미소비 판정은 HYK-185까지만 본다 — 그 판정이 못 보는 것은 이 축도 못 본다. **(2R)** 1R은 그중에서도 "발화 대표값"만 봤다(억제·가림·수집 실패가 전부 "0건"으로 샜다, §2 참조) — 2R은 워크트리별 전체 항목을 보지만, 여전히 HYK-185 자신의 관측 범위(그 판정이 만드는 status/verdict/resultFile.path) 밖은 볼 수 없다.
- "일치"의 정의는 §4 그대로이고, 그 셈은 ORCH 몫이다(이 라운드는 재료만 만든다).
- ~~은퇴 기록 검사는 파일 존재만 본다 — 그 파일이 정말 "이 라운드"를 가리키는지는 대조하지 않는다~~ **(2R 수리, §2 참조)**: 이제 role+harnessTaskLabel을 JSON 내용으로 대조한다. 남은 한계: 412의 "전체" 재확인(아카이브 존재·지문 대조·기계 재확인·후속 이름표)은 이 축이 하지 않는다 — 이 축이 보는 것은 "그 라운드를 가리키는 은퇴 기록이 있는가"뿐이다(위조된 은퇴 기록이 role/label만 맞춰 적으면 통과한다 — 그림자(파괴 0) 단계라 과대판정의 대가가 "틀린 아카이브 후보가 로그에 한 줄 더 뜨는 것"뿐이라 감수한다, 무장(PR 2) 전에 재검토해야 한다).
- watch.log의 `teardown_shadow_detail`은 이제 "사유별 건수 요약"이다(2R, P2-2) — 워크트리별 전체 상세(이름+사유)는 받는함 통지 본문에만 있고, **ELIGIBLE이 1건 이상일 때만** 통지 파일이 생긴다(기존 opt-in 트리거 불변) — 전부 거부된 회차(ELIGIBLE 0)는 통지 파일이 없어 그 회차의 워크트리별 상세는 watch.log의 건수 요약으로만 추적된다(실용상 받아들인다: 조치할 게 없는 회차라 상세 손실의 비용이 낮다).
- B1(본체 제외) 판정은 "워크트리 목록의 인덱스 0 = 본체"라는 **실측된 git 동작**에 기댄다 — 이 저장소에서 반복 실측했지만 git 자신의 공식 문서가 그 순서를 보증한다고 명시하지는 않는다(관찰된 동작, 계약은 아니다).
