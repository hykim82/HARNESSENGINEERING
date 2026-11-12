# HYK-153 -- 엔진 무관(engine-agnostic) 증명, 조각 A

북극성 ④ "엔진 무관 대체" 완료 조건의 ⓐ(분리 라운드 집계)와 ⓑ-1(엔진 이름
리터럴 기준선 고정)을 구현한다. 이 라운드는 **기준선을 고정**할 뿐, 저장소의
엔진 하드코딩을 줄이지 않는다(그건 HYK-153 조각 B). ⓒ(가짜 엔진 어댑터
합성 완주)는 조각 C다.

## ⓐ 분리 라운드 집계

```
node scripts/check/engine-split-rounds.mjs \
  --ledger  D:\문서관리\하네스-관제실\admission-ledger.json \
  --registry D:\문서관리\하네스-관제실\seat-launch-registry.jsonl \
  [--transcripts C:\Users\Administrator\.claude-team\projects] \
  [--json] \
  [--min-strict 30] [--min-strict-excl-top 30] [--min-authors 20] [--min-issues 10] [--min-confirmed 20]
```

읽기만(모든 입력을 읽기만 하고, 아무 것도 쓰지 않는다)이다.

- **조인**: `admission-ledger.json`의 `reservations.<harness_label>.{role,
seat_key, status, completion_reason}`을 `seat-launch-registry.jsonl`의
  `{paneKey, model, worktree, ...}`와 `seat_key == paneKey`로 조인한다.
- **쌍 정의**(review 1R P2-2로 정정): 검토 라벨 정규식 `^(.*)-review-(\d+)$`의
  캡처 1(`base`)과 캡처 2(검토 회차 번호 `n`)로, 작성 라벨은 `${base}-r${n}`이
  원장에 있으면 그쪽(재작업 라운드), 없으면 `base` 그대로(라운드 1, `-rN`
  접미사 없음)다. 실제 원장으로 확인: `HYK-480-checklist-inject-2-review-2`는
  `HYK-480-checklist-inject-2-r2`(재작업)에 붙고, `...-review-1`은 그 base
  그대로에 붙는다. 전에는 항상 `base`에만 붙어서, 재작업 라운드의 실제
  작성 좌석·모델이 아니라 라운드 1의 것으로 잘못 짝지어졌다. 짝지을 작성
  예약이 없으면 그 검토 라벨은 세지 않는다(라벨 규약이 다른 과거 라운드를
  과소 집계할 수 있다는 알려진 한계).
- **엄격(strict)**: 작성 좌석 `model` ~ `/sonnet/i` · 검토 좌석 `model` ~
  `/opus/i` · 양쪽 `status === "COMPLETED"` · 양쪽 `completion_reason`
  없음.
- **느슨(loose)**: 위에서 `completion_reason` 조건만 뺀 것(스윕·BLOCKED
  종료로 반납된 라운드도 포함).
- **이슈**: 작성 라벨 머리의 `HYK-\d+`.
- **세션 확인(선택, `--transcripts`)**: 워크트리 경로의 비영숫자를 `-`로
  바꾼 폴더 아래 `*.jsonl`의 모델 값으로, 엄격 쌍의 모델을 한 번 더
  corroborate한다. 실제 세션 기록 jsonl 줄은 모델 이름을 최상위 `model`이
  아니라 `message.model`에 둔다(review 1R P2-1 실측: 표본 1폴더에서 최상위
  `model` 0줄 · `message.model` 101줄) -- 이 CLI는 `message.model`을 먼저
  읽고, 과거 합성 픽스처 모양(최상위 `model`)도 하위호환으로 읽는다.
  워크트리 단위라 라운드 단위 증거보다 약하다(아래 한계).

출력: 엄격/느슨 각각 N · 작성 라운드 수 · 이슈 수 · 최다 이슈 제외 N ·
모델 분포 · 표본 3행 · 시간순 첫/마지막 쌍(review 1R P2-6: 검토 예약의
`admitted_at` 기준, 라벨 텍스트 사전순이 아니다) · (옵션) 세션 확인/섞임 수.
문턱 미달 또는 섞임 > 0이면 `exit 1`. 문턱 인자가 숫자가 아니거나 값이
없으면(NaN) 거부하고 `exit 1`이다(review 1R P2-4 -- 이전엔 NaN 비교가 항상
거짓이라 문턱이 조용히 열렸다).

### 지금 값 (2026-11-10, 이 라운드의 1회 읽기 판독)

이 라운드 결과 파일(`.harness/coder.md`)의 §4 실행 원문을 정본으로 삼는다.
PM 설계 1R(`PM/산출물/하네스/2026-11-10-엔진무관증명/엔진무관-증명-설계.md`)이
손으로 돌린 `count-sep.ps1`의 값(엄격 116 · 작성 80 · 이슈 23 · 최다 이슈
제외 78)과 이 CLI의 값이 다를 수 있다 -- 이 CLI는 작성 라벨을 `-rN` 재작업
규칙(위 쌍 정의)으로 조인 키를 정하고, PM 설계는 손 스크립트였다. 차이가
있으면 결과 파일에 원문과 이유를 적는다.

## ⓑ-1 엔진 이름 리터럴 기준선

```
node --test scripts/check/engine-name-literal.test.mjs
```

- **대상**: `scripts/**/*.mjs` 중 `*.test.mjs`와 `fixtures/`를 뺀 파일.
- **토큰화**: `//`·`/* */` 주석을 제거(내용 무시)하고, 문자열·템플릿
  리터럴에 더해 **정규식 리터럴의 몸(body)도 리터럴로 추출한다**(review 1R
  P2-3 수정 -- 이전엔 정규식 리터럴이 토큰화 단계에서 완전히 버려져 `/codex/i`
  같은 모양이 양쪽 축 모두에서 사각이었다). 템플릿의 `${}` 안은 코드로
  취급한다(안에 또 문자열이 있으면 그건 그 자체로 리터럴).
- **닻**: `/claude|codex|sonnet|opus|haiku|fable|gpt-|anthropic|openai/i`.
- **허용 목록**: `scripts/check/engine-name-literal-allowlist.json`. 양방향
  **다중집합(multiset) 정확 일치**(review 1R P1-1 수정 -- 키마다 «출현
  횟수»까지 고정한다. 이전엔 Set 비교라 이미 허용된 `(파일, 리터럴)`에
  같은 리터럴을 몇 개를 더 넣어도 초록이었다; 각 행에 `count` 칸을 둔다)
  - sha256 바이트 고정. 분류 칸은 E1(설정 파일, 이 라운드엔 아직 없음) ·
    E2(엔진별 어댑터/관측 모듈) · E3(사람에게 보이는 사유문·usage, 비교연산자
    오른쪽 아님) · E5(계층 밖 Claude 전용 훅 목록) · B2-TODO(조각 B에서 설정
    파일로 이관할 분기·표).
- **분기 리터럴**: `/[=!]==\s*(["'`])(claude|codex|...)(?=\1)|[=!]==\s*["'`](gpt-)/i`가
  걸리는 `(파일, 매치)` 다중집합도 같은 방식으로 기준선 고정
  (`branchLiteralBaseline`). "0"을 단언하지 않는다 -- 지금 있는 분기를
  없애는 것은 조각 B다. 비`gpt-` 닻 단어는 **같은 닫는 인용부호가 바로
  뒤따라야**(리터럴 내용이 정확히 그 단어일 때만) 매치한다(review 1R
  P2-7 수정 -- 이전엔 접두 일치라 `"claude-settings"` 같은 무관한 식별자도
  `"claude"` 분기로 오탐했다). `gpt-`는 의도적으로 접두 일치를 유지한다
  (모델명이 `gpt-5.6`처럼 뒤에 계속되므로).
- **변이(시험 내장, mkdtemp 합성 샘플 + 계층 파일 _사본_ 변이)**: ① 샘플
  소스에 엔진 리터럴 주입 → RED ② 샘플 소스에 엔진 이름 분기 비교 주입 →
  RED ③ 허용 목록에서 한 행의 count를 뺀 뒤 실제 스캔과 대조 → 그 만큼이
  "새 적중"으로 다시 나타남 ④ 계층 파일 _사본_(allowlist 비교까지 거침,
  review 1R이 지적한 "탐지 함수만 돌리는 칸은 헛시험 아님의 근거가 못
  된다"에 대응)에 새 리터럴/새 분기/**이미 허용된 키의 추가 출현**/정규식
  리터럴을 각 1개씩 주입 → RED. 실파일(제자리) 변이는 결과 파일(§2 ⓓ)에
  별도로 기록한다 -- 커밋되는 시험 코드에는 포함하지 않는다.

## 한계 (PM 설계 §h 그대로)

- 이 설계는 "다른 회사 엔진에서 실제로 돈다"를 증명하지 않는다.
- ⓐ의 모델 근거는 런처 argv(레지스트리)와 워크트리 단위 세션 기록이다.
  라운드별 "실제 모델"을 원장에 남기는 장치는 없다.
- ⓐ의 쌍 매칭은 라벨 규약에 기댄 추론이다 -- `for:` 줄로 직접 대조한 쌍은
  review 1R 표본 138개 중 일치 90 · 불일치 48(재작업 50개가 `-rN`에
  붙는지가 그 48의 원인이었다 -- 이 라운드에서 그 규칙을 반영했다)이고,
  이 CLI는 여전히 라벨 자체의 구조(위 쌍 정의)만으로 짝짓는다; `for:` 줄
  전수 대조로 바꿀지는 상신 대상(PM 설계 §a 정의 문제)으로 남아 있다.
- ⓑ-1 허용 목록의 E2/E3/E5/B2-TODO 분류는 이 라운드의 판단([추론])이다 --
  정밀한 재분류는 조각 B에서 한다(review 1R P2-5: dispatch-worker-modal-check:26을
  검출 마커로 보고 E3 -> B2-TODO로 정정했다; seat-engine-detect:84·104 ·
  worker-launch-rules:59는 review가 E3로 보는 쪽이 정의에 더 맞다고
  지적했으나 이 라운드에서는 보수적으로 B2-TODO를 유지했다 -- 상신 대상).
- 엔진 분기 코드·`ENGINE_BY_ROLE`·런처 기본값 수정, 엔진 프로필 설정 이관,
  가짜 엔진 어댑터는 이 라운드의 범위 밖이다(조각 B·C).

## 추기 (HYK-153-engine-profile-2, 조각 B 2R -- 책임자 판정 2026-11-10

23:5x 상신 2348 → A 반영)

책임자 판정이 피스 B 1R의 정제 문면("엔진 이름 리터럴은 설정 1곳 +
등록된 엔진별 모듈 안에만")을 **글자 그대로** 적용하라고 확정했다 --
"설정 접근 인자에 엔진 이름을 적는 것도 엔진 이름 리터럴"이라는 해석
(상신 안 C는 비채택, 이 해석 자체는 그대로 확정). 이 라운드가 §b 분류를
다시 건드린 지점 둘:

- **E1 전원 제거**: 1R이 "config-access literal(어느 프로필을 읽을지
  고르는 인자일 뿐, 분기 비교가 아님)"이라는 이유로 E1으로 분류했던 4행
  (`engine-split-rounds.mjs:35` · `orca-adapter.mjs:2649` ·
  `seat-candidate-adapter.mjs:281`/`287`)은 전부 **설정 파일 밖(.mjs
  안)**에 있었다 -- 정제 문면을 글자 그대로 적용하면 그 자체로 반칙이다.
  네 지점 모두 리터럴 인자를 역할 기반 조회(`getEngineByRole()`) 또는
  설정에서 읽은 엔진 목록 순회(`getKnownEngines()`)로 바꿔 리터럴 자체를
  없앴다 -- 결과값은 넷 다 바뀌지 않았다(라이브 역할 해석 무변,
  `engine-split-rounds.test.mjs`/`seat-candidate-adapter.test.mjs`/
  `seat-marker-divergence.contract.test.mjs`로 확인). E1은 이제 허용
  목록에 0행이다(분류 이름 자체는 스키마에 남긴다 -- 미래의 진짜 사례를
  위해).
- **E2 정직화(4행 B2-TODO 복귀)**: 1R이 코드 0 변경으로 B2-TODO에서
  E2로 옮긴 4행 (`seat-config-inject.mjs:62`/`246`/`279` ·
  `dispatch-worker-modal-check.mjs:26`)은 그 재분류를 "claude-adapter.mjs
  /codex-adapter.mjs/derive-claude-project-dir-cli.mjs와 같은 전례"라고
  적었다 -- 그런데 그 세 전례 파일은 전부 **파일명 자체에 엔진 이름이
  있다**(E2 "등록된 엔진별 모듈"이 실제로 검증 가능한 유일한 근거). 이
  두 파일(`seat-config-inject.mjs`, `dispatch-worker-modal-check.mjs`)은
  파일명에 엔진 이름이 없다 -- 내용은 진짜로 claude 전용(role-guard
  훅/설정 주입, Claude Code CLI 모달 문구)이지만, 그 전례의 근거가 이
  두 파일에는 그대로 옮겨지지 않는다. 엔진 중립으로 고칠 수도 없다(둘 다
  설정에서 읽을 수 있는 값이 아니라 claude 전용 셸 스니펫·CLI 문구 그
  자체). P2-5가 준 세 갈래(엔진 중립화 / 파일명 규칙 근거의 등록된
  목록 / B2-TODO 복귀) 중 남는 것은 세 번째뿐이라, 새 근거를 만들어내지
  않고 B2-TODO로 되돌렸다(허용 목록 각 행의 note에 같은 설명을 반복해
  둔다).

둘 다 코드 동작은 바뀌지 않았다(리터럴을 없애거나, 분류 칸만 되돌렸다) --
`ENGINE_BY_ROLE` 역할별 해석 결과는 PM 추가 외에는 무변이다. 상신
2348·14:5x ⓑ 정제 문면 원문은 PM 설계 산출물(§1 참조)에 있다.

## 추기 (HYK-153-adapter-registry-1, 조각 D -- 책임자 판정 2026-11-11 12:1x/13:0x)

`engine-profiles.json`의 `engines.<engine>.adapterModule`(저장소 루트
기준 POSIX 상대 경로, 라이브 claude/codex 둘 다
`scripts/relay/adapters/orca-relay-adapter.mjs`)과 새 모듈
`scripts/relay/engine-adapter-registry.mjs`(`selectRelayAdapterForRole
(role)`)가 역할 → 릴레이 어댑터(ensureSeat/observeSeatCandidates/
deliverTask/collectCompletionSignals/teardownSeat + execFn) 고름을 한
자리로 모았다. `scripts/relay/run-step.mjs`는 이제
`./adapters/*.mjs`를 정적으로 import하지 않고 이 등록부가 고른 결과를
쓴다 -- 고름이 실패하면(`ROLE_PROFILE_MISSING` ·
`ADAPTER_MODULE_MISSING` · `ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR` ·
`ADAPTER_MODULE_IMPORT_FAILED` · `ADAPTER_CONTRACT_INVALID`, 모두 사유
있는 실패, 기본값으로 떨어지는 길 없음) `relayStep` 자체가 호출되지
않는다. 오늘의 라이브 claude/codex 역할 해석·배달 결과는 무변 -- 이
라운드는 "설정에서 어댑터를 고른다"는 간접 한 단계만 추가했다.

정직 한계(판정 1259 ⓑ): 관제실 ps1(좌석 기동·배달)의 엔진 리터럴
분기는 저장소 밖이라 이 라운드로 증명되지 않는다 -- 조각 E(범위 밖)로
등재.

## ④ⓒ 가짜 엔진 합성 완주 (HYK-153-fake-engine-1, 조각 C -- 책임자 판정

2026-11-11 12:1x/13:0x + 상신 1259 (가))

```
node --test scripts/relay/fake-engine-round.test.mjs
```

- **무엇을 증명하는가**: `scripts/check/engine-profiles.json`을 mkdtemp에
  바이트 그대로 복사하고 `engines.<F>`(가짜 엔진, 어댑터 =
  `scripts/relay/adapters/fake-engine-relay-adapter.mjs`) 1개를 더한 뒤
  `HARNESS_ENGINE_PROFILES_PATH`로 그 사본을 가리키게 하면, 저장소
  진입점 `run-step.mjs`의 `runStepCli`가 조각 D의 등록부로 그 가짜
  어댑터를 실제로 골라 CODER→REVIEW 1라운드를 프로덕션 소비 게이트
  (`checkRelayHandshake`의 전체 검사 · 합성 admission 반납 ·
  `consumption-receipt-writer.mjs` 영수증 · reject-streak 기록, 검사
  끔 0)까지 완주시킨다 -- 영수증 2개, 결과 파일의 `engine_profile:`
  증언 줄이 영수증 `binding.resultFingerprint`에 결속, 전역(실제
  관제실 원장 · 이 워크트리의 실제 `.harness/reject-streak.json`)에는
  라벨 흔적이 0이다.
- **라이브 설정·전역 원장 무변**: 라이브 `engine-profiles.json`의
  sha256과 이 워크트리의 실제 `.harness/` 지문은 이 시험 전/후 바이트
  단위로 같다(시험 자신의 `after()`가 매번 재확인). 실제 관제실
  `D:\문서관리\하네스-관제실\admission-ledger.json`/`dispatch-
receipts.jsonl`은 읽기만 한다(합성 라벨이 0건인지 대조하는 용도).
- **음성 칸 6개**: B4(가짜 설정 `model: " "` → `CONFIG_SCHEMA_INVALID`,
  어댑터 선택 자체가 실패해 `relayStep` 미도달) + pane_match 불일치(G1) ·
  DONE 손찍기(`done_stamped_by` 마커 없음) · 예약 없음
  (`admissionReturned` 실패) · REVIEW `head_commit` 불일치 · `verdict:`
  2줄(AMBIGUOUS) -- 각각 영수증 0 + 지정된 거부 사유로 끝난다.
- **실 모델/Orca 호출 0**: PATH 맨 앞에 `claude`/`codex`/`orca` 심(.cmd +
  POSIX, 호출되면 표식 파일을 쓰고 97로 끝난다)을 두고 전 라운드를
  돌린 뒤 표식 파일 0개를 확인한다. 가짜 어댑터의 정적 import 닫힘에는
  `orca-adapter.mjs`/`claude-adapter.mjs`/`codex-adapter.mjs`/
  `orca-relay-adapter.mjs`가 없고(G9 스캐너를 그 파일 원문에 직접
  돌려도 위반 0), 이 테스트 파일 자신도 `run-step.mjs`/
  `engine-adapter-registry.mjs`/`engine-profile.mjs`를 정적 import하지
  않는다(env 주입 뒤 동적 import로만 닿는다).

### 정직 한계

- 이 라운드는 "다른 회사 엔진이 실제로 돈다"를 증명하지 않는다 --
  오늘 claude/codex 둘 다 같은 Orca 어댑터로 수렴하는 것은 조각 D
  그대로이고, 이 라운드는 등록부가 «설정에서 고른 임의의 어댑터
  모듈»을 끝까지 소비 게이트에 태울 수 있음을 증명한다.
- 관제실 ps1(좌석 기동·배달)의 엔진 리터럴 분기는 저장소 밖이라 여전히
  증명되지 않는다 -- 조각 E(범위 밖)로 등재(판정 1259 ⓑ, 조각 D의 같은
  한계를 조각 C도 물려받는다).
- 러너 영수증 축은 이 시험의 범위 밖이다(`runner_contract: none` -- 합성
  러너 영수증을 손으로 만들면 그 자체가 "손으로 만든 영수증"이 되므로
  만들지 않는다).
- `deliveryMode: "inject"`는 가짜 엔진에 참인 값이 아니다(가짜 완주는
  Orca 배달을 타지 않으므로 이 값은 어디서도 읽히지 않는다) -- C-2,
  기록만.
- `engines`/`roles`의 빈 키 이름(`engines[""]`/`roles[""]`) 거부는
  별도 커밋(`scripts/check/engine-profile.mjs`)으로 들어간다(C-1, B4가
  의식적으로 범위 밖에 뒀던 반례).
