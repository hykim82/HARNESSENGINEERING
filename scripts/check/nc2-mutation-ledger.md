# NC-2 mutation ledger — 릴레이·레인 4장치

각 행은 "방어선을 제거한 사본을 만들었을 때 RED가 되는가"를 실측한
기록이다(설계 §8 2층: 주입이 불가능한 방어선만 사본에서). 실 워크트리
파일은 전부 읽기 전용(`git show HEAD:<path>`)이며, 뮤턴트는 `mkdtemp`
임시 디렉터리에만 쓰고 각 테스트 종료 시 삭제된다. 실 소스 파일은 **한
줄도 수정되지 않았다** — 이 원장에 있는 모든 행은 사본(mutant) 실행
결과다.

`relay-handshake` · `role-guard` · `go-task-id-gate`는 3장치 모두 §2-2가
지정한 대로 함수 인자(`harnessDir` / `repoRoot` / `{prompt,taskContent}`)
주입만으로 방어선 없는 상태를 재현할 수 있어(1층), 사본 뮤테이션이
필요하지 않았다. `reject-streak`만 "이미 알려진 결함 4건을 재현·분류"가
핵심 목표라 사본 뮤테이션(2층)으로 **BLOCKED로 판정된 방어선 3개**를
추가로 제거해 RED를 실측했다.

| #   | 대상                | 제거한 방어선                                  | 뮤턴트 방식                                                                                                                                 | 원래 코드 결과                                   | 뮤턴트 결과(RED)                                           | 재현 테스트                                                                    |
| --- | ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | `reject-streak.mjs` | `checkGate`의 envelope-미존재 차단 블록        | 사본에서 `const envelope = checkEnvelope(text); if (!envelope.ok) {...}` 블록을 `const envelope = { ok: true, reason: 'bypassed' };`로 치환 | streak=5, envelope 없음 → `{status:"BLOCK"}`     | 동일 입력 → `{status:"PASS"}` (RED)                        | `scripts/check/nc-reject-streak.test.mjs` — `"NC-2 mutation/reject-streak #1"` |
| 2   | `reject-streak.mjs` | `streak < 2` 문턱값 검사(2단계 승격 조건)      | 사본에서 `if (streak < 2) {`를 `if (true) {`로 치환                                                                                         | streak=9, envelope 없음 → `{status:"BLOCK"}`     | 동일 입력 → `{status:"PASS"}`(항상 문턱 미달로 간주) (RED) | `scripts/check/nc-reject-streak.test.mjs` — `"NC-2 mutation/reject-streak #2"` |
| 3   | `reject-streak.mjs` | `checkEnvelope`의 `ALLOWED_CAUSES` 허용값 검사 | 사본에서 `if (!ALLOWED_CAUSES.some(...)) {...}` 블록 전체 제거                                                                              | `원인 분류: 아무말`(허용 목록 밖) → `{ok:false}` | 동일 입력 → `{ok:true}` (RED)                              | `scripts/check/nc-reject-streak.test.mjs` — `"NC-2 mutation/reject-streak #3"` |

## 사본이 필요 없었던 항목 (1층: 주입만으로 처리)

- `relay-handshake.mjs`: `checkRelayHandshake({role, harnessDir})`에
  mkdtemp `harnessDir`를 주입해 10건 전부(stale-DONE 차단, 미래-DONE gap,
  두 필드의 파서 방향 불일치 2건, 형식 위반 차단 2건, 파일 부재 2건,
  라벨-DONE 미검출 gap, mtime 미대조 gap) 소스 무수정으로 재현.
- `role-guard.mjs`: `checkRoleWrite({role, filePath, repoRoot,
toolInput})`에 가짜(디스크에 존재하지 않는) `repoRoot` 문자열을
  주입해 18건 전부(4역할 허용/차단 8건, 저장소 밖 경로 gap 1건, 경로
  표기 변형 4건, 입력 방어 3건, role fail-open gap 2건) 소스 무수정으로
  재현.
- `go-task-id-gate.mjs`: `checkGoTaskId({prompt, taskContent})` +
  `generateGoLine(taskContent)`에 합성 문자열만 넘겨 17건 전부 소스
  무수정으로 재현.
- `reject-streak.mjs`의 나머지 13건(verdict 파서 fail-open/방향
  비대칭 3건, streak 게이트 fail-open 2건, task_id 없음 gap 1건, 대상
  불일치 defect 1건, approve 무조건 리셋 gap 1건, envelope
  BLOCKED 3건, `loadLedger` 손상 JSON/배열 2건)도 인자·객체 주입만으로
  처리했다 — mutation 대상 3건(위 표)만 "이미 BLOCKED로 판정된 방어선을
  일부러 제거해 RED를 재확인"하는 목적이라 사본이 필요했다.

## 숫자 요약 (보고서와 동일 수치의 원장 근거)

- 1층(주입, 소스 무수정): `relay-handshake` 10건 + `role-guard` 18건 +
  `go-task-id-gate` 17건 + `reject-streak` 13건 = **58건**
- 2층(사본에서 뮤테이션): `reject-streak` 3건(위 표) = **3건**
- 58 + 3 = 61건 = `node --test scripts/check/nc-relay-handshake.test.mjs
scripts/check/nc-reject-streak.test.mjs scripts/check/nc-role-guard.test.mjs
scripts/check/nc-go-task-id-gate.test.mjs` 총 테스트 수(10+16+18+17=61)와
  일치
- 수행하지 않고 보고만 한 항목: **0건** — 이 사이클에서 "실제 파일을
  고쳐야만 하는" 항목은 나오지 않았다(4모듈 전부 순수 함수로 export돼
  인자 주입으로 시험 가능했고, `reject-streak`의 결함 4건도 인자 주입
  만으로 재현됐다).

## 원상복구 확인 (3층 — 각 테스트 파일의 `after()` 단언)

네 테스트 파일 모두 `after()` 훅에서 다음을 **변경 전후 불변**으로
단언한다(빈 출력 요구가 아님 — NC-1 2R 핫픽스로 정정된 형태를 그대로
계승):

- `git status --porcelain`(실 워크트리) === 테스트 시작 전 캡처한 값
- `git diff HEAD --stat`(실 워크트리) === 테스트 시작 전 캡처한 값

실측(수정 직후, `grep -c` 직접 카운트 — `after(` 블록 수 / `Status` 토큰
등장 수(pre+post 캡처·assert 합산) / `DiffStat` 토큰 등장 수(동일)):

```
nc-relay-handshake  : after()=1  Status=4  DiffStat=4
nc-reject-streak    : after()=1  Status=4  DiffStat=4
nc-role-guard       : after()=1  Status=4  DiffStat=4
nc-go-task-id-gate  : after()=1  Status=4  DiffStat=4
```
