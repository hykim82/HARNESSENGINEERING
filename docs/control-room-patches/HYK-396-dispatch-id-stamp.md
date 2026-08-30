# HYK-396 1R 패치 문서 — `dispatch-worker.ps1`이 실제 dispatch_id를 배달 시점에 보존 사본 헤더에 굽는다

**앵커를 자른 사본** = `scripts/check/fixtures/control-room-dispatch-worker-2026-08-30-hyk396-dispatch-id-stamp-before.ps1.txt`(HYK-387 3R의 "applied" 픽스처를 그대로 복사한 것 — HYK-387 패치가 아직 라이브에 적용되지 않았어도 무방하다, 아래 §0 참조) · **SHA-256 `90763ec2640ddd4b46d59922a84aab821b23944cb6e375532bfa56fb6bfe23e7`**(CODER 직접 재계산 확인 · 2026-08-30) · 총 **695줄**(`wc -l` 실측) · 줄끝 **LF**(이 사본 자체가 LF로 저장돼 있다 — 라이브 파일이 CRLF일 가능성은 HYK-387 문서의 경고와 동일하게 남아 있다, §5 참조).
**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본 사본> --out <출력>`(⛔이 도구는 실제 관제실 경로를 절대 쓰지 않는다 — `--source`/`--out`만 쓴다, 둘 다 파일이다. 라이브 적용은 사람/ORCH 몫).

## §0 이 패치의 앵커가 HYK-387의 라이브 적용 여부와 무관한 이유

이 패치의 유일한 앵커(`Record-DispatchReceipt` 함수 안 `$cliArgs` 줄)는 HYK-387 패치가 건드린 영역(`$ReceiptPath` 해석 블록, 그 함수보다 한참 앞)과 **겹치지 않는다** — CODER가 HYK-387 3R의 "before"(676줄, SHA `b62fe264…`)와 "applied"(695줄, SHA `90763ec2…`) 두 픽스처 양쪽에서 직접 grep해 같은 줄(`  $cliArgs = @($cliPath, "--role", $role, "--task-label", $label, "--receipt-path", $receiptPath)`)이 바이트 그대로 존재함을 확인했다. 즉 이 패치는 HYK-387이 라이브에 아직 적용되지 않았어도, 이미 적용됐어도 **똑같이** 적용된다 — 두 전제 중 어느 쪽이 참인지 이 라운드는 확인할 방법이 없으므로(§0 경계: 관제실 라이브 파일 읽기 금지) 더 안전한(적용 대상이 더 넓은) 쪽인 "applied" 사본을 원본으로 택했다.

## 1. 무엇이 문제인가 (coder-task.md §1, HYK-394 세 번의 실패가 남긴 결론)

소비 판정(`scripts/check/dispatch-gate-decision.mjs`의 `evaluateConsumptionDecision`)은 "직전 라운드가 실제로 소비됐는가"를 판단할 때, 그 라운드가 배달될 당시 자기 task 파일을 스냅숏해 둔 보존 사본(`.harness/rounds/<role>-task-r<N>.md`, `envelope-archive.mjs`의 `archiveRoundTaskFile`)의 `dropped_at`을 근거로 쓴다. HYK-394가 세 차례 직접 실행으로 증명했듯, **판정 시점에 dispatch_id를 다시 조회하는 방식**(재계산)은 "같은 라운드가 재보존된 것"과 "다른(아직 안 끝난) 라운드가 같은 라벨을 재사용한 것"을 원리적으로 구별하지 못한다 — 두 경우 모두 조회 시점의 관측 가능한 값이 완전히 동일하기 때문이다.

유일하게 남은 축은 **배달 시점에 정보를 늘리는 것**: 그 보존 사본이 정확히 "어느 배달"의 것인지, 실제 dispatch_id를 **배달이 실제로 일어난 바로 그 순간**에 사본 자신의 헤더에 각인해 두면, 재드롭은 구조적으로 다른 dispatch_id를 받으므로 판정이 재계산에 의존하지 않고도 갈린다.

## 2. 불변식

> **P1**: 보존 사본에 각인되는 `dispatch_id`는 **그 사본이 실제로 만들어진 배달의, 실제 dispatch 응답에서 온 값**이어야 하며, 판정 시점에 재계산·추측되지 않는다.
> **P2**: 값이 없으면(구 버전 관제실, 또는 아직 이 패치 미적용) 없다고 기록하고, 소비 판정은 그 부재를 이유로 기존 통과 경로를 막지 않는다 — 이 축은 오직 **값이 있는데 틀렸을 때만** 거부를 새로 만든다(순수 추가 축, 회귀 0).

## 3. 왜 여기(Record-DispatchReceipt)인가 — 저장소 쪽이 이미 준비된 결선점

저장소 쪽(`scripts/relay/dispatch-receipt-cli.mjs`, 이번 라운드가 추가한 선택 인자 `--harness-dir`)은 이미 이 CLI가 호출되는 바로 그 순간 필요한 값 셋을 전부 갖고 있다: `role`(이미 인자로 받음), `harnessTaskLabel`(이미 인자로 받음, 사본 파일명 매칭에 필요), 그리고 **방금 stdin으로 받은 실제 dispatch 응답에서 뽑은 `dispatch_id`**(`extractDispatchEnvelope`, 지어낸 값이 아니다). 이 CLI는 `dispatch-worker.ps1`이 실제 `orca orchestration dispatch` 응답을 받은 **직후** 호출되므로(코드 원문 참조: `Record-DispatchReceipt`), 이 지점이 곧 "dispatch_id가 처음으로 알려지는 순간"이다.

⇒ 새 호출 지점을 만들 필요가 없다 — 기존 `Record-DispatchReceipt` 호출문에 `--harness-dir (Join-Path $Worktree ".harness")` 인자 하나만 추가하면, 그 값이 CLI 안에서 `envelope-archive.mjs`의 `stampDispatchIdOnLatestArchivedTaskFile`(이번 라운드 신설)을 거쳐 이 라운드 자신의 보존 사본 헤더(`bestEffortSnapshotRoundTaskFile`이 dispatch **전**에 이미 만들어 둔 그 파일, `dispatch_id=unknown`으로 시작)를 실제 값으로 덮어쓴다.

**이 설계를 고른 이유(버린 대안과 비교)**:

- **게이트(`dispatch-gate-decision.mjs`) 자신이 dispatch_id를 안다** — 아니다. 게이트는 배달 **전**에 돈다(실제 앵커 `dispatch-worker.ps1:171` 부근, HYK-257-done-stamp-2 주석 인용). dispatch_id는 그 뒤에 이어지는 `orca orchestration dispatch` 호출의 응답에만 있다 — 게이트 시점에 값을 만들면 지어내는 것이다.
- **별도 새 CLI/새 호출 지점** — 불필요한 중복이다. `dispatch-receipt-cli.mjs`가 이미 dispatch_id를 손에 쥔 유일한 저장소 CLI이자 유일한 호출 지점이다(HYK-219-receipts-1). 같은 정보를 두 번째 경로로 다시 옮기면 그 자체가 새 드리프트 위험이다.
- **env/레지스트리 영속화** — HYK-387 3R이 이미 이 저장소에서 실측으로 기각한 경로(§1 인용: "별도 터미널로 값이 전파되지 않는다"·"시스템 뮤테이션 위험") — 이번 축은 같은 프로세스(dispatch-worker.ps1 → dispatch-receipt-cli.mjs, 부모-자식) 안에서 끝나므로 애초에 그 문제가 없지만, 그렇더라도 새 상태를 만들지 않는 파일 인자 전달이 더 단순하다.

## 4. 패치 단위 (기계 추출 대상)

```control-room-patch-unit
id: hyk396-dispatch-id-stamp
mode: replace
@@ANCHOR@@
  $cliArgs = @($cliPath, "--role", $role, "--task-label", $label, "--receipt-path", $receiptPath)
@@CONTENT@@
  $cliArgs = @($cliPath, "--role", $role, "--task-label", $label, "--receipt-path", $receiptPath, "--harness-dir", (Join-Path $Worktree ".harness"))
@@END@@
```

## 5. ⚠️정직 — 이 패치가 «못» 하는 것

- **진위(authenticity)는 여전히 범위 밖** — `stampDispatchIdOnLatestArchivedTaskFile`이 굽는 값도, 그 값이 나온 `dispatch-receipts.jsonl` 항목 자체도 위조 가능하다(HYK-390 몫, HYK-387과 동일한 의도된 범위 한계). 이 축은 "값이 배달 시점에 박히는가"만 다루지, 그 값의 진위를 새로 증명하지 않는다.
- **일회성 각인(one-shot)이라 경쟁 상황에서 실패할 수 있다** — `stampDispatchIdOnLatestArchivedTaskFile`은 이미 실값(≠"unknown")이 찍힌 사본을 다른 값으로 재각인하지 않는다(고의로 그렇게 설계함, §2 Q2 코드 주석 참조). 이 라운드가 확인한 실물 흐름(게이트 → 배달 → 영수증, 전부 같은 ps1 프로세스 안에서 순차 실행)에서는 이 경쟁이 생기지 않지만, 그 순서 자체가 미래에 바뀌면(예: 병렬화) 이 가정이 깨질 수 있다.
- **best-effort, 배달을 막지 않는다** — `stampDispatchIdOnLatestArchivedTaskFile`이 실패해도(사본을 못 찾음·못 읽음·이미 다른 값 등) `dispatch-receipt-cli.mjs`의 exit code는 영향받지 않는다(§1 "영수증 기록"이 이 CLI의 1차 계약, 각인은 부가 효과). 즉 이 축이 실패해도 배달 자체는 막히지 않는다 — 그 대신 소비 판정 쪽은 그 사본의 dispatch_id가 여전히 "unknown"(undefined로 해석)이므로 이 새 축을 그냥 건너뛴다(P2, 안전측 — 새 REJECT를 만들지 않는다).
- **줄끝(CRLF/LF) 불확실성은 HYK-387 문서의 경고를 그대로 물려받는다** — §0 참조, 이 문서의 원본 사본은 LF로 저장돼 있지만 실제 라이브 파일이 CRLF일 가능성은 배제하지 않는다(적용 절차 §6의 diff 확인이 이를 잡는다).
- **관제실 파일은 이 저장소 CI가 검증하지 않는다** — fixture 지문 대조가 유일한 드리프트 방어다(HYK-387 §6과 동일 한계).

## 6. 적용 절차

1. `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <라이브 사본> --out <적용본>` — ⛔라이브 파일에 직접 쓰지 않는다.
2. **적용본 diff를 눈으로 확인**(특히 줄끝 스타일이 라이브와 같은지) → 라이브 교체 → 합성 표적으로 1회 구동해 `.harness/rounds/<role>-task-r<N>.md` 헤더의 `dispatch_id`가 실제로 "unknown"에서 실값으로 바뀌는지 확인(⛔실제 배달로 시험하지 않는다).
3. 되돌림 = 원본 SHA-256 사본 보관(이 문서 맨 위 `90763ec2…`).
