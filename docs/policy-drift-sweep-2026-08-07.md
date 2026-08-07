# 저장소 정책 드리프트 전수 점검 — 2026-08-07 (HYK-194-sweep, 1R+2R+3R)

## 1. 한 줄 요지

⚠️**두 숫자는 서로 다른 것을 센다(4R 정정 -- 이 혼동이 3R 반려 사유였다)**:
**"확실한 드리프트"** = §3 표에서 A와 B로 분류된 행(고쳤든 안 고쳤든
"낡았다"고 확정한 것) 전부 = **9건**(A 7 + B 2). **"A로 고친 것"** =
그중 판단 불요라 이번에 실제로 고친 것 = **7건**. 아래는 그 A 7건의
목록이다(집는 방식 = §6 참조, 손으로 세지 않았다):

**A 7건 전부 고쳤다.** (1R)
`escalation-state.mjs`의 "사람 게이트 6개"→"일곱" · (2R-P1-1) **그 1R
수정 자체가 "일곱"이라며 여덟을 나열하던 결함, 수리** · (2R-P1-2) 영문
`claude-orchestrator-handoff.md`의 "Six human gates"가 1R 검색에서
빠졌던 것, 수리 · (3R-P2-1) **2R의 §6-b 실연 자신이 파일을 안 읽는
무효 증거였던 결함, 수리**(readFileSync로 교체) · (3R-P2-2) 2R이 고친
자리에 남아 있던 "정확히 7개가 나온다"는 자기 신고성 한 문장 삭제(표기
이유 설명은 보존) · (3R-P2-4, **검토자 독립 발견**) `requery-join-core.mjs`의
"판정 다섯 개"가 실측 6개였던 것, 수리 · (3R, **ORCH 추가·검토자 목록
밖**) 영문 게이트 4에서 정본의 "병합(merge)"이 빠져 있던 것, 수리.
**B(이슈등재) 2건은 1R·2R·3R·4R 모두 무접촉**: `admission-core.mjs` 6/7/8
불일치 · `GLOBAL_HARD_CAP=2`(서명된 addendum과 충돌). **2R이 「N개+목록」
형태를 게이트 키워드에 묶이지 않고 재훑어(§4) 9곳을 표본 대조했고
(전부 일치, 새 드리프트 0건), 3R에서 그 한계 서술 자체(§5-(g))의 숫자를
재실측으로 정정**(69건·최대 덩어리는 `enforcement-known-gaps.md` 22건).
C(서명 사안) 분류는 이번까지 발견 0건이다.

**라운드별 델타**: 1R 행(행 1)은 원문 보존. 2R이 **행 2·3**(P1-1 자인,
P1-2)을 추가했다. 3R이 **행 15·16·17**(P2-1 자인, P2-4 검토자 발견,
ORCH 추가 게이트4 병합)을 추가하고 **§6-b를 통째로 교체**(파일을 읽지
않던 2R 버전 폐기) · **§5-(g)의 숫자를 재실측으로 정정** · **§6-f~h를
신규 추가**(requery-join Standing-B 실연 · quality-check 공허 초록
실증 + 우회 증거 · 전 스위트/무접촉 재확인)했다. **4R이 행 18**(3R-P2-2를
행 2에서 분리한 것)을 추가하고 위 두 숫자(드리프트 9 · A 7)를 기계로
재검산해 §1·표·산문 열거가 서로 일치하게 맞췄다(§6 참조) — **이 문서
자신이 그 계열의 네 번째 재발이었다는 것도 §5에 기록했다.**

## 2. 모집단과 세는 방법 (S10)

**대상 = coder-task.md §4가 지정한 4개 표면**: `docs/**/*.md`(계약 문서) · 코드 주석·시험 이름/서술(`scripts/**/*.mjs`) · `scripts/check/enforcement-inventory.json` 계열 · `.github/workflows/**`(CI 워크플로 문구).

**«전부 봤다»가 아니라 다음 명령들로 걸러 본 것이다** — Standing-A 요구대로 정확히 무엇을 어떻게 돌렸는지 그대로 적는다:

1. **모집단 확정**:
   - `find docs -name "*.md"` → **16개** (`docs/*.md`, 목록 §5-a 참조).
   - `.github/workflows/` 내 파일 전부.
   - `scripts/check/enforcement-inventory.json` 1개(694줄).
   - `scripts/**/*.mjs`(코드 주석) + `scripts/**/*.test.mjs`(시험 이름/서술) — Grep 도구로 패턴 매칭, 전체 파일 수는 세지 않았다(⚠️ §5-e "못 본 표면" 참조 — 이 부분이 완전 열거가 아니라 **키워드 히트 기반**이라는 한계가 있다).

2. **드리프트 후보를 찾는 데 실제로 돌린 검색 패턴**(전부 ripgrep 기반 Grep 도구, 대상 = 저장소 루트):
   - `게이트\s*(다섯|여섯|5개|6개)|사람\s*게이트\s*[0-9]|정지\s*목록.*[0-9]개|닫힌\s*목록`
   - `게이트\s*\d|사람\s*개입.*\d개|정지.*\d개` (scripts/ 전체)
   - `N\s*≤\s*2|N<=2|고정.*동시|동시.*고정` (전체)
   - `N\s*[≤<=]\s*2|동시\s*실행.*2개|최대\s*2개.*동시|동시성.*2\b` (전체)
   - `GLOBAL_HARD_CAP` (전체 — 상수 참조처 전수 확인용)
   - `통역` (docs/, scripts/ — 구 역할명 잔존 확인)
   - `자동\s*병합|AI.*병합.*가능|AI가\s*병합` (전체)
   - `여섯\s*(지점|곳|개)|6\s*(지점|곳)` (전체)
   - `게이트` (docs/ 전체 — 위 숫자 패턴에 안 걸리는 문맥형 서술까지 수동 확인)
   - `동시.*(최대|상한|고정).*[0-9]|최대\s*[0-9]+\s*(개|건).*동시|hard.?cap` (docs/, 대소문자 무시)
   - `게이트|concurrency|hard.?cap|N≤|human gate` (`.github/workflows/`)

3. **북극성 정본 대조**: `D:\문서관리\하네스-관제실\북극성-좌표.md`(읽기 전용, §3 요구대로)를 직접 읽어 §1-C ㄱ의 **닫힌 목록 일곱**(원문 그대로 인용 가능)을 확보하고, 이 문서 자체가 "**낡은 6개 목록**"을 §C에 취소선 없이 병기해 둔 것을 확인했다 — 그 병기된 옛 목록의 항목 순서·괄호 표기가 `escalation-state.mjs`의 서술과 **정확히 1:1로 일치**해, 아래 A1이 "판단 불요·문구 치환만"임을 정본으로 확인했다.

4. **서명 패킷 확인**(GLOBAL_HARD_CAP 관련, 읽기 전용): `PKT-20260807-SUPERVISOR-CONCURRENCY-ADDENDUM-V1`을 관제실에서 찾아 전문을 읽었다(`grep -rl` 로 위치 확인 후 `cat`).

5. **2R — 「게이트」 키워드에 묶이지 않는 「N개+목록」 형태 재훑기**(coder-task.md §4 요구): 1R 검색이 전부 `게이트`라는 단어를 포함했다는 자기 반성에서, 이번엔 그 단어 없이 **"숫자 + 그 옆의 이름 나열"이라는 형태 자체**를 노렸다. 실제로 돌린 패턴(전부 ripgrep Grep 도구, 대상 = `docs/`+`scripts/**/*.{mjs,md}`, `\d+(개|종|가지|건|축|항목)\(` 형태로 "숫자+단위+여는 괄호"만 잡아 오탐을 줄였다):
   - `\d+(개|종|가지|건|축|항목)\(` — 숫자 다음에 단위 명사가 오고 바로 괄호(나열)가 뒤따르는 자리(약 60건 히트).
   - `\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(human\s+)?(gates|roles|steps|checks|stop|stops|points|conditions|states)\b` (docs/, 대소문자 무시) — 영문 수사+정책성 명사.
   - `여덟|eight\s+(gates|steps|roles)` (전체) — "다음 오탈"(6→7 고쳤는데 8이 되는 재발)을 특정해 선제 확인.
   - `\bsix\b|\bSix\b` (docs/) — P1-2 패턴과 같은 계열이 다른 문서에 더 있는지.
   - `게이트`(docs/ 전체, 문맥형 서술까지 수동 확인 — 1R 에서 이미 돌렸던 것 유지).
     위 60여 건 중 **"정책/거버넌스성 닫힌 목록"으로 보이는 자리 9곳을 표본 대조**했다(나머지는 시험 표본 수·mutation 건수·API 필드 수 같은 **로컬 회계성 숫자**로 판단해 이번 라운드에서는 개별 검증하지 않음 — §5 한계 (g) 참조, 무엇을 왜 뺐는지 명시). 대조 결과는 §3 표 하단 행에 전부 실었다 — **9곳 전부 «적힌 수 = 실제 항목 수» 일치**, 새 드리프트 0건.

## 3. 표: 발견 목록

| #   | 라운드                            | 파일:줄                                                                                                                                                                       | 무엇이 낡았나                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 분류                                               | 조치                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 1R                                | `scripts/relay/escalation-state.mjs:257-261, 270-272`                                                                                                                         | 주석 "사람 게이트 6개(이슈경계·reject 2연속·되돌리기 비용 큰 실행·PR/Done·패킷 서명·하드스톱)" — 북극성-좌표.md §1-C가 2026-08-07 확정한 **닫힌 목록 일곱**(작업 선택·연속반려·북극성/큰 실행 승인·PR/Done·서명·하드스톱·**상신 답변**)보다 "상신 답변" 게이트 1개가 빠진 옛 목록. 정본 문서 자신이 이 정확한 옛 목록을 "낡았다"고 명시.                                                                                                                                                          | **A**                                              | **1R 이 고쳤다** — "사람 게이트 일곱 개(…)"로 치환. ⚠️**그러나 이 치환 자체가 아래 행 2 의 새 결함을 냈다** — 자인.                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | **2R(P1-1, 자인)**                | `scripts/relay/escalation-state.mjs:257-267`                                                                                                                                  | ★**1R 이 고친 바로 그 자리에서 새로 만든 결함.** 1R 주석이 "사람 게이트 **일곱** 개(…)"라고 썼는데, 괄호 목록을 그 목록 자신의 구분자 `·`로 쪼개면 **여덟**이 나왔다 — 정본 게이트 4 이름 `PR 승인·병합 / Linear Done`을 그대로 옮겨 적어 그 이름 안의 `·`가 바깥 구분자와 충돌(게이트 3은 이미 `북극성/큰 실행 승인`으로 같은 충돌을 피했는데, 게이트 4에서만 빠뜨렸다). REVIEW 실물 재현으로 발견(1R 반려 P1-1).                                                                                | **A**                                              | **2R이 고쳤다** — 게이트 3·4 내부 `·`를 `/`로 바꿔 목록·개수를 일치시켰다. **이 행이 2R에서 새로 만든 후속 결함(주장 문장 하나)은 행 18(3R-P2-2)에서 별도로 다룬다** — 같은 파일이지만 별개 검토 지적이라 행을 분리했다(§6 판단 근거 참조). 실행 코드(`HUMAN_WAKE_STATES`/`shouldWakeHuman`) `git diff` 0줄.                                                                                                                                                                               |
| 3   | **2R(P1-2, 1R 누락)**             | `docs/claude-orchestrator-handoff.md:305-308`                                                                                                                                 | 행 1과 **항목·순서까지 1:1 대응하는 옛 6-게이트 목록이 영문으로 그대로 남아 있었다**("Six human gates are the only stop points": ①~⑥, 게이트 7 없음). 이 파일은 1R 이 선언한 모집단(`docs/**/*.md`) 안인데 1R 검색이 한국어 "게이트" 키워드에 묶여 있어 놓쳤다(REVIEW 가 1R 이 안 쓴 키워드로 독립 검색해 재현).                                                                                                                                                                                  | **A**                                              | **고쳤다** — "Seven human gates …" + ⑦(human reply to an escalation)로 갱신. ⚠️서식(`①②③…`)은 지시대로 유지, 개수·항목만 교체. 검증 출력은 §6 참조.                                                                                                                                                                                                                                                                                                                                        |
| 4   | 1R(2R 재확인)                     | `scripts/relay/admission-core.mjs:168`                                                                                                                                        | 주석 "거부(정지) 게이트 **6종**"인데 바로 아래 `checkDenyGates`가 실제로 체이닝하는 함수는 **8개**(`checkStoreCorrupt`·`checkUnknownAuthority`·`checkHardStop`·`checkDangerousExecution`·`checkNewIssueBoundary`·`checkRejectStreak`·`checkNorthStar`·`checkPacketScope`). 파일 상단 §3 매핑 원문 표(줄 22-24)도 거부 사유를 **7개**만 나열하고 `checkDangerousExecution`(위험 실행)을 별도 항목으로 적지 않는다 — 6/7/8 세 숫자가 한 파일 안에서 서로 다르다.                                    | **B**                                              | ⛔**1R·2R 모두 무접촉.** "위험 실행"이 "하드스톱"과 개념상 같은 게이트인지 별도 게이트인지(그래서 정답이 7인지 8인지), §3 매핑 표 자체를 다시 써야 하는지는 이 코드의 설계 의도를 아는 사람의 판단이 필요하다 — 문구만 바꿔서 끝날 문제가 아니다.                                                                                                                                                                                                                                          |
| 5   | 1R(2R 재확인)                     | `scripts/supervisor/concurrency-core.mjs:47,101,115` + `scripts/supervisor/concurrency-core.test.mjs:511,530` (+ 언급만: `docs/enforcement-known-gaps.md:316`, 건드리지 않음) | `GLOBAL_HARD_CAP = 2` 코드 상수 — 2026-08-07 03:06 한용이 서명한 `PKT-20260807-SUPERVISOR-CONCURRENCY-ADDENDUM-V1`이 "상한을 코드 상수로 박아 두면 게이트 S-5 미충족(값의 출처가 한용이어야 한다)"로 원 패킷 문구를 개정했다.                                                                                                                                                                                                                                                                     | **B**(coder-task.md §5-1에서 이미 ORCH가 B로 지정) | ⛔**1R·2R 모두 무접촉.** §4 참조 — 값을 어디서 읽을지(설정 파일/환경변수/관제실 파일 등)가 정해지지 않았고, 서명된 addendum 자신도 "그 메커니즘은 아직 기계가 아니다"를 정직한 한계로 명시한다.                                                                                                                                                                                                                                                                                            |
| 6   | 2R(§4 표본 확인)                  | `scripts/relay/adapters/teardown-inventory-adapter.mjs:68-70`                                                                                                                 | "실 필드는 정확히 12개(`branch, connected, handle, lastOutputAt, leafId, preview, ptyId, tabId, title, worktreeId, worktreePath, writable`)" — 쉼표로 센 항목 수를 실제로 세어 대조.                                                                                                                                                                                                                                                                                                              | **확인함(드리프트 없음)**                          | 무접촉 — `node -e` 로 배열 길이 계산, 12 = 12 일치(§6 로그).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 7   | 2R(§4 표본 확인)                  | `scripts/relay/adapters/terminal-show-adapter.test.mjs:8`                                                                                                                     | "거부 경로 4종(NOT_OK/NO_TERMINAL_ENVELOPE/FIELDS_INCOMPLETE/FALLBACK_FORM)"                                                                                                                                                                                                                                                                                                                                                                                                                      | **확인함(드리프트 없음)**                          | 무접촉 — 슬래시로 쪼갠 항목 수 4 = 4 일치.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8   | 2R(§4 표본 확인)                  | `scripts/supervisor/seat-liveness-wire.test.mjs:583` + `:739`                                                                                                                 | "필수 mutation 6종"(파일 전체) vs 하위 절 "seat-scan 필수 mutation 3종" — 두 숫자가 서로 다른 범위(전체/부분)를 가리키는지 확인 필요.                                                                                                                                                                                                                                                                                                                                                             | **확인함(드리프트 없음)**                          | 무접촉 — `grep -n 'test("NC mutation'` 로 전수 세어 파일 전체 6개(seat-wire #1-3 + seat-scan #1-3), 하위 절 3개(seat-scan #1-3) 모두 일치(§6 로그).                                                                                                                                                                                                                                                                                                                                        |
| 9   | 2R(§4 표본 확인)                  | `scripts/relay/seat-identity-core.mjs:53`                                                                                                                                     | "독립 축 3개(ptyId/worktreeId/paneKey)"                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **확인함(드리프트 없음)**                          | 무접촉 — 함수 본문의 `count += 1` 3회와 일치.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10  | 2R(§4 표본 확인)                  | `scripts/supervisor/budget-core.mjs:102`                                                                                                                                      | "KNOWN_STATUS 3종(OK/EXHAUSTED/UNAVAILABLE)"                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **확인함(드리프트 없음)**                          | 무접촉 — 슬래시 3항목과 일치(열거값 자체는 별도 export에서 재확인).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 11  | 2R(§4 표본 확인)                  | `docs/enforcement-v1.md:108`                                                                                                                                                  | "**all** three conditions must hold"(`for:` 검사)                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **확인함(드리프트 없음)**                          | 무접촉 — 문맥상 for:/verdict:approved/role:REVIEW-\* 3개, 정책 게이트 목록과 무관한 별개 개념.                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | 2R(§4 표본 확인)                  | `docs/enforcement-v1.md:2083`                                                                                                                                                 | "seven checks' cases together"(selfcheck-smoke.mjs)                                                                                                                                                                                                                                                                                                                                                                                                                                               | **확인함(드리프트 없음)**                          | 무접촉 — `grep -n "function smoke" scripts/check/selfcheck-smoke.mjs` = 7개 함수, 일치.                                                                                                                                                                                                                                                                                                                                                                                                    |
| 13  | 2R(§4 표본 확인)                  | `docs/enforcement-v1.md` 전체                                                                                                                                                 | "six fields"/"six boundary" (1210·1223·1650줄) · "rejected six times"(2800줄)                                                                                                                                                                                                                                                                                                                                                                                                                     | **확인함(드리프트 없음)**                          | 무접촉 — 게이트 정책과 무관한 별개 도메인(경계 필드 수·과거 사건 회고)임을 문맥으로 확인, 숫자 재검증은 이번 라운드 범위 밖(§5 (g)).                                                                                                                                                                                                                                                                                                                                                       |
| 14  | 2R(§4 표본 확인)                  | 전체(`여덟\|eight\s+(gates\|steps\|roles)`, `\bsix\b\|\bSix\b` in docs/)                                                                                                      | 재발 방지 확인 — "6→7 고쳤는데 8이 되는" 같은 패턴이 다른 곳에 또 있는지, "Six"류 잔존이 더 있는지                                                                                                                                                                                                                                                                                                                                                                                                | **확인함(드리프트 없음)**                          | 무접촉 — `여덟`/`eight gates` 히트 0건. `six`/`Six` 히트는 위 행 13 뿐(정책 무관).                                                                                                                                                                                                                                                                                                                                                                                                         |
| 15  | **3R(P2-1, 자인)**                | `docs/policy-drift-sweep-2026-08-07.md`(구 §6-b, 이 파일 자신)                                                                                                                | ★**이 결과표 자신의 결함.** 2R의 §6-b 실연이 목록 문자열을 **손으로 타이핑**해 `split("·")`한 것이었다 -- `escalation-state.mjs`를 전혀 읽지 않으므로 소스에 무엇이 있든 7을 출력하는, **증거로 무효**인 코드였다(같은 문서의 (c)는 `readFileSync`로 실제 파일을 읽어 대조군이 됨). 블록 제목도 "손으로 센 주장 아님"이라 실제보다 강하게 들렸다. REVIEW가 지적(ORCH도 같은 의심을 먼저 제기).                                                                                                    | **A**                                              | **고쳤다** -- `readFileSync`로 소스를 실제로 읽어 주석에서 목록을 뽑고, 줄바꿈을 잇는 두 가지 방식(공백 없이/공백 1개) 모두 7이 나옴을 보이도록 교체. 제목도 과장 제거. 명령·출력 원문은 §6-b 참조.                                                                                                                                                                                                                                                                                        |
| 16  | **3R(P2-4, 검토자 독립 발견)**    | `scripts/supervisor/requery-join-core.mjs:278-281`                                                                                                                            | ★**검토자가 자기 독립 검색으로 찾은 새 발견**(한글 수사 + 괄호 없음 형태라 2R 정규식 `\d+단위\(`이 구조적으로 못 잡음). 주석 "판정 **다섯** 개를 표로 선언해 이 파일 자체의 분기 복잡도를 낮춘다"인데, `buildStructuralFailureChecks`가 실제로 선언하는 판정은 **6개**(`TERMINAL_NORMALIZED_INVALID`·`DISPATCH_NORMALIZED_INVALID`·`CAPTURE_INCOMPLETE`·`SOURCE_MISMATCH`·`OBSERVED_PANE_KEYS_MISSING`·`EXPECTED_REQUERY_ROUND_INVALID`, 직접 셈 -- §6 로그).                                     | **A**                                              | **고쳤다** -- "6"으로 정정 + 선례 파일(`dispatch-bound-seat-proof.mjs`의 `buildMismatchChecks`, 직접 세어 확인한바 그 파일 자신은 5개, §6 로그)과 숫자가 다르다는 것도 명시해 혼동을 없앴다. **내 판단**: "다섯"이 선례 파일(5개)을 가리키는 독해도 가능하지만, 문장에 "**이 파일 자체의**" 분기 복잡도라고 명시돼 있어 이 파일의 표(6개)를 가리키는 독해가 더 자연스럽다고 보고 6으로 고쳤다 -- 정정 근거를 이 문장 자체에 남겼으니 이후 어느 쪽으로 읽어도 헷갈리지 않는다. 코드 무변경. |
| 17  | **3R(ORCH 추가, 검토자 목록 밖)** | `docs/claude-orchestrator-handoff.md:308`                                                                                                                                     | 영문 게이트 4 "PR approval / Linear Done"에 정본 이름(`북극성-좌표.md` §1-C ㄱ "게이트 4 PR 승인·**병합** / Linear Done")의 **"병합(merge)"이 빠져 있었다**. ⚠️정직: 이건 1R 이전부터 있던 결함이고 2R diff가 만든 게 아니다 -- 검토자가 P2-5(사소)로 "이번 라운드 결함 아님"이라 명시했다. 그런데도 ⓐ선언된 모집단 안이고 ⓑA급(판단 불요)이며 ⓒ이미 같은 줄을 이 브랜치에서 만지고 있어, 지금 안 고치면 "알고도 남긴 낡음"이 커밋에 들어가므로 이번에 닫는다(ORCH 판단, 검토자 목록에는 없었음). | **A**                                              | **고쳤다** -- 정본을 직접 대조해 "PR approval/merge / Linear Done"으로 갱신. 나머지 여섯 항목·`①` 서식·문단 밖은 무변경.                                                                                                                                                                                                                                                                                                                                                                   |
| 18  | **3R(P2-2, 검토자 권고 ⓑ)**       | `scripts/relay/escalation-state.mjs:264-266`                                                                                                                                  | 행 2(2R-P1-1)를 고치면서 2R이 새로 써넣은 "위 목록을 `·`로 쪼개면 정확히 7개가 나온다(…§6 실행 출력 참조)" 문장 — **읽는 사람이 1초 안에 직접 셀 수 있는 값**이라 얻는 정보가 거의 없고, **유지 부채는 영구적**이다(목록이 바뀔 때마다 같이 고쳐야 하고 안 고치면 이 트랙이 계속 잡아 온 "주장≠구현"이 같은 자리에서 재발). 그 주장이 가리키는 근거(§6)가 당시 **파일을 안 읽는 무효 실연**(행 15/P2-1)이었다는 점도 겹쳐, "주장의 근거가 자기 신고를 가리키는" 구조였다.                         | **A**                                              | **고쳤다** -- "정확히 7개가 나온다(…)" 그 한 문장만 삭제. 바로 앞 문장("목록 구분자 `·`가 게이트 3·4 정본 이름 자신에 포함된 `·`와 충돌하지 않도록 `/`로 바꿔 적었다")은 **왜 이렇게 표기했는지**를 설명하므로 보존. `:257`의 "일곱 개(목록)" 서술 자체는 목록·개수가 이미 일치해 손대지 않음. 코드 무변경.                                                                                                                                                                                |

**표에 없는 것 = 못 찾은 것**(§2의 검색 패턴에 걸리지 않은 드리프트가 있을 수 있음, §5 참조). `.github/workflows/`·`enforcement-inventory.json`에서는 위 패턴으로 히트 0건이었다.

## 4. B·C 목록 — 왜 판단이 필요한지

### B — 판단 필요, 이 라운드에서 고치지 않음

**B1. `scripts/relay/admission-core.mjs:168` — 거부 게이트 개수 불일치(6 vs 7 vs 8)**
왜 A가 아닌가: "6종"을 "8종"으로 바꾸는 것 자체는 쉽지만, 그러면 §3 매핑 원문 표(거부 사유 7개 나열)도 같이 고쳐야 앞뒤가 맞는다 — 그 표를 고치려면 `checkDangerousExecution`이 새 정책 항목인지, 원래 있었는데 표에서 누락된 것인지, `checkHardStop`과 통합해야 하는지를 코드 히스토리·정책 의도로 판단해야 한다. "고치기 쉬워 보인다"가 아니라 "판단이 드는가"가 기준이므로 B.

**B2. `GLOBAL_HARD_CAP=2` (concurrency-core.mjs) — 서명된 addendum과 충돌**
왜 A가 아닌가(coder-task.md §5-1 재확인 + 이번 라운드 신규 확인): `PKT-20260807-SUPERVISOR-CONCURRENCY-ADDENDUM-V1`(2026-08-07 03:06 한용 서명 확인함, 관제실에서 직접 열람)이 "상한을 코드 상수로 박으면 미충족 — 값의 출처가 한용이어야 한다"고 정했지만, **어디서 읽을지는 이 addendum 자신도 정하지 않았다**(패킷 §4 "정직한 한계" 1항: "«실제 자원이 정한다»는 아직 기계가 아니다"). 출처를 내가 발명하면 그 자체가 새로운 계약을 만드는 것이므로 B.

**참조처 전수 열거**(§5-1 요구): `scripts/supervisor/concurrency-core.mjs:47`(상수 선언) · `:101`(주석) · `:115`(사용) · `scripts/supervisor/concurrency-core.test.mjs:511`(mutation 주석 인용) · `:530`(mutation 시험 설명 문자열) · `docs/enforcement-known-gaps.md:316`(설명 언급, PR #111 충돌 우려로 손대지 않음).

**출처 후보**(장단점, 구현 0):

| 후보                                                                        | 장점                                                                                                                      | 단점                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **관제실 파일**(`D:\문서관리\하네스-관제실\...\concurrency-policy.json` 류) | 한용이 관제실에서 직접 고치는 흐름과 일치 · 서명 패킷과 같은 위치 계열                                                    | 저장소 코드가 저장소 밖 경로에 의존 → 시험이 mkdtemp로 격리해야 하고, 그 경로 자체가 워크트리마다 접근 가능한지 재확인 필요(현재 코어는 "I/O 0" 비타협을 갖고 있어 이 후보는 코어의 성격 자체를 바꾼다) |
| **저장소 안 설정 파일**(`scripts/supervisor/concurrency-policy.json`)       | 저장소 안이라 mkdtemp 시험 격리 쉬움 · git으로 변경 이력 남음                                                             | 값을 바꾸려면 PR이 필요해져 "한용이 즉시 조정"이라는 반응형 요구(addendum §1-A)와 마찰                                                                                                                  |
| **환경 변수**(`SUPERVISOR_CONCURRENCY_CAP`)                                 | 코드 무변경으로 값 조정 가능 · 스케줄 등록 커맨드라인에서 바로 지정 가능(watch-run.mjs의 `--notify-dir` 패턴과 동일 계열) | 값이 어디 "선언"돼 있는지 한눈에 안 보임(관측성 낮음) · 프로세스 기동마다 다시 넘겨야 함                                                                                                                |
| **`--concurrency-cap` CLI 인자 + 기본값 없음**(누락 시 UNDECIDABLE)         | "출처가 한용"이라는 요구를 가장 강하게 만족(생략 시 자동으로 진행 안 됨)                                                  | 호출부(스케줄 등록 스크립트)를 전부 갱신해야 하고, 어디서 그 값을 처음 만들어내는지 문제가 여전히 남음(위 두 후보 중 하나로 순환)                                                                       |

### C — 서명 사안

이번 라운드 검색 패턴으로는 **발견 0건**이다. `GLOBAL_HARD_CAP` 관련 서명 패킷(`PKT-20260807-SUPERVISOR-CONCURRENCY-ADDENDUM-V1`)은 이미 서명·확정 상태이고 그 패킷 문구 자체를 바꿔야 하는 저장소 안 서술은 찾지 못했다(패킷 파일 자체는 관제실에 있어 이 저장소 점검 범위 밖).

## 5. 정직한 한계 — 못 본 표면

- **(a) 완전 열거가 아니라 키워드 히트 기반이다.** §2의 검색 패턴에 안 걸리는 표현(예: 숫자를 한글도 아라비아 숫자도 아닌 방식으로 쓴 경우, 혹은 "게이트"라는 단어 없이 정책을 설명하는 문장)은 이 라운드가 못 본다. **"전부 봤다"고 주장하지 않는다.**
- **(b) 코드 주석·시험 서술은 `scripts/` 트리 전체에 Grep 패턴으로만 훑었다** — 파일을 한 줄씩 읽은 것이 아니라, 위 11개 정규식이 매칭하는 줄만 봤다. 정규식이 못 잡는 표현으로 서술된 드리프트는 여전히 남아 있을 수 있다.
- **(c) `enforcement-inventory.json`의 `known_drift_note` 필드 하나하나가 지금도 정확한지는 검증하지 않았다** — 이 파일 안에 게이트 개수·동시성 관련 키워드가 없다는 것만 확인했고, 그 파일이 서술하는 각 장치의 설치 상태·차단 실적 주장이 오늘 기준으로 여전히 맞는지는 별도 전수 검증이 필요하다(이 라운드 범위 밖으로 판단).
- **(d) `docs/enforcement-known-gaps.md`는 PR #111 충돌 우려로 의도적으로 얕게만 봤다**(coder-task.md §7-7 지시대로) — 그 파일 안에 다른 드리프트가 더 있어도 이번 라운드는 찾지 않았다.
- **(e) 영문 문서(`docs/multi-agent-v1.md`, `docs/parallelism-long-running.md` 등)는 한국어 정책 키워드로만 훑었다** — "concurrency" 등 영문 대응어 일부만 확인했고, 영문 문서 전체를 정책 대조 목적으로 정독하지는 않았다.
- **(f) `.claude/`, `templates/harness-init/`, `scripts/relay/adapters/orca-adapter.mjs` 같은 대형 파일들은 §4 범위(docs/코드 주석/시험/inventory/CI 워크플로) 밖으로 보고 이번 스윕에서 별도로 훑지 않았다** — 범위 판단이 틀렸을 수 있다.

**2R 추가분(§4 「N개+목록」 재훑기의 한계 — ⛔이 계열을 닫았다고 주장하지 않는다):**

- **(g)(3R 정정, ★검토자 지적 -- 원래 "약 60건 중 약 50건이 mutation-ledger"라고 썼는데 실측이 아니었다)** `rg -c '\d+(개|종|가지|건|축|항목)\(' docs scripts --glob '*.{md,mjs}'`를 3R에서 다시 돌려 직접 재검산했다 — **정확히 69건**이고, **가장 큰 덩어리는 `docs/enforcement-known-gaps.md` 22건**(이 파일은 PR #111 대기로 여전히 무접촉 · 손대지 않았다)이다. 다음으로 큰 파일은 이 보고서 자신(`policy-drift-sweep-2026-08-07.md` 7건 -- 보고서가 스스로를 서술하며 생기는 자기참조, 점검 대상 "소스"가 아니다) · `nc1-mutation-ledger.md` 5건 · `approval-authority-mutation-ledger.md`/`approval-authority-adapter.mjs`/`nc2-mutation-ledger.md` 각 3건이고, 나머지는 파일당 1~2건으로 흩어져 있다. **그중 9건만 표본 대조했다**(§3 표 행 6-14) — 나머지 약 60건(위 `enforcement-known-gaps.md` 22건 포함)은 개별 재검산하지 않았다(정책 드리프트가 아니라 mutation-ledger류 산술 자기검산·표본 수 서술이라는 내 판단이 틀렸을 수 있다).
- **(h) 정규식은 "숫자 바로 뒤 여는 괄호"(`\(`) 형태만 잡는다** — "다음 목록은 N가지다: …" 처럼 콜론·줄바꿈 뒤에 나열이 오는 형태, 혹은 표(마크다운 테이블) 행 수로만 개수를 암시하는 형태는 이번 정규식이 놓친다.
- **(i) 영문 수사 검색(`one`~`ten`)은 `gates|roles|steps|checks|stop|stops|points|conditions|states` 뒤따르는 명사에만 걸었다** — "phases", "tiers", "layers", "modes" 같은 다른 정책성 명사 뒤에 오는 영문 수사는 이번 라운드가 못 본다.
- **(j) B1(admission-core)·B2(GLOBAL_HARD_CAP) 외에 이번 §4 훑기로 새로 발견한 B/C 후보는 0건**이었지만, 이는 "새 B/C가 없다"는 뜻이지 "위 (g)(h)(i)의 못 본 표면 안에 B/C 후보가 없다"는 뜻이 아니다.

**3R 추가분(★이 계열을 닫았다고 주장하지 않는다):**

- **(k) 3R은 검토자가 지목한 자리(P2-1·P2-2·P2-4)와 ORCH가 추가한 자리(영문 게이트4)만 고쳤다** — §4에서 이미 적었듯 "한글 수사 + 괄호 없음" 형태(`requery-join-core.mjs`의 "다섯"이 그 예)는 2R 정규식이 구조적으로 못 잡는 형태였고, 이번 3R도 **그 형태의 전수 훑기를 하지 않았다** — 검토자가 자기 방식(2R이 쓰지 않은 키워드로 독립 검색)으로 표본 몇 곳만 확인해 P2-4 하나를 찾아낸 것이지, 이 계열이 이제 닫혔다는 근거가 아니다. 한글 수사(하나~열, 특히 "다섯"·"여섯"처럼 괄호 없이 서술문 안에 자연스럽게 섞이는 형태)에 대한 전수 정규식은 여전히 없다.
- **(l) `requery-join-core.mjs`류 "판정 N개를 표로 선언"이라는 서술 패턴이 저장소 안에 몇 곳이나 더 있는지 세지 않았다** — P2-4는 검토자가 우연히/독립적으로 찾은 표본 1건일 뿐, 같은 패턴(코드 안 배열·표 길이를 한글 수사로 서술)의 다른 자리를 체계적으로 찾는 정규식·명령은 이번 라운드에 만들지 않았다.

**4R 추가분 — ★같은 계열의 네 번째 재발(사실 기록, 처방 없음, ⛔"닫혔다" 주장 아님):**

- **(m) "적힌 수 ≠ 실제 목록/개수" 결함이 이 트랙에서 네 번 재발했다.** ① `admission-core.mjs`의 게이트 6/7/8 불일치(1R이 발견, B로 미룸) ② 1R 요지 "확실한 드리프트 2건"(실제 3건) ③ 2R 주석 "일곱 개"인데 쪼개면 여덟(1R이 고친 자리에서 재발) ④ **3R 요지 자신의 세 숫자 불일치**("A 5건" vs 산문 열거 7항목 vs 표의 A 6행) — ④는 **이 계열을 잡으려고 만든 이 결과표 자신**에서 났다.
- **(n) 네 번 다 사람이 아니라 검토(구조화된 재확인 절차)가 잡았다** — ②③④는 REVIEW, **①은 이 점검 자신**(1R의 키워드 검색이 찾아 B로 미룬 것, 위 (m)① 참조 -- REVIEW가 잡은 것이 아니다)이며, ②는 2R 검토(coder-task.md §0-C). ★머리 문장의 "구조화된 재확인 절차"는 REVIEW뿐 아니라 이 점검 1R 자신의 체계적 검색 절차도 가리킨다. 저자 자신의 재독은 넷 다 못 잡았다.
- **(o) 함의(사실만 -- 처방은 적지 않는다, B로 미룸)**: **이 저장소에서 "산문에 손으로 적은 개수"는 구조적으로 신뢰할 수 없다** — 네 번 모두 "숫자를 손으로 세어 문장에 박아 넣는" 지점에서 났고, **②③④는 기계로 재검산했을 때만 드러났다**(①은 예외 -- 재검산이 아니라 1R의 키워드 검색으로 드러났다). 이 함의에서 "그래서 무엇을 해야 하는가"(예: 린트 규칙·CI 게이트·작성 규약 등)는 **판단이 필요한 범위 밖 사안**이라 이번 라운드에서 처방하지 않는다 — **B(다음 라운드/이슈 후보)로만 남긴다**: _"산문 안 손으로 적은 개수 서술이 이 저장소에서 4회 실측 재발했다(위 ①~④) — 재발을 막을 장치(예: 이런 서술을 잡는 린트/CI 검사)를 만들지 여부는 별도 판단이 필요하다."_ ⛔**이 계열이 닫혔다는 주장은 하지 않는다** — 이번 4R이 고친 것은 이 문서 §1의 숫자 하나뿐이다(§5-(k)(l)이 이미 적은 대로, 한글 수사·괄호 없는 형태의 전수 훑기는 여전히 없다).

## 6. 실연 (요건 1)

### 6-a. 1R 실연 (보존)

```
$ node scripts/check/quality-check.mjs && node --test scripts/check/*.test.mjs scripts/relay/*.test.mjs scripts/relay/adapters/*.test.mjs scripts/supervisor/*.test.mjs
quality-check: 1 file(s) linted, 1 file(s) format-checked -- all clean
...
ℹ tests 3240
ℹ pass 3238
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
```

### 6-b. 3R(P2-1 수리) — `escalation-state.mjs`를 실제로 읽어서 세는 실연

⚠️**2R 버전은 무효였다** — 목록 문자열을 손으로 타이핑해 `split("·")`만 한
것이라, 소스에 무엇이 적혀 있든 7을 출력했다(파일을 전혀 안 읽음). 아래는
`readFileSync`로 **실제 파일을 읽어** 주석 블록에서 목록을 뽑고, **줄바꿈이
"…PR" / "승인/병합…" 사이에서 갈리는 지점을 두 가지 방식(공백 없이 이어
붙이기 / 공백 1개로 이어 붙이기)으로 각각 처리**해 둘 다 7이 나오는 것을
보인다(개수는 잇는 방식과 무관하다는 것을 보이는 것이 목적 — 대조군인
아래 6-c의 `readFileSync` 형태와 동일 성격):

```
$ cat > verify-p1.mjs <<'JS'
import { readFileSync } from "node:fs";

const src = readFileSync("scripts/relay/escalation-state.mjs", "utf8");
const lines = src.split(/\r?\n/);

const startIdx = lines.findIndex((l) => l.includes("사람 게이트 일곱 개("));
if (startIdx === -1) throw new Error("marker line not found");

const raw = [];
let i = startIdx;
while (i < lines.length) {
  const stripped = lines[i].replace(/^\/\/\s?/, "");
  raw.push(stripped);
  if (stripped.includes(")는 이 모듈")) break;
  i++;
}

function joinAndExtract(joiner) {
  const joined = raw.join(joiner);
  const m = joined.match(/사람 게이트 일곱 개\(([^)]*)\)/);
  if (!m) throw new Error("list group not found with joiner=" + JSON.stringify(joiner));
  return m[1];
}

for (const joiner of ["", " "]) {
  const full = joinAndExtract(joiner);
  const parts = full.split("·");
  const lastNoCite = parts[parts.length - 1].split(",")[0]; // display only -- drops the trailing "북극성-좌표.md §1-C ㄱ" citation that shares the same paren group, does not affect count
  console.log(`--- joiner=${JSON.stringify(joiner)} ---`);
  console.log("count =", parts.length);
  parts.slice(0, -1).forEach((p, idx) => console.log(`${idx + 1}. ${p.trim()}`));
  console.log(`${parts.length}. ${lastNoCite.trim()}`);
}
JS
$ node verify-p1.mjs
--- joiner="" ---
count = 7
1. 작업 선택
2. 연속 반려 판정
3. 북극성/큰 실행 승인
4. PR승인/병합 / Linear Done
5. 패킷 서명
6. 하드스톱
7. 상신 답변
--- joiner=" " ---
count = 7
1. 작업 선택
2. 연속 반려 판정
3. 북극성/큰 실행 승인
4. PR 승인/병합 / Linear Done
5. 패킷 서명
6. 하드스톱
7. 상신 답변
```

두 잇기 방식에서 4번 항목의 표기만 달라지고(`PR승인/병합` vs `PR 승인/병합`
— 원본 줄바꿈이 "PR"과 "승인" 사이에 있어서 생기는 차이, 의미는 같음)
**개수(7)는 잇는 방식과 무관**함을 보인다.

### 6-c. 2R — P1-2 Standing-B 실연(circled-number 개수)

```
$ node -e '
const fs=require("fs");
const text=fs.readFileSync("docs/claude-orchestrator-handoff.md","utf8");
const block = text.split("\n").slice(304,310).join(" ");
const matches = block.match(/[①②③④⑤⑥⑦⑧⑨]/g) || [];
console.log("markers found:", matches.join(""), "count=", matches.length);
'
markers found: ①②③④⑤⑥⑦ count= 7
```

### 6-d. 2R — §4 표본 대조 9곳(§3 표 행 6-14) 실행 로그

```
$ node -e 'console.log("count =", "branch, connected, handle, lastOutputAt, leafId, preview, ptyId, tabId, title, worktreeId, worktreePath, writable".split(",").length)'
count = 12

$ node -e 'console.log("count =", "NOT_OK/NO_TERMINAL_ENVELOPE/FIELDS_INCOMPLETE/FALLBACK_FORM".split("/").length)'
count = 4

$ grep -c 'test("NC mutation/seat-wire' scripts/supervisor/seat-liveness-wire.test.mjs
3
$ grep -c 'test("NC mutation/seat-scan' scripts/supervisor/seat-liveness-wire.test.mjs
3
(파일 전체 = 3+3 = 6, "6종" 주석과 일치 · "seat-scan 3종" 하위 절과도 일치)

$ sed -n '53,75p' scripts/relay/seat-identity-core.mjs | grep -c "count += 1"
3

$ grep -c "^export function smoke" scripts/check/selfcheck-smoke.mjs
7

$ grep -rEni "여덟|eight\s+(gates|steps|roles)" docs scripts --exclude="policy-drift-sweep-2026-08-07.md"
(종료 코드 1 -- 매치 0건, 이 보고서 자신의 서술 문장을 뺀 실제 소스에는 "여덟/eight gates" 잔존 없음)
```

### 6-e. 2R — 전 스위트 + 품질 검사(§6-8 방식 포함)

```
$ node scripts/check/quality-check.mjs
quality-check: 1 file(s) linted, 3 file(s) format-checked -- all clean

$ npx eslint scripts/relay/escalation-state.mjs
(종료 코드 0, 출력 없음)

$ npx prettier --check scripts/relay/escalation-state.mjs docs/claude-orchestrator-handoff.md docs/policy-drift-sweep-2026-08-07.md
Checking formatting...
All matched files use Prettier code style!

$ node --test scripts/check/*.test.mjs scripts/relay/*.test.mjs scripts/relay/adapters/*.test.mjs scripts/supervisor/*.test.mjs
...
ℹ tests 3240
ℹ pass 3238
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
```

`quality-check`가 "1 file(s) linted, **3** file(s) format-checked"로 이번에 바뀐 세 파일(`escalation-state.mjs`·`claude-orchestrator-handoff.md`·`policy-drift-sweep-2026-08-07.md`) 전부를 실제로 봤다는 뜻이다(§6-8 우려에 대한 답 — "대상 파일 없음"으로 공허하게 초록이 아니었다). fail 0. A로 고친 파일은 `escalation-state.mjs`(주석만, 실행 코드 diff 0줄)·`claude-orchestrator-handoff.md`(목록·개수만, 서식 유지) 둘뿐이고, B로 분류된 `admission-core.mjs`·`concurrency-core.mjs`(+test)·`docs/enforcement-known-gaps.md`는 `git diff --stat`가 빈 결과를 낸다(§4 B 목록 각주 참조). 커밋 0.

### 6-f. 3R — P2-4 Standing-B 실연(`requery-join-core.mjs` 판정 개수를 직접 셈)

```
$ node -e '
const src = require("fs").readFileSync("scripts/supervisor/requery-join-core.mjs", "utf8");
const start = src.indexOf("function buildStructuralFailureChecks");
const body = src.slice(start, src.indexOf("\n}\n", start) + 3);
const reasons = body.match(/REQUERY_JOIN_REASON\.[A-Z_]+/g);
console.log("count =", reasons.length);
reasons.forEach((r,i)=>console.log(`${i+1}. ${r}`));
'
count = 6
1. REQUERY_JOIN_REASON.TERMINAL_NORMALIZED_INVALID
2. REQUERY_JOIN_REASON.DISPATCH_NORMALIZED_INVALID
3. REQUERY_JOIN_REASON.CAPTURE_INCOMPLETE
4. REQUERY_JOIN_REASON.SOURCE_MISMATCH
5. REQUERY_JOIN_REASON.OBSERVED_PANE_KEYS_MISSING
6. REQUERY_JOIN_REASON.EXPECTED_REQUERY_ROUND_INVALID

$ node -e '
const src = require("fs").readFileSync("scripts/relay/dispatch-bound-seat-proof.mjs", "utf8");
const start = src.indexOf("function buildMismatchChecks");
const body = src.slice(start, src.indexOf("\n}\n", start) + 3);
const reasons = body.match(/SEAT_PROOF_REASON\.[A-Z_]+/g);
console.log("count =", reasons.length);
'
count = 5
```

`requery-join-core.mjs` 자신의 판정 표는 **6개**(주석이 "다섯"이라고 잘못
쓰고 있었다), 선례로 인용된 `dispatch-bound-seat-proof.mjs`의
`buildMismatchChecks`는 **5개** — 서로 다른 파일의 서로 다른 숫자다. 이
결과를 보고 "6"으로 정정했다(§3 표 행 16의 판단 근거).

### 6-g. 3R — `quality-check` 공허 초록 실증 + 우회 증거(§8-(f) 요구)

⚠️**`quality-check`는 staged 모드다 — 아무것도 `git add` 안 하면 실제로
바뀐 파일이 있어도 "대상 파일 없음"으로 공허하게 초록이다.** 아래가 그
실증이다(같은 작업 트리, staging 여부만 다름):

```
$ node scripts/check/quality-check.mjs        # 아무것도 add 안 한 상태
quality-check: no changed files in scope (.mjs/.js/.json/.md) -- vacuously green

$ git add -A && node scripts/check/quality-check.mjs   # 4개 파일 전부 add 후
quality-check: 2 file(s) linted, 4 file(s) format-checked -- all clean
```

⛔**이 "공허 초록"을 품질 근거로 쓰지 않는다.** 대신 staging 여부와 무관한
`npx eslint`/`npx prettier --check`를 3R이 바꾼 4개 파일 전부에 직접 걸었다:

```
$ npx eslint scripts/relay/escalation-state.mjs scripts/supervisor/requery-join-core.mjs
(종료 코드 0, 출력 없음)

$ npx prettier --check scripts/relay/escalation-state.mjs scripts/supervisor/requery-join-core.mjs docs/claude-orchestrator-handoff.md docs/policy-drift-sweep-2026-08-07.md
Checking formatting...
All matched files use Prettier code style!
```

### 6-h. 3R — 전 스위트 재확인 + B/C·`enforcement-known-gaps.md` 무접촉 증거

```
$ node --test scripts/check/*.test.mjs scripts/relay/*.test.mjs scripts/relay/adapters/*.test.mjs scripts/supervisor/*.test.mjs
...
ℹ tests 3240
ℹ pass 3238
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2

$ git diff --stat -- scripts/relay/admission-core.mjs scripts/supervisor/concurrency-core.mjs scripts/supervisor/concurrency-core.test.mjs docs/enforcement-known-gaps.md
(출력 없음 -- 4개 파일 전부 무변경)

$ git status --porcelain
 M docs/claude-orchestrator-handoff.md
 M scripts/relay/escalation-state.mjs
 M scripts/supervisor/requery-join-core.mjs
?? docs/policy-drift-sweep-2026-08-07.md
```

fail 0 유지(3240/3238/0/2, 1R·2R과 동일 — 3R도 주석/문서만 건드려 회귀
없음). B(`admission-core.mjs`·`concurrency-core.mjs`+test)·`docs/enforcement-known-gaps.md`
무접촉이 `git diff --stat`의 빈 출력으로 확인된다. gap 등재도 이 라운드에서
하지 않았다(§7-6 지시대로). 커밋 0.

### 6-i. 4R — §1 세 숫자 일치 Standing-B 실연(P1 수리)

⚠️**손으로 세지 않는다** — 표 A행·B행·산문 열거를 이 문서 자신에서
**기계로 파싱해 세는** 스크립트를 만들어 돌렸다(작업 트리 밖에 저장,
§7-7 지시대로 저장소 안에는 남기지 않음):

```
$ node count-nums.mjs
table A rows = 7
table B rows = 2
table A+B (총 확실한 드리프트) = 9
prose enumerated items (라운드 태그 개수) = 7
  1. (1R)
  2. (2R-P1-1)
  3. (2R-P1-2)
  4. (3R-P2-1)
  5. (3R-P2-2)
  6. (3R-P2-4, **검토자 독립 발견**)
  7. (3R, **ORCH 추가·검토자 목록
밖**)
```

**표 A행(7) = 산문 열거(7)** — 일치. **표 B행(2)**은 "확실한 드리프트"에는
포함되지만(9 = 7+2) A로 고친 것에는 포함되지 않는다(B는 여전히 무접촉).
§1을 이 결과에 맞춰 "확실한 드리프트 9건(A 7 + B 2)"과 "A 7건 전부
고쳤다"로 구별해 적었다.

**행 추가 vs 산문 수정, 선택과 근거**: 표에 없던 3R-P2-2를 **행 18로
새로 추가**하는 쪽을 택했다(coder-task.md §2-2가 준 두 옵션 중). 근거 =
P2-2는 검토자의 **별개 지적**(권고 ⓑ, "정확히 7개가 나온다" 문장 삭제)이고
2R-P1-1(구분자 충돌 자체)과는 발견 경위가 다르다 — 같은 파일·인접한
줄이라고 해서 표에서 합쳐 세면, 다음에 이 파일을 다시 여는 사람이 "몇
번째 발견인지" 잃어버린다. 행 2의 "조치" 열도 P2-2 서술을 빼고 행 18로
옮겨, 한 발견이 두 행에 중복 카운트되지 않게 했다.

### 6-j. 4R — `requery-join-core.mjs` 질적 표현 확인 + 최종 회귀·무접촉·품질 증거

```
$ grep -n "5개\|다섯" scripts/supervisor/requery-join-core.mjs
(매치 0건 -- cross-file 숫자 "5" 완전히 제거됨)

$ sed -n '278,283p' scripts/supervisor/requery-join-core.mjs
// §2-B와 같은 표 형태(dispatch-bound-seat-proof.mjs의
// buildMismatchChecks/findMismatchReason 선례 -- 그 파일의 판정 개수는
// 이 파일과 다르니 혼동하지 말 것) -- 이 파일은 판정 6개를 표로 선언해
// 분기 복잡도를 낮춘다. 순서가 판정 우선순위다(첫 실패가 그대로 결과
// 사유가 된다). 어떤 비교도 생략·완화하지 않는다.

$ git diff scripts/supervisor/requery-join-core.mjs | grep '^+' | grep -v '^+++' | grep -v '^+//'
(출력 없음 -- 추가된 줄 전부 주석, 코드 무변경)

$ npx eslint scripts/relay/escalation-state.mjs scripts/supervisor/requery-join-core.mjs
(종료 코드 0, 출력 없음)

$ npx prettier --check scripts/relay/escalation-state.mjs scripts/supervisor/requery-join-core.mjs docs/claude-orchestrator-handoff.md docs/policy-drift-sweep-2026-08-07.md
Checking formatting...
All matched files use Prettier code style!

$ node --test scripts/check/*.test.mjs scripts/relay/*.test.mjs scripts/relay/adapters/*.test.mjs scripts/supervisor/*.test.mjs
...
ℹ tests 3240
ℹ pass 3238
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2

$ git diff --stat -- scripts/relay/admission-core.mjs scripts/supervisor/concurrency-core.mjs scripts/supervisor/concurrency-core.test.mjs docs/enforcement-known-gaps.md
(출력 없음 -- 4개 파일 전부 무변경, 4R도 무접촉 유지)

$ git status --porcelain
 M docs/claude-orchestrator-handoff.md
 M scripts/relay/escalation-state.mjs
 M scripts/supervisor/requery-join-core.mjs
?? docs/policy-drift-sweep-2026-08-07.md
```

로컬 "6"은 그대로 남고 cross-file "5"만 질적 표현으로 바뀌어 3R보다
문장이 짧아졌다(괄호 안 괄호·이중 `--` 중 하나를 제거). fail 0 유지,
`quality-check`는 여전히 staging에 따라 공허 초록일 수 있어(§6-g 참조)
`npx eslint`/`npx prettier --check` 직접 실행 결과로 대체했다. B·gaps
무접촉, 임시 스크립트(`count-nums.mjs`)는 `$TEMP`에만 두고 작업 트리
바깥에서 지웠다(§7-7). 커밋 0.

### 6-k. 5R — §1·§2 정정(내역 배분·파생 문구)의 파생 영향 확인

★**손대는 곳 = §5-(n)·(o) 두 문단뿐**(coder-task.md §1·§2). 그 정정이
4R이 맞춘 "세 숫자"(표 A 행 수·산문 열거 항목 수·"A 7건")를 깨는지
4R과 같은 계수 스크립트를 다시 돌려 확인했다(손으로 세지 않음):

```
$ node count-nums.mjs
table A rows = 7
table B rows = 2
table A+B (총 확실한 드리프트) = 9
prose enumerated items (라운드 태그 개수) = 7
  1. (1R)
  2. (2R-P1-1)
  3. (2R-P1-2)
  4. (3R-P2-1)
  5. (3R-P2-2)
  6. (3R-P2-4, **검토자 독립 발견**)
  7. (3R, **ORCH 추가·검토자 목록
밖**)
```

**어긋난 곳 없다** — 표 A(7) = 산문 열거(7), B(2), 합계(9) 전부 4R과
동일. §1·§2의 정정은 §5-(n)·(o) 두 문단 안쪽 문장에만 있고, §1 요지의
숫자·라운드 태그 목록·§3 표의 어느 셀도 이번에 건드리지 않았으므로
당연한 결과이지만, "당연하다"고 손으로 판단하지 않고 위 실행으로
확인했다.

**①(admission-core 6/7/8)의 발견 주체 확인 근거(coder-task.md §1-3
요구)**: (m)①이 "1R이 발견, B로 미룸"이라고 직접 명시하고, §3 표
행 4의 라운드 태그가 `1R(2R 재확인)`이다(REVIEW가 아니라 1R 자신 ·
그 뒤 2R에서 재확인만 됨) — 둘 다 이 문서 안 원문을 직접 읽어 확인했다
(REVIEW·ORCH 말을 근거로 삼지 않음).
