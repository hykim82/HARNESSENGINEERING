# NC-3 mutation ledger — 경계·환경 2장치 (`ci-enforce` · `orca-automations-present`)

각 행은 "방어선을 제거/변조한 사본을 만들었을 때 RED가 되는가"를 실측한
기록이다(설계 §8 2층). 실 워크트리 파일은 전부 읽기 전용(`git show
HEAD:<path>`)이며, 뮤턴트는 `mkdtemp` 임시 디렉터리에만 쓰고 각 테스트
종료 시 삭제된다. 실 소스 파일(`.github/workflows/enforce.yml` ·
`scripts/check/orca-posture-check.mjs`)은 **한 줄도 수정되지 않았다** — 이
원장에 있는 모든 행은 사본(mutant) 실행 결과다.

`ci-enforce`는 모듈이 아니라 CI가 실행하는 YAML 텍스트라 "주입 가능한
포트"가 없다 — 계약 시험 자체가 텍스트 정규식 검사이므로, §4-2가 요구한
"사본-뮤테이션"은 **같은 계약 검사 함수(pure function of text)를 원본
텍스트와 변조된 사본 텍스트 양쪽에 적용해 결과가 갈리는지 실측**하는
형태로 구현했다(뮤턴트 텍스트는 실제로 mkdtemp 파일에 쓰여진다 — 순수
문자열 비교가 아니라 디스크에 쓴 사본을 다시 읽어 검사한다).

`orca-automations-present`(`checkAutomationsPresent`)는 순수 함수라
공격 12건 전부 함수 인자 주입만으로 처리됐다(1층). 사본-뮤테이션은
"이미 BLOCKED로 판정된 두 분기(부재→OK, 마커없음→UNJUDGABLE)를 일부러
반대로 바꿔 RED를 재확인"하는 목적으로 2건만 필요했다(2층, 아래 표).

## ci-enforce (텍스트 사본 뮤테이션)

| #   | 대상                            | 제거/주입한 방어선                              | 뮤턴트 방식                                                                                                                                                                              | 원본 텍스트 결과                                                   | 뮤턴트 텍스트 결과(RED)                                           | 재현 테스트                                                              |
| --- | ------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | `.github/workflows/enforce.yml` | 어디에도 `continue-on-error`가 없어야 하는 계약 | 사본에 테스트 스텝 아래 `continue-on-error: true` 한 줄 주입                                                                                                                             | `hasContinueOnError()` → `false`                                   | 동일 검사 함수 → `true` (RED)                                     | `scripts/check/nc-ci-enforce.test.mjs` — `"NC-3 mutation/ci-enforce #1"` |
| 2   | `.github/workflows/enforce.yml` | 테스트 glob 4개 전부 포함 계약                  | 사본에서 `node --test scripts/check/*.test.mjs scripts/relay/*.test.mjs scripts/relay/adapters/*.test.mjs scripts/supervisor/*.test.mjs`를 `node --test scripts/check/*.test.mjs`로 축소 | `hasFullTestGlob()` → `true`                                       | 동일 검사 함수 → `false` (RED)                                    | `scripts/check/nc-ci-enforce.test.mjs` — `"NC-3 mutation/ci-enforce #2"` |
| 3   | `.github/workflows/enforce.yml` | gitleaks 설치+검증+스캔 스텝 존재               | 사본에서 `Install gitleaks` 스텝부터 파일 끝까지 통째로 제거(뒤이은 `gitleaks secret scan` 스텝도 함께 사라짐)                                                                           | `hasGitleaksChecksumPin() && hasGitleaksChecksumVerify()` → `true` | 동일 검사 함수 → `false` (RED)                                    | `scripts/check/nc-ci-enforce.test.mjs` — `"NC-3 mutation/ci-enforce #3"` |
| 4   | `.github/workflows/enforce.yml` | `sha256sum -c` 체크섬 실제 검증 존재            | 사본에서 `echo "${GITLEAKS_SHA256}  gitleaks.tar.gz" \| sha256sum -c -` 줄만 제거(핀 상수 `GITLEAKS_SHA256`는 그대로 둠)                                                                 | `hasGitleaksChecksumVerify()` → `true`                             | 동일 검사 함수 → `false` (RED, 핀 상수만 있고 실제 검증은 사라짐) | `scripts/check/nc-ci-enforce.test.mjs` — `"NC-3 mutation/ci-enforce #4"` |

## orca-automations-present (모듈 사본 뮤테이션)

| #   | 대상                     | 제거한 방어선                                  | 뮤턴트 방식                                                                                       | 원래 코드 결과                              | 뮤턴트 결과(RED)                                        | 재현 테스트                                                                          |
| --- | ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `orca-posture-check.mjs` | "마커 못 찾음 → UNJUDGABLE(거짓 OK 금지)" 분기 | 사본에서 해당 `return { status: "UNJUDGABLE", ... }` 블록을 `return { status: "OK", ... }`로 치환 | db 존재·마커 없음 → `{status:"UNJUDGABLE"}` | 동일 입력 → `{status:"OK"}` (RED — 핵심 계약 위반 재현) | `scripts/check/nc-orca-automations.test.mjs` — `"NC-3 mutation/orca-automations #1"` |
| 2   | `orca-posture-check.mjs` | "db 부재 → OK" 분기                            | 사본에서 해당 `return { status: "OK", ... }` 블록을 `return { status: "WARN", ... }`로 치환       | dbPath 부재 → `{status:"OK"}`               | 동일 입력 → `{status:"WARN"}` (RED — 거짓 경보 방향)    | `scripts/check/nc-orca-automations.test.mjs` — `"NC-3 mutation/orca-automations #2"` |

## 사본이 필요 없었던 항목 (1층: 주입/읽기전용, 소스 무수정)

- `ci-enforce`: §4-1 계약 단언 8건(트리거 2종·테스트 glob·continue-on-error
  부재·if: 부재·gitleaks 핀+검증·fetch-depth·quality-check 스텝·hooks
  sh -n) 전부 추적본 텍스트(`git show HEAD:...`)를 **읽기만** 해서
  실행됐다. §4-3 "끌 수 있는 표면" 표 시험 3건도 하드코딩된 fixture(수동
  1회 관측 결과)만 검사하는 읽기 전용 시험이라 사본이 필요 없었다.
- `orca-automations-present`: `checkAutomationsPresent({dbPath, existsFn,
readFileFn})`가 전부 주입 가능해(`orca-posture-check.mjs:136`), db 부재
  OK · 마커 존재 WARN · 마커 없음 UNJUDGABLE · 예외 throw → UNJUDGABLE ·
  UTF-16LE 인코딩 미탐지(2건, 기본 Buffer/latin1 경로 + `runOrcaPostureCheck`가
  쓰는 utf8-문자열 경로 각각) · 대소문자 변형 미탐지 · `runOrcaPostureCheck`
  결선 확인(죽은 코드 아님 증명) · `enforcement-inventory.json`의
  "Not hook-installed" 문구 읽기전용 확인, 총 9건이 함수 인자/포트
  주입만으로 소스 무수정 재현됐다.

## 숫자 요약 (보고서와 동일 수치의 원장 근거)

- 1층(주입/읽기전용, 소스 무수정): `ci-enforce` 8(계약) + 3(off-surfaces) =
  **11건** + `orca-automations-present` **9건** = **20건**
- 2층(사본에서 뮤테이션): `ci-enforce` 4건 + `orca-automations-present`
  2건 = **6건**
- 20 + 6 = 26건 = `node --test scripts/check/nc-ci-enforce.test.mjs
scripts/check/nc-orca-automations.test.mjs` 총 테스트 수(15+11=26)와 일치
- 수행하지 않고 보고만 한 항목: **1건** — §4-3의 "네트워크 관측"은 테스트
  코드 안에서 수행하지 않고(CI 오프라인 안전을 위해 태스크 spec §4-3-4가
  명시적으로 금지) 이번 세션에서 **손으로 1회** curl로 관측한 뒤 그 결과를
  fixture로 하드코딩했다 — 이 관측 자체는 "수행했으나 테스트 실행 경로
  안에 넣지 않고 fixture화"이지, 완전한 미수행은 아니다. 완전 미수행 항목은
  0건.

## 원상복구 확인 (3층 — 각 테스트 파일의 `after()` 단언)

두 테스트 파일 모두 `after()` 훅에서 다음을 **변경 전후 불변**으로
단언한다(빈 출력 요구가 아님 — NC-1/NC-2와 동일한 형태 계승):

- `git status --porcelain`(실 워크트리) === 테스트 시작 전 캡처한 값
- `git diff HEAD --stat`(실 워크트리) === 테스트 시작 전 캡처한 값
