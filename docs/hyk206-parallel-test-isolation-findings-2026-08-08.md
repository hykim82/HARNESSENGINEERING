# HYK-206 — 병렬 시험 격리 조사 결과 (2026-08-08)

이슈 HYK-206 이 서술한 "두 곳에서 동시에 전 스위트를 돌리면 서로 깨뜨린다"를 실측으로 검증한 기록이다. **코드 변경 없음** — 이 라운드는 조사·문서화만 하고, 시험/프로덕션 코드 0줄이다(CODER task §4). 이 문서를 `docs/`에 커밋하는 이유는 `.harness/`가 gitignore 대상이라 워크트리 정리 시 조사 증거가 통째로 사라지기 때문이다.

칠 명령(CI 정본, `.github/workflows/enforce.yml:31`):

```
node --test scripts/check/*.test.mjs scripts/relay/*.test.mjs scripts/relay/adapters/*.test.mjs scripts/supervisor/*.test.mjs
```

## 1. 음성 결과 — 6라운드 조건에서 실패를 관찰하지 못했다

**토폴로지 A**(완전 독립 `git clone`)와 **토폴로지 B**(같은 저장소의 linked worktree, `.git/objects`·`.git/refs` 공유 — 사고 당시 실제 구성과 동일. `git worktree list`로 직접 확인: 메인 체크아웃 `Documents\HARNESSENGINEERING`과 이 워커의 워크트리는 둘 다 같은 저장소의 linked worktree다)에서, 서로 다른 두 워크트리/체크아웃이 **동시에** 전 스위트를 도는 조건으로 아래를 실측했다.

- 단독 기준값(이 워크트리, base `1e21f77`): `tests 3483 / pass 3480 / fail 0 / skipped 3 / duration_ms 64940.55`
- 단독 기준값(`mkdtemp`에 `git clone .`한 별도 체크아웃, base `1e21f77`): `tests 3483 / pass 3477 / fail 0 / skipped 6 / duration_ms 62521.13`

동시 실행 결과 — **표본 6라운드(2-way 4회 + 4-way 2회), 실패 0회**:

| 라운드 | 구성                                             | 결과 A                                                              | 결과 B                                               |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------- |
| 1      | 독립 clone vs 이 워크트리 (2-way, ×1)            | `tests 3483 / pass 3480 / fail 0 / skipped 3`                       | `tests 3483 / pass 3477 / fail 0 / skipped 6`        |
| 2~4    | linked worktree(wt2) vs 이 워크트리 (2-way, ×3)  | 매 라운드 `tests 3483 / pass 3480 / fail 0 / skipped 3` (양쪽 동일) | —                                                    |
| 5~6    | 이 워크트리 + wt2 + wt3 + 독립 clone (4-way, ×2) | `tests 3483 / pass 3480 / fail 0 / skipped 3`(세 워크트리 동일)     | `tests 3483 / pass 3477 / fail 0 / skipped 6`(clone) |

**⇒ "서로 다른 워크트리/체크아웃에서 동시에 전 스위트를 돌리는 것" 자체는, 이 6라운드 표본·이 조건(24코어 머신, 위 두 토폴로지, 각 라운드 1회씩)에서는 실패를 관찰하지 못했다.** 이것은 이슈가 전제한 메커니즘("공용 원장 경합")이 **이 조건에서는 재현되지 않았다**는 뜻이지, 그 메커니즘이 어떤 조건에서도 일어날 수 없다는 뜻은 아니다 — 표본이 6라운드로 작고(§8), 사고 당시 머신·부하 조건을 그대로 통제했다는 보장이 없다.

## 2. 양성 결과 — 토폴로지 C(같은 체크아웃, 동시 간섭)는 3/3 재현

**구성**: `mkdtemp`에 `git clone .`한 **단일** 임시 체크아웃에서 전 스위트가 도는 **동안**, **같은 폴더**에서 별도 백그라운드 프로세스가 아래 4종 간섭을 반복(정지 신호까지 루프, 라운드당 54~56회 반복):

- **C-1**: `git status --porcelain` / `git diff HEAD --stat` 반복 실행
- **C-2**: 추적 안 된 파일(`TOPOC-SCRATCH.tmp`) 생성 → 즉시 삭제, 반복
- **C-3**: 추적 파일(`AGENTS.md`)에 한 줄 추가 → `git checkout -- AGENTS.md`로 원복, 반복
- **C-4**: `git fetch origin` + 로컬 브랜치 2개(`topoC-alt` ↔ 원 브랜치) 사이 `git checkout` 반복 (같은 커밋이라 작업 트리 파일 내용 자체는 안 바뀜)

**표본 3라운드, 3/3 오염**:

```
round1: tests 3494 / pass 3477 / fail 11 / skipped 6
round2: tests 3493 / pass 3475 / fail 12 / skipped 6
round3: tests 3496 / pass 3476 / fail 14 / skipped 6
```

(참고: `tests` 총계가 라운드마다·단독 기준값 3483과도 다르다. 원인은 조사하지 않았다 — 아마 저장소 내용을 실측 스캔하는 일부 시험의 동적 서브테스트 개수 자체가 간섭으로 흔들리는 것으로 보이나, 확인하지 않았다.)

**라운드별 실패 파일**(node --test 리포터의 `✖ <path> (<ms>)` 최상위 라인 그대로, 경로만 표시):

```
round1 (11): scripts/check/nc-gitleaks.test.mjs
             scripts/check/nc-review-gate.test.mjs
             scripts/check/review-gate-auto-record.test.mjs
             scripts/check/skip-review-usage.test.mjs
             scripts/relay/adapters/terminal-show-adapter.test.mjs
             scripts/supervisor/raw-preserve-core.test.mjs
             scripts/supervisor/requery-join-core.test.mjs
             scripts/supervisor/task-drop-core.test.mjs
             scripts/supervisor/unconsumed-wire.test.mjs
             scripts/supervisor/watch-freshness-core.test.mjs
             scripts/supervisor/watch-run.test.mjs

round2 (12, 상위파일10 + 하위 subtest 2건): scripts/check/nc-relay-handshake.test.mjs
             scripts/check/nc-review-gate.test.mjs
             scripts/relay/adapters/terminal-show-adapter.test.mjs
             scripts/supervisor/dispatch-start-wire.test.mjs
             scripts/supervisor/raw-preserve-core.test.mjs
             scripts/supervisor/requery-join-core.test.mjs
             scripts/supervisor/schedule-plan-core.test.mjs
             scripts/supervisor/task-drop-core.test.mjs
             scripts/supervisor/unconsumed-wire.test.mjs
             scripts/supervisor/watch-freshness-core.test.mjs
             (+ 서브테스트: "(10) runSmokeSuite: against the real repo -- all cases pass and repo diff is zero before/after (G8)"
                "skip-review-usage: measuring the real repo leaves git status untouched")

round3 (14): scripts/check/nc-review-gate.test.mjs
             scripts/check/reject-streak-auto-record.test.mjs
             scripts/check/review-gate-auto-record.test.mjs
             scripts/check/skip-review-usage.test.mjs
             scripts/relay/adapters/terminal-show-adapter.test.mjs
             scripts/supervisor/raw-preserve-core.test.mjs
             scripts/supervisor/requery-join-core.test.mjs
             scripts/supervisor/schedule-plan-core.test.mjs
             scripts/supervisor/schedule-wire.test.mjs
             scripts/supervisor/seat-idle-core.test.mjs
             scripts/supervisor/seat-idle-wire.test.mjs
             scripts/supervisor/seat-liveness-wire.test.mjs
             scripts/supervisor/unconsumed-wire.test.mjs
             (+ 서브테스트 일부 이중 카운트 가능성 있음 — 상위 실패 목록 위주로 집계했다)
```

**실패 원문 — 전부 동일한 패턴**(예, round1 `nc-review-gate.test.mjs`):

```
test at scripts\check\nc-review-gate.test.mjs:486:1
✖ ...\topoC\scripts\check\nc-review-gate.test.mjs (145.5059ms)
  AssertionError [ERR_ASSERTION]: nc-review-gate.test.mjs must leave the real worktree exactly as it found it
  + actual - expected

  + '?? TOPOC-SCRATCH.tmp\n'
  - ''
```

다른 예(같은 로그, review-gate-auto-record.test.mjs):

```
AssertionError [ERR_ASSERTION]: review-gate-auto-record.test.mjs must leave the real worktree exactly as it found it
  + actual - expected
  + ' M AGENTS.md\n'
  - ''
```

**3라운드에서 관찰된 실패는 전부 "must leave the real worktree exactly as it found it" (또는 그 변형 문구) 하나뿐이었다. 타임아웃·잠금 에러·기타 원인은 한 건도 없었다.**

**이 3/3 재현은 간섭(C-1~C-4)을 의도적으로 만든 조건에서의 기전 재현이다 — "이 메커니즘이 실제로 존재한다"를 보여줄 뿐, 실제 운영(다른 좌석·사람·ORCH의 일상적 git 사용)에서 이 조건이 얼마나 자주 성립하는지, 즉 실제 발생 빈도나 확률은 이 조사로 말할 수 없다.**

## 3. 메커니즘 — 한 문장

**`repoRoot()`(`git rev-parse --show-toplevel`)로 실제 저장소를 가리키는 "실행 전/후 `git status --porcelain`·`git diff HEAD --stat` 스냅샷이 그대로인가"를 확인하는 동일한 안전망 코드가 다수의 시험 파일에 개별 복붙돼 있고, 이 코드는 "그 체크아웃을 다른 무엇도 건드리지 않는다"는 배타적 소유를 가정하므로, 같은 체크아웃 안에서 다른 프로세스(다른 시험 인스턴스든, 임의의 git 명령이든, 사람의 편집이든)가 `git status` 계열 명령·파일 생성삭제·추적파일 수정·브랜치 이동 중 하나만 해도 그 스냅샷 창 사이에 걸리면 즉시 깨진다.**

## 4. 모집단 — 명령과 출력 그대로

이슈 원문(HYK-206)이 준 8개 목록:

```
envelope-archive.test.mjs
envelope-archive-mutation.test.mjs
hyk183-ledger-fix-mutation.test.mjs
nc-reject-streak.test.mjs
reject-streak.test.mjs
reject-streak-auto-record.test.mjs
research-receipt.test.mjs
review-gate-auto-record.test.mjs
```

내가 쓴 축(정확한 어서션 문구):

```
$ grep -rl "must leave the real worktree exactly as it found it" scripts/check scripts/relay scripts/supervisor --include=*.test.mjs | wc -l
33
```

ORCH가 독립적으로 쓴 축(호출 인자 문자열):

```
$ grep -rln 'status", "--porcelain' scripts/ --include=*.test.mjs | wc -l
35
```

두 축의 차집합:

```
$ comm -23 <(sort orch_axis.txt) <(sort my_axis.txt)
scripts/relay/adapters/teardown-inventory-adapter.test.mjs
scripts/supervisor/unconsumed-core.test.mjs
```

개별 확인 결과:

- `teardown-inventory-adapter.test.mjs`: ORCH 축(35)에는 있으나 실제로는 **`git status --porcelain`을 실행하지 않는다** — `assert.deepEqual(gitStatus, ["status", "--porcelain"])`로 커맨드-빌더 함수가 그 배열을 반환하는지만 검사하는 순수 단위 시험이다(mock, 실제 저장소 무접촉). **ORCH 축의 false positive.**
- `unconsumed-core.test.mjs`: 내 축(정확한 문구 매칭)에는 안 잡혔지만, 실제로는 같은 패턴의 `before`/`after` 스냅샷을 쓴다 — 문구만 다르다(`"unconsumed-core.test.mjs must not leave repository working-tree changes behind"`). **내 축의 false negative(문구 불일치로 인한 누락).**

⇒ **실제 모집단은 34개**(ORCH의 35 − false positive 1). 이슈의 8개 중 이 34개 축과 겹치는 것은 **3개**(`nc-reject-streak.test.mjs`, `reject-streak-auto-record.test.mjs`, `review-gate-auto-record.test.mjs`) — 나머지 5개(`envelope-archive(-mutation)`, `hyk183-ledger-fix-mutation`, `reject-streak`, `research-receipt`)는 34개 축 어디에도 없다(각 파일 머리 주석대로 `mkdtemp` 샌드박스 안에서만 논다).

### 검토(REVIEW)의 독립 3분해 — 제3의 축

REVIEW(2R 반려 보고서)는 주석·mock 문자열이 아니라 **실제 실행문** `const preStatus = execFileSync("git", ["status", "--porcelain"]`로 세 번째 독립 축을 세웠다. 이 라운드에서 같은 명령으로 재확인했다:

```
$ grep -rl 'const preStatus = execFileSync("git", \["status", "--porcelain"\]' scripts --include=*.test.mjs | wc -l
34
```

그리고 이 34개가 `ROOT`(스냅샷 대상 경로)를 어떻게 만드는지 세 갈래로 갈라진다:

```
$ grep -rl "^const ROOT = repoRoot();" scripts --include=*.test.mjs | wc -l
35   # 34개 population(preStatus 실행문 보유) 안에서는 31, 밖의 4개
     # (report-style-guard, orch-progress-core, pledge-derive-core,
     #  watch-run-reach)는 ROOT를 preStatus 스냅샷이 아닌 다른 용도로 쓴다

$ grep -rl "^const ROOT = absoluteRealPath(process.cwd(), repoRoot());" scripts --include=*.test.mjs
scripts/check/nc-githook-install.test.mjs
scripts/check/nc-gitleaks.test.mjs

$ grep -rl 'const preStatus = execFileSync("git", \["status", "--porcelain"\]' scripts --include=*.test.mjs \
  | xargs grep -L "function repoRoot"
scripts/relay/adapters/terminal-show-adapter.test.mjs
```

⇒ **31(`repoRoot()` 직접) + 2(`absoluteRealPath(process.cwd(), repoRoot())`, `nc-gitleaks`·`nc-githook-install`) + 1(직접 `execFileSync("git", ["rev-parse", "--show-toplevel"])`, `terminal-show-adapter`) = 34** — REVIEW의 분해와 일치한다. 이 문서의 이전 판(1R)은 "31개는 순수 안전망 상용구"라고만 적어 이 세 경로 차이를 놓쳤다.

## 5. ★처방이 원래 사고를 못 막는다 — 이 조사의 핵심 결론

토폴로지 C를 락(lock) 기반으로 격리하는 방안(34개 파일의 `repoRoot()` 상용구를 공용 헬퍼로 뽑고, 그 헬퍼가 스냅샷 창 진입 전 저장소 단위 락을 잡게 하는 것)을 검토했다.

- 이 락은 **이 34개 시험끼리는** 서로 스냅샷 창이 안 겹치게 보장할 수 있다.
- 그러나 **원래 사고의 서술**(STATUS §1, 2026-08-08 17:25 ORCH 행 원문)은: _"측정 오염 — 내 대조가 fail 8을 냈으나 검토 좌석의 동시 시험과 경합"_ 이고, 그 시각 **ORCH 자신이 메인 체크아웃에서 `git status`·`git log`·`git fetch`를 수시로 돌리고 있었다**(가설, ORCH가 사실로 쓰지 말라고 명시). ORCH의 그 임의 git 명령들은 **이 락을 잡지 않는다** — 락은 34개 시험 코드 안에서만 협조하는 상호배제이지, 저장소에 접근하는 임의의 외부 프로세스(사람의 `git status`, ORCH의 애드혹 명령, 다른 도구)를 강제로 참여시킬 방법이 없다.
- **⇒ 34개 파일을 전부 고쳐 락을 심어도, "ORCH가 메인 체크아웃에서 임의의 git 명령을 돌리는 동안 그 체크아웃에서 시험이 도는" 원래 사고 시나리오는 그대로 재발한다.**

**단, 이 결론은 "락으로는 못 막는다"는 좁은 범위다 — "어떤 방법으로도 못 막는다"가 아니다.** REVIEW가 반례 부류를 확인했다:

- **OS ACL·read-only mount·실행 샌드박스**는 외부 쓰기를 물리적으로 거부하거나, clone/COW(copy-on-write) 사본으로 돌려 스냅샷 창 자체를 없앨 수 있다.
- **`git` wrapper/supervisor**로 모든 git 명령을 단일 경로로 강제하는 설계도 가능하다(⚠️현재 이 저장소에는 구현돼 있지 않다 — REVIEW가 `scripts/check`·`scripts/relay`·`scripts/supervisor`·`hooks`·`.github`를 검색한 범위에서 저장소 단위 락·filesystem watcher·read-only mount/ACL 강제가 없고, `scripts/relay/arm-state.mjs`의 mutex는 다른 arm 상태 저장소용이라 이 34개 스냅샷 경로를 감싸지 않는다).
- **못 하는 것도 명확히**: git hook은 `status`/`diff`와 일반 파일 편집 전부를 가로채지 못한다. watcher는 변경을 관찰해 시험을 중단시킬 수는 있어도, 스냅샷과 변경 사이를 원자적으로 보호하지는 못한다.
- **provenance(출처 구별) 문제**: 최종 `git status`만으로는 "시험이 낸 변경"과 "외부 변경"을 구별할 수 없다. 시험별 예상 변경 journal·소유 token, OS 감사 로그, 또는 매 실행 전용 clone이면 구별 범위를 넓힐 수 있으나, 이 문서나 현재 34개 파일에는 그런 기전이 없다. 동일 파일에 동일 바이트를 쓰는 외부 프로세스까지 최종 상태만으로 구별하는 방법은 확인한 범위에서 없다.

## 6. 선택지와 블라스트 반경 (⛔ 여기서 고르지 않는다 — 한용 판단 사항)

- **34개 파일 락 리팩터**: 공용 헬퍼 모듈 신설 + 34개 파일 수정. 시험끼리의 충돌은 막지만 위 §5에 따라 원래 사고는 못 막는다. 블라스트 반경 = 시험 코드 34개 + 신규 공용 모듈 1개.
- **러너가 항상 격리된 사본에서 돌게 만들기**(CI/개발 워크플로우 차원에서 "실제 저장소" 대신 매 실행마다 새 clone을 만들어 그 안에서 전 스위트를 돌리게 강제): 시험 판정 내용은 안 바뀌지만("그 clone이 실행 전후 그대로인가"는 여전히 실제 유의미한 검사다), 러너/CI 스크립트 변경이 필요하고 로컬 개발 편의성과 트레이드오프가 있다.
- **범위 축소**(이슈가 서술한 "8개 공용 원장 경합"이라는 좁은 axis를 접고, "실제 저장소를 건드리는 34개 시험은 원래부터 단일 actor 전제"라는 운영 규율만 명시적으로 문서화하고 끝냄): 코드 변경 없음, 하지만 §5의 근본 원인은 그대로 남는다.
- **새 이슈로 분리**(이 34개의 스냅샷 안전망을 "동시성 안전"으로 재설계하는 별도 트랙을 새로 연다): 범위가 이 이슈(HYK-206)의 원래 서술을 넘는다.
- **OS ACL/read-only mount·실행 샌드박스**(러너가 그 체크아웃을 읽기 전용으로 마운트하거나 COW 사본에서 돌게 만들어 스냅샷 창 자체를 없앰): 34개 파일도 락도 안 건드리지만, 러너/CI 인프라 계층의 변경이 필요하고 이 저장소에 그런 인프라가 있는지부터 확인해야 한다. 블라스트 반경 = 시험 코드 0 + 러너/인프라 설정.
- **`git` wrapper/supervisor**(모든 git 명령을 단일 감시 경로로 강제): 이론상 가능하지만 현재 이 저장소에 그런 설계가 없고(§5), git hook이 `status`/`diff`·일반 파일 편집까지 전부 가로채지 못한다는 근본 한계가 있어 완전한 강제는 어렵다. 블라스트 반경 = 개발 워크플로우 전체(모든 git 사용을 wrapper 경유로 바꿔야 함) — 위 선택지들보다 크다.

## 7. 목록 밖 관측 1건 — 미확인 (처리 ⓑ)

REVIEW가 토폴로지 C 재현 중 1회 관측한 것: _"C 실행에서 Node summary가 `fail 29`를 출력했는데 프로세스 종료코드는 0이었다"_(REVIEW 원문). 이것이 사실이면 "종료코드만 보는 판정은 CI를 포함해 전부 헛통과할 수 있다"는 중대한 함의가 있어, 이 라운드에서 재현을 시도했다.

ORCH가 독립 탐침 3종(bash 단일파일, PowerShell+리다이렉트, bash 최상위 `after()` 훅 실패)으로 시도했으나 **셋 다 종료코드 1**로 재현 안 됐다(ORCH 원문, 이 라운드 CODER task `.harness/coder-task.md` §2(3) 참조). 이번 라운드에서 나도 두 조건으로 다시 시도했다:

```
시도 1: 단일 clone + C-1(status/diff)·C-2(untracked)·C-3(tracked 수정/원복)·C-4(fetch+branch checkout) 병행, 54회
  SUITE_EXIT_CODE=1
  ℹ tests 3492 / ℹ pass 3477 / ℹ fail 9 / ℹ skipped 6

시도 2: 단일 clone + C-1·C-2·C-3만(REVIEW가 실제 쓴 조합, C-4 제외), 126회
  SUITE_EXIT_CODE=1
  ℹ tests 3509 / ℹ pass 3475 / ℹ fail 28 / ℹ skipped 6
```

**⇒ 재현 안 됨.** ORCH의 3종 탐침 + 이 라운드의 2종 시도(총 5개 독립 시도) 모두 종료코드 1이었다. **처리 = ⓑ**: 이 관측은 "사실"로 적지 않는다 — **"REVIEW가 1회 관측했으나, ORCH·CODER 합쳐 5개 독립 시도에서 재현되지 않았고 원인 미상"**으로만 남긴다. "CI가 위험하다" 류의 확대 해석은 하지 않는다.

## 8. 정직 한계

- **재현이 확률적일 가능성** — 음성(A/B) 6라운드, 양성(C) 3라운드는 모두 통계적으로 약한 표본이다. 사고가 원래 1회 관측이었던 것에 비하면 상대적으로 튼튼하지만, 완전한 반증/확증은 아니다.
- **`tests` 총계가 토폴로지 C에서 라운드마다·기준값과도 다른 이유를 조사하지 않았다.**
- **모집단 축 불일치**: 내 축(정확 문구, 33) vs ORCH 축(호출 인자, 35) vs 실제(34, 개별 확인 후) — 자동화된 단일 grep으로는 이 모집단을 정확히 잡을 수 없다는 뜻이다(문구가 파일마다 조금씩 다르고, 일부는 mock이라 false positive다). 이 문서에 적은 34는 **수동으로 두 축의 차집합만 개별 확인**한 결과이며, 34개 전부를 하나하나 육안 검증하지는 않았다.
- **"메인 체크아웃"이 정확히 무엇을 가리키는지 원문으로 확인하지 못했다** — `git worktree list` 정황상 `Documents\HARNESSENGINEERING`으로 짐작했을 뿐, 그 경로에서 직접 실행해 확인하는 것은 작업 지시(CODER task §3)로 금지돼 있었다.
- **fail 8의 실패 시험 이름은 끝내 못 구했다** — ORCH도 관제실 아카이브를 전부 뒤졌지만 남아있지 않다고 확인했다(§QUESTION 1차 답변). 이 문서의 §2 재현은 그 이름들과 다시 대조할 방법이 없다.
