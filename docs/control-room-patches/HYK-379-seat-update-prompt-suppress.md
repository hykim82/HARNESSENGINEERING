# HYK-379 패치 문서 — 좌석 런처가 codex/claude 자동 업데이트 프롬프트를 원천에서 끈다

**앵커를 자른 원본** = `D:\문서관리\하네스-관제실\orca-worker-seat.ps1` · **SHA-256 `14e8a6ef50b988e06d19cfa5426d7529e5813571688e4b35c261fd4770af423c`**(CODER 직접 `Get-FileHash` 실측 · 2026-08-29) · **36줄**(`Get-Content .Count` 실측) · CRLF(관제실 ps1 관행) · fixture 사본은 `scripts/check/fixtures/control-room-orca-worker-seat-2026-08-29-hyk379-update-suppress-before.ps1.txt`(SHA-256 동일값으로 재확인됨).
**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본 사본> --out <출력>`(⛔이 도구는 실제 관제실 경로를 절대 쓰지 않는다 — `--source`/`--out` 만 쓴다, 둘 다 파일이다. 라이브 적용은 사람/ORCH 몫 · S7 검토 대상).

## 1. 무엇을 세우는가 (불변식 P의 ⓐ, 원천 억제)

HYK-379 원 사고(coder-task.md §1): ORCH REVIEW 좌석(codex)이 기동 직후 codex 자체의 자동 업데이트 확인 프롬프트(`Update now` / `Skip until next version`)를 만났고, 숫자 선택 전송이 막힌 뒤 Enter만 보내 기본값(`Update now`)이 실행돼 `npm install -g @openai/codex`가 돌고 좌석이 죽었다.

**실측 근거(이 CODER가 이 기계에서 직접 확인, 좌석 조작 0 — §0-1 준수, `codex doctor`는 orca를 호출하지 않는 읽기 전용 진단 명령이다):**

| 축                                                        | 실측                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex doctor --all` 기본값                               | `startup update check     true`                                                                                                                                                                                                    |
| `codex doctor --all -c check_for_update_on_startup=false` | `startup update check     false` (같은 실행에서 다른 필드는 불변 — 이 키 하나가 그 값을 뒤집는다는 것을 그 자리에서 확인)                                                                                                          |
| 바이너리 문자열 대조                                      | `codex.exe`(로컬 설치본, v0.150.1)에 `check_for_update_on_startup` 리터럴이 그대로 존재(추측 아님, `grep -a`로 직접 추출)                                                                                                          |
| 공식 문서/이슈                                            | GitHub `openai/codex` 이슈 #18543 — `check_for_update_on_startup=false`가 안 먹히는 버그는 **데스크톱 앱 타이틀바 한정**이며 "closed as not planned"로 닫혀 있다. **CLI/TUI는 이 버그의 대상이 아니다**(WebFetch로 이슈 본문 확인) |

⇒ **확실**: `codex -c check_for_update_on_startup=false ...`(또는 `~/.codex/config.toml`의 `check_for_update_on_startup = false`)로 codex CLI/TUI의 시작 시 업데이트 확인 자체를 끌 수 있다 — 확인이 없으면 확인 결과를 보여주는 프롬프트도 뜨지 않는다(코드 경로상 당연한 함의이지 별도로 "프롬프트 자체가 안 뜬다"까지 라이브 좌석에서 재현하지는 않았다 — §0-1 좌석 미조작 원칙, 아래 §4 정직 한계 참조).

**claude(CODER/VERIFY 엔진)도 동일 계열 위험이 있는가**: `claude-code-win32-x64` 바이너리 문자열에 `DISABLE_AUTOUPDATER` 리터럴이 존재(직접 `grep -a` 확인). 공식 문서(`code.claude.com/docs/en/env-vars`) 색인은 확인했으나 해당 페이지 발췌가 truncated돼 이 변수의 정확한 문면은 이 라운드에서 **미확인**(추론: GitHub 이슈 토론 다수가 "`DISABLE_AUTOUPDATER=1`이 백그라운드 자동 업데이트를 끈다"는 취지로 일관되게 언급 — 확정 문서 근거는 아니다). ★단, claude는 codex와 달리 "대화형 메뉴(1/2/3 선택) → Enter 시 기본값 실행"이라는 **이 사고의 구체적 형태**(코더-task.md 원문)를 이 조사에서 발견하지 못했다 — claude의 업데이트는 알려진 자료상 백그라운드/침묵 방식이다. 그래서 이 패치는 claude 쪽에 **방어적으로만**(대화형 트랩 자체를 막는 것이 아니라 백그라운드 업데이트가 좌석 도중 끼어들 여지를 줄이는 차원으로) `DISABLE_AUTOUPDATER=1`을 얹는다 — 이것이 원 사고를 재현하지 않았다는 점은 §4에 명시한다.

## 2. 불변식

> **P-ⓐ**: 좌석 런처가 codex/claude를 기동하는 시점에 **업데이트 확인 자체가 요청되지 않는다** — 확인이 없으므로 확인 결과를 묻는 대화형 프롬프트도 발생 구조가 없다.

## 3. 패치 단위 (기계 추출 대상)

```control-room-patch-unit
id: hyk379-codex-update-check-off
mode: replace
@@ANCHOR@@
  codex --model $codexModel -a never -s danger-full-access
@@CONTENT@@
  # HYK-379: codex 자체 업데이트 확인을 시작 시점에 끈다 -- 확인이 없으면
  # "Update now/Skip" 대화형 프롬프트도 뜨지 않는다(원 사고: 이 프롬프트에서
  # 숫자 선택 전송이 막히고 Enter만 먹혀 기본값 Update now가 조용히 실행됐다).
  codex --model $codexModel -a never -s danger-full-access -c check_for_update_on_startup=false
@@END@@
```

```control-room-patch-unit
id: hyk379-claude-autoupdater-off
mode: insert_after
@@ANCHOR@@
  $env:CLAUDE_CONFIG_DIR = "C:\Users\Administrator\.claude-team"
@@CONTENT@@

  # HYK-379: claude 쪽 방어적 조치 -- codex와 같은 "대화형 선택 프롬프트" 형태의
  # 사고 재현은 이 조사에서 확인되지 않았지만(§4 정직 한계), 백그라운드
  # 자동 업데이트가 무인 좌석 도중 끼어드는 경로 자체를 줄인다.
  $env:DISABLE_AUTOUPDATER = '1'
@@END@@
```

## 4. ⚠️정직 — 이 패치가 «못» 하는 것

- **라이브 좌석에서 "프롬프트가 실제로 안 뜬다"는 재현하지 않았다** — §0-1(살아 있는 좌석에 손대지 마라)를 지키기 위해 이 CODER는 `codex doctor`(읽기 전용 진단, orca 미호출)로만 설정값 반전을 확인했다. "업데이트가 있다고 codex가 실제로 판단하는 상황을 인위로 만들어 좌석을 띄우고 프롬프트 유무를 관찰"하는 것은 살아 있는 좌석 조작에 해당해 이 라운드 범위 밖이다 — 필요하면 §0-1 규정대로 ORCH에 요청해야 한다.
- **claude 쪽은 원 사고의 정확한 형태(대화형 메뉴 트랩)를 확인하지 못했다** — `DISABLE_AUTOUPDATER=1`은 사전예방적 방어이지, 이 이슈가 지적한 "선택지가 좁아 기본값을 누르는 것 외엔 방법이 없었다"는 실패 모드 자체를 claude에서 실측 재현하고 막은 것이 아니다.
- **codex 실제 업데이트 유무 판정 로직 자체를 바꾸지 않는다** — 이 패치는 "확인을 하지 말라"고만 지시할 뿐, 확인이 이미 진행 중이거나(경쟁 상태) 다른 경로(예: 데스크톱 앱)로 업데이트가 트리거되는 경로는 다루지 않는다(범위 밖 — coder-task.md §5 HYK-271 본체와 마찬가지로 이 조각의 대상이 아니다).
- **불변식 P의 ⓑ(막히면 시끄럽게)는 이 문서가 세우지 않는다** — 그 축은 Q2 조사 결과(아래 `.harness/coder.md`)에 따로 정리했다.

## 5. 적용 절차

1. `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <라이브 사본> --out <적용본>` — ⛔라이브 파일에 직접 쓰지 않는다.
2. **적용본 diff를 눈으로 확인** → 라이브 교체 → 합성 표적으로 1회 구동해 확인(⛔실제 배달로 시험하지 않는다).
3. 되돌림 = 원본 SHA-256 사본 보관(위 §헤더의 해시).
