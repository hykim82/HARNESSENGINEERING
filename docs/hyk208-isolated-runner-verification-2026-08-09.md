# HYK-208 — 매 실행 전용 사본 러너, 실측 검증 기록 (2026-08-09)

정본 원인 조사 = `docs/hyk206-parallel-test-isolation-findings-2026-08-08.md`(병합됨, PR #124). 이 문서는 그 조사가 확정한 방식(§2 "매 실행 전용 사본")의 구현물(`scripts/check/isolated-suite-runner.mjs`)이 **실제로 원래 사고를 막는지**, **34개 안전망이 여전히 살아 있는지**를 실측한 기록이다.

칠 명령(신설 러너): `node scripts/check/isolated-suite-runner.mjs`
대조군(기존 CI 정본, HYK-208 이전): `node --test scripts/check/*.test.mjs scripts/relay/*.test.mjs scripts/relay/adapters/*.test.mjs scripts/supervisor/*.test.mjs`

측정 환경: 이 워커의 워크트리(`HARNESSENGINEERING\hyk208-isolated-runner`, linked worktree), base `df19cb3`. 모든 표본은 **이 환경·이 라운드 1회씩**이다 — 반복 재현하지 않았다(§8 정직 한계에 명시).

## 1. 내 base(직접 측정, df19cb3, 이 워크트리, 기존 CI 정본 명령)

```
tests 3504 / pass 3501 / fail 0 / skipped 3 / duration_ms 65666.19
```

(참고: `docs/hyk206-...md`가 적은 clone 기준값의 skip 3→6 패턴과 별개로, 이 숫자는 **간섭 없는 이 워크트리 자체**에서 잰 값이다.)

## 2. 신설 러너, 3회 관측(제목의 "간섭 없는 조건"은 회차 1·3에만 해당 — 회차 2는 §3-ⓐ의 간섭 병행 라운드)

| 회차 | 조건                                                        | 결과                                                                 |
| ---- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| 1    | 순정(간섭 없음, 8.3 short-name tmpdir 버그 수정 후 첫 실행) | `tests 3504 / pass 3498 / fail 0 / skipped 6 / duration_ms 64034.90` |
| 2    | §3-ⓐ의 간섭 루프(124회)와 동시 실행                         | `tests 3504 / pass 3498 / fail 0 / skipped 6`                        |
| 3    | 최종 확인(모든 변조 원복 후)                                | `tests 3504 / pass 3498 / fail 0 / skipped 6 / duration_ms 64182.16` |

**총계 회귀 0**: `tests` 3504로 base와 동일, `fail` 0으로 base와 동일. `skipped`만 3→6인데, 원인은 규명됨(§4) — 순정 `git clone`은 `.git/hooks`에 커밋훅을 설치하지 않으므로 `nc-githook-install.test.mjs`의 `INSTALLED_HOOKS_PRESENT` 분기 3건이 추가로 스킵된다. 이것은 CI(actions/checkout)의 기존 동작과도 같다 — CI도 훅을 설치하지 않는 plain checkout이다. **회귀가 아니라 클론이 진짜 committed 상태만 본다는 증거다.**

## 3. 변조 3종 — RED 후 원복

모든 변조는 **원복 확인**(`git diff HEAD -- <file>` 0줄, 또는 스크래치 클론이라 애초에 실제 저장소 무관)까지 마쳤다.

### ⓐ 전용 사본 로직 제거 → 다시 오염 (1회)

**도달 경로**: 이 워크트리(§4 "네 사본")에서, 신설 러너가 아니라 **기존 CI 정본 명령**(원본 `node --test ...`, 클론 없음)을 백그라운드로 돌리면서, **같은 워크트리**에서 병렬로 간섭 루프(`git status --porcelain`/`git diff HEAD --stat` 반복 + untracked 파일 생성·삭제 반복 + `AGENTS.md` 한 줄 추가 후 `git checkout --` 원복 반복, 정지 신호까지 121회)를 돌렸다.

```
전(간섭 없음, §1 base): fail 0
후(간섭, 기존 정본 명령, 121회 간섭 루프): SUITE_EXIT_CODE=1, tests 3537 / pass 3505 / fail 29 / skipped 3
  실패 시험 파일(20개 이상, 예): nc-ci-enforce.test.mjs, nc-githook-install.test.mjs,
    nc-go-task-id-gate.test.mjs, nc-orca-automations.test.mjs, nc-quality-check.test.mjs,
    nc-reject-streak.test.mjs, nc-relay-handshake.test.mjs, nc-role-guard.test.mjs,
    reject-streak-auto-record.test.mjs, review-gate-auto-record.test.mjs,
    skip-review-usage.test.mjs, terminal-show-adapter.test.mjs, concurrency-core.test.mjs,
    dispatch-start-core.test.mjs, dispatch-start-wire.test.mjs, orch-stall-detect.test.mjs,
    raw-preserve-core.test.mjs, requery-join-core.test.mjs, schedule-plan-core.test.mjs,
    schedule-wire.test.mjs (전부 "must leave the real worktree exactly as it found it" 패턴)
```

**같은 간섭 조건에서 신설 러너로 대체**(124회 간섭 루프, 별도 라운드):

```
SUITE_EXIT_CODE=0, tests 3504 / pass 3498 / fail 0 / skipped 6
```

⇒ **같은 간섭에서 수리 전 = fail 29(1/1 재현), 수리 후 = fail 0(1/1)**. 워크트리는 두 라운드 모두 간섭 루프 종료 후 `git status --porcelain` 깨끗함(스크래치 파일·`AGENTS.md` 변경 잔존 없음) 확인.

### ⓑ 시험이 저장소를 더럽히는 것을 일부러 만들어 → 그래도 빨간불인지 (1회, 안전망 생존 증명)

**도달 경로**: 실제 워크트리를 커밋하지 않고(review-gate 커밋훅이 임의 "wip" 메시지를 막으므로 — 우회하지 않았다) 별도 스크래치 클론(`mkdtemp` + `git clone .`, 훅 미설치·순수 로컬 사본, 실제 저장소·main 체크아웃 무접촉)에 신설 러너 파일 3종을 복사하고, `scripts/check/skip-review-usage.test.mjs`에 **일부러 정리 안 하는 시험**(`writeFileSync(join(ROOT, "HYK208-TAMPER-B-SCRATCH.tmp"), ...)`, `after()`에서 지우지 않음)을 추가해 스크래치 클론에 커밋했다. 그 스크래치 클론을 `--repo-root`로 신설 러너에 넘겨 실행했다(러너는 그 스크래치 클론을 **또** 자기 임시 클론으로 복제해 시험을 돌린다 — 이중 클론이지만 메커니즘은 동일).

```
SUITE_EXIT_CODE=1, tests 3520 / pass 3504 / fail 10 / skipped 6
실패 원문(예): "?? HYK208-TAMPER-B-SCRATCH.tmp\n" -- "must leave the real worktree exactly as it found it" 류 10건
```

⇒ **시험 스스로가 자신이 도는 체크아웃(=격리된 클론)을 더럽히면, 격리된 상태에서도 여전히 빨간불**이다(1/1). 즉 "격리했더니 아무것도 검사 안 하게 됐다"가 아니다 — 34개 안전망은 각자 `git rev-parse --show-toplevel`로 **자기 프로세스의 cwd**(=클론)를 보므로, 외부 간섭(ⓐ)은 더 이상 안 보이지만 자기 자신이 낸 더러움(ⓑ)은 여전히 잡는다. 변조는 실제 저장소를 전혀 건드리지 않았고(스크래치 클론에서만 발생), 실측 후 스크래치 클론 전체를 삭제해 원복했다. 실제 워크트리 파일(`skip-review-usage.test.mjs`)에 넣었던 동일 변조도 `git diff HEAD` 0줄까지 확인 후 제거했다.

### ⓒ 목록 밖 1종 — 격리 배선 자체를 잘못 만듦 (1회)

**도달 경로**: `isolated-suite-runner.mjs`의 실행부에서 `spawn(..., { cwd: cloneDir, ... })`를 일부러 `{ cwd: root, ... }`(원본 소스 루트)로 바꿨다 — "클론은 만들지만 실제 실행은 원본을 본다"는, ⓐ(러너 자체를 안 쓰는 것)와는 다른 실패 양상(러너는 있지만 배선이 틀림)이다. 이 상태로 이 워크트리에서 신설 러너를 돌리면서 같은 간섭 루프(182회, `git status`/untracked 생성삭제/`AGENTS.md` 원복)를 병행했다.

```
SUITE_EXIT_CODE=1, tests 3528 / pass 3498 / fail 27 / skipped 3
```

⇒ **격리 코드가 존재해도 배선이 틀리면(클론은 만들되 실행은 원본을 보면) 원래 사고가 그대로 재발한다**(1/1) — 클론을 만드는 것 자체가 아니라 **실행 cwd를 클론으로 돌리는 것**이 방어의 핵심이라는 뜻이다. `cwd: root` → `cwd: cloneDir`로 원복 후 unit test 6/6 재확인, 최종 clean 실행(§2 회차 3)으로 재확인했다.

## 4. `npx eslint` / `npx prettier --check` 원문

```
$ npx eslint scripts/check/isolated-suite-runner.mjs scripts/check/isolated-suite-runner.test.mjs scripts/check/skip-review-usage.test.mjs
(출력 없음 -- 0 문제)

$ npx prettier --check scripts/check/isolated-suite-runner.mjs scripts/check/isolated-suite-runner.test.mjs scripts/check/skip-review-usage.test.mjs .github/workflows/enforce.yml
Checking formatting...
All matched files use Prettier code style!
```

## 5. `git log -1` 원문

```
df19cb3 Merge pull request #125 from hykim82/hyk173-escalation
```

(신설 러너·CI 변경은 이 커밋 위에 아직 미커밋 상태로 검증했다 — §0 "«done» 전 git log -1 확인"은 실제 커밋 시점에 다시 확인한다.)

## 6. 정직 한계 — 이 방식이 못 막는 것

- **못 막는 것 1 — 클론 생성 자체의 경합**: `git clone`이 소스 워크트리에서 객체를 읽는 짧은 순간, 그 소스에서 동시에 `git gc`나 히스토리를 바꾸는 작업(브랜치 강제 이동, reflog 만료 등)이 일어나면 클론이 이상한 상태로 뜰 수 있다 — 이건 이 조사 범위 밖이고 재현하지 않았다.
- **못 막는 것 2 — 미커밋 내용은 애초에 시험 안 됨**(§2 승인된 트레이드오프, 결함 아님): 러너 출력에 매 실행 `tested commit <sha>`와, 워킹트리가 dirty일 때 `NOTE: ... uncommitted changes ... excluded` 한 줄을 항상 찍는다(`formatBanner`, unit test로 고정).
- **못 막는 것 3 — 같은 임시 디렉터리 경로를 다른 프로세스가 정확히 노려서 건드리는 경우**: `mkdtempSync`는 난수 접미사를 쓰므로 사실상 예측 불가능하지만, "무슨 방법으로도 못 막는다"는 뜻은 아니다 — OS가 그 프로세스가 만든 임시 디렉터리 권한을 다른 사용자에게 준다면(다중 사용자 공유 머신, 권한 설정 오류) 이론상 가능하다. 이 저장소·이 CI 환경(단일 러너, 표준 임시디렉터리 권한)에서는 해당 안 된다고 보지만 감사하지는 않았다.
- **못 막는 것 4 — 34개 안전망 코드 자체의 재작성은 이 라운드 범위 밖**: 이번 변경은 실행 환경(어느 체크아웃에서 도는가)만 바꿨다. 34개 파일의 `repoRoot()`/`preStatus` 상용구 자체(§4 목록 밖 리팩터, `docs/hyk206-...md` §6의 "34개 파일 락 리팩터" 선택지)는 건드리지 않았다 — 손대지 말라는 지시(HYK-208 task §2 "방식을 바꾸지 마라")와도 일치한다.
- **CI 환경 차이**: 이 실측은 전부 Windows(이 워커의 워크트리) 기준이다. CI는 ubuntu-latest다. Windows 전용으로 확인·수정한 것: OS 임시 디렉터리가 8.3 short-name(`ADMINI~1`)을 줄 수 있다는 문제(`longFormTmpdir()`로 `realpathSync.native` 우회) — 이건 리눅스에는 없는 문제지만, 우회 코드 자체는 리눅스에서도 무해하다(`realpathSync.native`가 그냥 같은 경로를 돌려준다). CI가 실제로 도는지는 **로컬 초록만으로 승인 근거로 쓰지 않는다** — ORCH가 CI에서 확인해야 하는 항목으로 명시적으로 남긴다.

## 7. 2R — REVIEW 반려(`HYK-208-isolated-runner-review-1`) 수리 실측 (커밋 `c81acec`)

REVIEW가 별도 fixture로 규명한 원인: `.github/workflows/enforce.yml:31`이 새 러너 호출로 바뀌었는데 `scripts/check/nc-ci-enforce.test.mjs`는 여전히 옛 raw `node --test ...` 리터럴을 변조 대상으로 삼아 변조가 실제로 안 들어갔다(`tests 3510 / fail 3`). 그 밖에 `collectTestFiles()`가 기대한 디렉터리를 못 읽으면 예외 없이 `continue`하는 잔여 위험도 지적했다.

### 7-1. 정본 전체 스위트 원문 — 수리 전/후

```
수리 전(REVIEW 원문): tests 3510 / fail 3 / exit 1
수리 후(이 라운드, 이 워크트리, base c81acec):
  raw 정본 명령: tests 3513 / pass 3510 / fail 0 / skipped 3 / exit 0
  신설 러너:     tests 3513 / pass 3507 / fail 0 / skipped 6 / exit 0
```

(`tests` 총계가 3504→3513으로 늘어난 것은 1R 이후 이 라운드에서 추가한 unit test 3건(`isolated-suite-runner.test.mjs`의 fail-closed 시험 2건 + collectFiles DI 전파 시험 1건, HYK-208 자기 자신의 시험)만큼이다 — 개수를 산문에 박지 말라는 함정 §7-2에 따라 여기 표로만 남긴다.)

### 7-2. 변조 3종 — RED 후 원복(시험 이름까지)

두 방식으로 진행했다: ⓐ는 이 워크트리(§4 "네 사본")에서 직접, ⓑ·ⓒ는 review-gate 커밋훅을 우회하지 않기 위해 별도 스크래치 클론(`mkdtemp` + `git clone .`, 훅 미설치)에서 진행했다 — 전부 실제 저장소·main 체크아웃 무접촉.

**ⓐ `nc-ci-enforce`의 새 변조가 실제로 먹는지** (스크래치 클론 A, 1회):
`.github/workflows/enforce.yml`의 test step을 옛 raw 명령(`node --test scripts/check/*.test.mjs ...`)으로 되돌려(=이 라운드 수정 자체를 되돌림) 커밋하고, `node --test scripts/check/nc-ci-enforce.test.mjs`를 그 클론 안에서 직접 돌렸다.

```
tests 16 / pass 14 / fail 2
실패 시험: "NC-3 ci-enforce/contract: workflow invokes scripts/check/isolated-suite-runner.mjs, AND that tracked runner covers all 4 required directories ..."
          "NC-3 mutation/ci-enforce #2a: workflow test step reverted to the raw pre-HYK-208 node --test command (no longer invokes the runner) -> RED"
```

⇒ 계약 시험 자체가 실제로 RED(1/1) — 헛시험이 아니다. 원복: 스크래치 클론 전체 삭제.

**ⓑ `collectTestFiles`의 새 fail-closed 제거 → 조용히 건너뜀**: 실제 4개 디렉터리 중 하나가 사라진 상태에서 수리 전/후 코드를 대조해야 충돌 없는 대조가 되므로, `scripts/`의 실제 상호 import와 무관한 최소 합성 fixture 저장소(`mkdtemp` + `git init`, 4개 디렉터리에 사소한 통과 시험 1개씩 + 신설 러너 사본)를 만들어 비교했다(콜래터럴 없는 순수 대조 -- 실제 저장소의 `scripts/relay/adapters` 전체를 지워봤더니 그 디렉터리를 import하는 무관한 시험들까지 깨져 신호가 섞였다, 그래서 방법을 바꿨다).

```
기준(4/4 디렉터리 존재, 수리된 코드): tests 4 / pass 4 / fail 0 / exit 0
scripts/relay/adapters 디렉터리 전체 삭제 후:
  수리된 코드(fail-closed):  exit 1, 즉시 크래시 -- "required test directory unreadable in the clone: scripts/relay/adapters (ENOENT...)"
  fail-closed 제거(구 코드, catch{ continue; }로 되돌림): exit 0, tests 3 / pass 3 / fail 0
    -- 사라진 디렉터리에 대한 언급이 전혀 없이 4개 중 3개만 조용히 돌고 초록으로 끝났다.
```

⇒ 새 fail-closed를 지우면 정확히 REVIEW가 우려한 모양(장치는 있는데 조용히 건너뛰고 초록)이 재현된다(1/1). 합성 fixture는 실제 저장소와 완전 무관 — 실측 후 전체 삭제.

**ⓒ 시험이 clone을 더럽혀도 초록이 되게 변조 → RED 여야 한다** (스크래치 클론 C, 안전망 생존 재확인, 1회): `skip-review-usage.test.mjs`에 자기 clone을 정리 안 하고 더럽히는 시험을 주입해 커밋하고, 신설 러너(2R 수리 코드 포함)를 그 클론에서 실행했다.

```
SUITE_EXIT_CODE=1, tests 3523 / pass 3507 / fail 10
실패 원문(예, reject-streak-auto-record.test.mjs): "must leave the real worktree exactly as it found it"
  + actual - expected
  + '?? HYK208-2R-TAMPER-C-SCRATCH.tmp\n'
```

⇒ §1 인정 항목("안전망이 살아 있다")이 2R 수정 이후에도 유지된다(1/1). 원복: 스크래치 클론 전체 삭제, 실제 워크트리는 `git status --porcelain` 전 과정 동안 무변화(공백) 확인.

### 7-3. `npx eslint` / `npx prettier --check` 원문 (2R)

```
$ npx eslint scripts/check/isolated-suite-runner.mjs scripts/check/isolated-suite-runner.test.mjs scripts/check/nc-ci-enforce.test.mjs
(출력 없음 -- 0 문제)

$ npx prettier --check scripts/check/isolated-suite-runner.mjs scripts/check/isolated-suite-runner.test.mjs scripts/check/nc-ci-enforce.test.mjs .github/workflows/enforce.yml
Checking formatting...
All matched files use Prettier code style!
```

### 7-4. `git log -1` 원문 (2R)

```
c81acec fix(check): HYK-208 2R -- CI 초록화 + collectTestFiles fail-closed
```

### 7-5. CI 성립성 재확인

`.github/workflows/enforce.yml`을 다시 읽었다: 28행 `npm ci` 뒤 31행이 `node scripts/check/isolated-suite-runner.mjs`를 실행하고, 이후 quality-check/nul-byte-guard/gitleaks 단계가 이어진다 — 구조 자체는 1R 검토 때와 동일(ubuntu-latest, `fetch-depth: 0`, Node 20). 이번 라운드가 바꾼 것은 그 31행 스텝이 실제로 이름 그대로의 텍스트("check test suites (scripts/check + scripts/relay + scripts/relay/adapters + scripts/supervisor *.test.mjs)")로 남아 있고, 그 이름 뒤의 `run:` 라인만 새 러너를 가리키는 상태 — 1R 커밋 때 내가 스텝 이름에 ", HYK-208 isolated clone)" 접미사를 붙였던 것을 되돌렸다(§7-1 원인이 정확히 이 접미사였다: `nc-ci-enforce.test.mjs`의 리터럴 매치가 그 스텝 이름 전체를 앵커로 쓴다).

**여전히 로컬 초록만으로 승인 근거를 삼지 않는다**: 이 실측은 전부 Windows다. §6 "못 막는 것"·CI 환경 차이는 1R과 동일하게 유효하다 — 2R에서 새로 발견된 Linux 전용 리스크는 없다(코드 변경이 파일시스템 계층이 아니라 텍스트 계약 검사 로직과 예외 처리이므로).

### 7-6. §4 잔여(고치지 말고 기재만) — 재확인

- `.git/hooks`가 clone에 안 따라가는 문제(`nc-githook-install.test.mjs`)는 이번 라운드에서 손대지 않았다. 재확인(이 워크트리, 이 라운드): `tests 11 / pass 10 / fail 0 / skipped 1`. REVIEW가 clone에서 관측한 값(`tests 11 / pass 8 / skipped 3`)과 비교하면 여전히 clone 쪽이 skip 2건 더 많다 — 원인은 REVIEW·1R 문서 모두와 동일(설치된 `.git/hooks`가 없으면 skip하는 environment-conditional 측정, plain clone은 훅을 설치하지 않음). 코드 변경 없음.
- `.harness` 미포함은 승인된 트레이드오프 그대로.
