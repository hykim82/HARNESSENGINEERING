# NC-1 mutation ledger — git-hook devices

각 행은 "방어선을 제거한 사본을 만들었을 때 RED가 되는가"를 실측한
기록이다(설계 §8 2층: 주입이 불가능한 방어선만 사본에서). 실 워크트리 파일은
전부 읽기 전용(`git show HEAD:<path>` 또는 `readFileSync`)이며, 뮤턴트는
`mkdtemp` 임시 디렉터리에만 쓰고 각 테스트 종료 시 삭제된다. 실 소스 파일은
**한 줄도 수정되지 않았다** — 이 원장에 있는 모든 행은 사본(mutant) 실행
결과다.

| #   | 대상                | 제거한 방어선                                          | 뮤턴트 방식                                                                                                                   | 원래 코드 결과                                                                                   | 뮤턴트 결과(RED)                                                                                                    | 재현 테스트                                                                    |
| --- | ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | `review-gate.mjs`   | `verdict: approved` 존재 검사                          | 사본에서 `hasApproved` 계산을 제거하고 `const hasApproved = true;`로 하드코딩                                                 | `verdict: approved` 없는 리뷰 파일 → `{ok:false}`                                                | 동일 입력 → `{ok:true}` (RED)                                                                                       | `scripts/check/nc-review-gate.test.mjs` — `"NC-1 mutation/review-gate #1"`     |
| 2   | `review-gate.mjs`   | `role: REVIEW*`(자기 인증 차단) 검사                   | 사본에서 `hasIndependentReviewer` 계산을 제거하고 `const hasIndependentReviewer = true;`로 하드코딩                           | `role: CODER-CLAUDE`(자기 인증) → `{ok:false}`                                                   | 동일 입력 → `{ok:true}` (RED)                                                                                       | `scripts/check/nc-review-gate.test.mjs` — `"NC-1 mutation/review-gate #2"`     |
| 3   | `review-gate.mjs`   | `skip-review:` 빈 사유 차단                            | 사본에서 `if (skipReason.length === 0) { ... }` 블록을 통째로 제거                                                            | `skip-review: `(공백만) → `{ok:false}`                                                           | 동일 입력 → `{ok:true}` (RED)                                                                                       | `scripts/check/nc-review-gate.test.mjs` — `"NC-1 mutation/review-gate #3"`     |
| 4   | `quality-check.mjs` | null/all-zero base-SHA fail-closed 가드(`NULL_SHA_RE`) | 사본에서 해당 `if` 블록 전체 제거                                                                                             | `baseSha: "0".repeat(40)` → `gitDiff` 호출 전에 `{ok:false}`(가드가 먼저 막음, `gitDiff` 미호출) | 동일 입력 → 가드 없이 `gitDiff`가 그대로 호출되어 `{ok:true}`(주입한 `gitDiff`가 정상 diff를 반환하도록 설정) (RED) | `scripts/check/nc-quality-check.test.mjs` — `"NC-1 mutation/quality-check #1"` |
| 5   | `quality-check.mjs` | `resolveChangedFiles`의 스코프 판정 자체               | 사본에서 `resolveChangedFiles`를 `() => ({ok:true, files:[]})`로 치환(원본은 별도 이름으로 보존해 문법만 유지)                | `baseSha: undefined`(ci 모드) → `{ok:false}`(fail-closed)                                        | 동일 호출을 감싼 `runQualityCheck`가 빈 변경 집합으로 취급해 `{ok:true}`(도구 호출 없이 통과) (RED)                 | `scripts/check/nc-quality-check.test.mjs` — `"NC-1 mutation/quality-check #2"` |
| 6   | `quality-check.mjs` | 삭제 파일 필터(`existsSync` 기반 존재 확인)            | 사본에서 `const existing = changed.files.filter((f) => existsSync(join(cwd, f)));`를 `const existing = changed.files;`로 치환 | 삭제된 파일(`D\tremoved.mjs`) → lint 대상에서 제외(파일이 존재하지 않으므로)                     | 동일 입력 → 존재하지 않는 `removed.mjs`가 그대로 `runTool`에 전달됨 (RED)                                           | `scripts/check/nc-quality-check.test.mjs` — `"NC-1 mutation/quality-check #3"` |

## 사본이 필요 없었던 항목 (1층: 주입만으로 처리)

`review-gate.mjs`·`quality-check.mjs`는 태스크 spec §2-2가 지정한 대로
`{message, reviewPath}` / `{cwd, mode, baseSha, gitDiff}` 인자·포트 주입만으로
방어선 없는 상태를 재현할 수 있어, 위 6개를 제외한 나머지 모든 공격
케이스(`nc-review-gate.test.mjs`·`nc-quality-check.test.mjs`의 `attack`/`gap`
계열 테스트, 총 8+6=14건)는 **소스를 전혀 복제하지 않고** 직접 함수 호출
인자만으로 실행됐다. `pre-commit-gitleaks`는 모듈이 아니라 외부 바이너리라
주입·사본 어느 쪽도 아니고, 합성 저장소에서 바이너리를 직접 실행하는 방식(1층에
가장 가까움 — 실 저장소·실 훅 파일을 전혀 대체하지 않음)을 썼다.
`nc-githook-install.test.mjs`는 전부 읽기 전용 검사(파일 읽기·`git`
조회)이며 사본도 뮤테이션도 없다.

## 숫자 요약 (보고서 §7과 동일 수치의 원장 근거)

> **2R 갱신**: `githook-install` 건수가 8 → 9로 늘었다(gap #9 정밀화로
> location-dependency 결함 재현 테스트 1건 추가). 총합 34 → 35.

- 1층(주입/직접실행/읽기전용, 소스 무수정): `review-gate` 10건(attack 7 +
  defect 1 + gap 2) + `quality-check` 6건(attack 5 + gap 1) +
  `pre-commit-gitleaks` 4건(attack 2 + gap 2, 바이너리 직접 실행 — 저장소
  대체 아님) + `githook-install` 9건(읽기 전용, attack 1 + gap 1 + defect 2 +
  measurement 1 + 존재/참조 확인 4) = **29건**
- 2층(사본에서 뮤테이션): `review-gate` 3건 + `quality-check` 3건 = **6건**
  (위 표)
- 29 + 6 = 35건 = `node --test scripts/check/nc-*.test.mjs` 총 테스트 수와
  일치
- 수행하지 않고 보고만 한 항목: **0건** — 이 사이클에서 "실제 파일을 고쳐야만
  하는" 항목은 나오지 않았다(§3-1·§3-2 두 모듈 모두 인자 주입 가능, §3-3은
  바이너리 직접 실행으로 대체 가능, §3-4는 읽기 전용 검사로 충분했다).

## 원상복구 확인 (3층 — 각 테스트 파일의 `after()` 단언)

> **2R 정정(2026-07-30)**: 아래 문단은 1R 작성 당시 **사실이 아니었다** —
> ORCH가 실측해 지적했다: 1R 시점에 `nc-githook-install.test.mjs`에는
> `after()`도, `git status --porcelain` 단언도, `git diff HEAD --stat`
> 단언도 **전혀 없었다**(0/0/0). 원장이 "네 파일 모두"라고 적은 것 자체가
> 실측과 다른 주장이었다는 뜻이고, 이는 그 자체로 결함이다(원장은 주장과
> 실제가 다르면 그 자체가 결함이라는 원칙, 태스크 §9-2). 아래 서술은 **2R에서
> `nc-githook-install.test.mjs`에 동일한 3층 단언을 추가한 뒤의 현재
> 상태**를 가리키며, 문장 자체는 지우지 않고 이 정정 표시와 함께 남긴다.

네 테스트 파일 모두(1R 당시엔 세 파일만·2R에서 네 번째 파일도 추가됨)
`after()` 훅에서 다음을 단언한다:

- `git status --porcelain`(실 워크트리) === 테스트 시작 전 캡처한 값
- `git diff HEAD --stat`(실 워크트리) === 빈 문자열

2R 실측(수정 직후, `grep -c` 직접 카운트):

```
nc-review-gate    : after()=1  porcelain단언=2  "diff HEAD"단언=1
nc-quality-check  : after()=1  porcelain단언=2  "diff HEAD"단언=1
nc-gitleaks       : after()=1  porcelain단언=2  "diff HEAD"단언=1
nc-githook-install: after()=1  porcelain단언=2  "diff HEAD"단언=1   ← 2R에서 신설
```

이 문서 작성 시점 실측: `node --test scripts/check/nc-*.test.mjs` 전체 실행
후 `git status --porcelain` 결과 = 신규 미추적 테스트 파일 4개(그 자체가
이 작업의 산출물)뿐, 그 외 변경 0. `git diff HEAD --stat` = 빈 출력.

## 실사용 발동 기록 (2026-07-30) — 이 방어선은 합성 재현이 아니라 실사용에서 발동했다

위 표의 모든 항목은 **합성 표적**(mkdtemp 임시 저장소·픽스처)에서 뚫어본
결과다. 이 한 줄만은 다르다: `pre-commit-gitleaks`는 **NC-1 자신의 실제
커밋 시도**를 막았다. `scripts/check/nc-gitleaks.test.mjs:78`의
`DUMMY_AWS_KEY` 리터럴(`"AKIA" + "ABCDEFGHIJKLMNOP"` 형태의 20자 합성
표적 시험용 더미지만, gitleaks의 `aws-access-token` 규칙과 완전히 일치하는
형태 — 이 문서 자체가 `gitleaks`로 스캔되므로 여기서도 완성된 리터럴을
그대로 적지 않는다)이 정문 커밋
시도(`--no-verify` 없음) 중 실 `pre-commit` 훅의 gitleaks 단계에 의해
탐지돼 커밋이 거부됐다(RuleID `aws-access-token`, 파일·라인 정확히
일치). ORCH 판정 = `.gitleaksignore` allowlist 금지(CI도 히스토리 전체를
스캔하므로 예외를 저장소에 새기면 이 트랙이 시험 중인 바로 그 장치를
영구 약화시킨다) — 대신 `DUMMY_AWS_KEY`를 `["AKIA",
"ABCDEFGHIJKLMNOP"].join("")`(런타임 조립)로 바꿔 소스 바이트에 완성된
패턴 리터럴이 남지 않게 했다. 검출 능력은 유지된다 — 임시 저장소에 쓸
때는 조립된 완성 문자열이 되므로 `"NC-1 gitleaks/attack: a synthetic
dummy secret staged for commit -> BLOCKED"` 시험은 수리 후에도 여전히
BLOCKED를 단언한다(재실측 통과). 자세한 내용은
`docs/enforcement-known-gaps.md` #10 참조 — 이것이 이 문서가 "차단
실적 있음(live)"으로 승격한 유일한 항목이다.
