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

읍기만(모든 입력을 읅기만 하고, 아무 것도 쓰지 않는다)이다.

- **조인**: `admission-ledger.json`의 `reservations.<harness_label>.{role,
seat_key, status, completion_reason}`을 `seat-launch-registry.jsonl`의
  `{paneKey, model, worktree, ...}`와 `seat_key == paneKey`로 조인한다.
- **쌍 정의**: 검토 라벨 정규식 `^(.*)-review-(\d+)$`의 캡처 1이 작성
  라벨이다(글자 그대로 -- `group1 + "-" + group2`가 아니다). 매칭되는 작성
  예약이 없으면 그 검토 라벨은 세지 않는다(라벨 규약이 다른 과거 라운드를
  과소 집계할 수 있다는 알려진 한계).
- **엄격(strict)**: 작성 좌석 `model` ~ `/sonnet/i` · 검토 좌석 `model` ~
  `/opus/i` · 양쪽 `status === "COMPLETED"` · 양쪽 `completion_reason`
  없음.
- **느슨(loose)**: 위에서 `completion_reason` 조건만 뺀 것(스윕·BLOCKED
  종료로 반납된 라운드도 포함).
- **이슈**: 작성 라벨 머리의 `HYK-\d+`.
- **세션 확인(선택, `--transcripts`)**: 워크트리 경로의 비영숫자를 `-`로
  바꾼 폴더 아래 `*.jsonl`의 `"model"` 값으로, 엄격 쌍의 모델을 한 번 더
  corroborate한다. 워크트리 단위라 라운드 단위 증거보다 약하다(아래 한계).

출력: 엄격/느슨 각각 N · 작성 라운드 수 · 이슈 수 · 최다 이슈 제외 N ·
모델 분포 · 표본 3행 · (옵션) 세션 확인/섞임 수. 문턱 미달 또는 섞임 > 0이면
`exit 1`.

### 지금 값 (2026-11-10, 이 라운드의 1회 읅기 판독)

이 라운드 결과 파일(`.harness/coder.md`)의 §4 실행 원문을 정본으로 삼는다.
PM 설계 1R(`PM/산출물/하네스/2026-11-10-엔진무관증명/엔진무관-증명-설계.md`)이
손으로 돌린 `count-sep.ps1`의 값(엄격 116 · 작성 80 · 이슈 23 · 최다 이슈
제외 78)과 이 CLI의 값이 다를 수 있다 -- 이 CLI는 "캡처 1 = 작성 라벨"을
글자 그대로 조인 키로 쓰고, PM 설계는 손 스크립트였다. 차이가 있으면
결과 파일에 원문과 이유를 적는다.

## ⓑ-1 엔진 이름 리터럴 기준선

```
node --test scripts/check/engine-name-literal.test.mjs
```

- **대상**: `scripts/**/*.mjs` 중 `*.test.mjs`와 `fixtures/`를 뺀 파일.
- **토큰화**: `//`·`/* */` 주석과 정규식 리터럴을 제거(둘 다 내용 무시)하고,
  문자열·템플릿 리터럴만 추출한다. 템플릿의 `${}` 안은 코드로 취급한다
  (안에 또 문자열이 있으면 그건 그 자체로 리터럴).
- **닻**: `/claude|codex|sonnet|opus|haiku|fable|gpt-|anthropic|openai/i`.
- **허용 목록**: `scripts/check/engine-name-literal-allowlist.json`. 양방향
  정확 일치(새 적중 = RED · 낡은 예외 = RED) + sha256 바이트 고정. 분류 칸은
  E1(설정 파일, 이 라운드엔 아직 없음) · E2(엔진별 어댑터/관측 모듈) ·
  E3(사람에게 보이는 사유문·usage, 비교연산자 오른쪽 아님) · E5(계층 밖
  Claude 전용 훅 목록) · B2-TODO(조각 B에서 설정 파일로 이관할 분기·표).
- **분기 리터럴**: `/[=!]==\s*["'`](claude|codex|...)/i`가 걸리는
`(파일, 매치)` 집합도 같은 방식으로 기준선 고정(`branchLiteralBaseline`).
  "0"을 단언하지 않는다 -- 지금 있는 분기를 없애는 것은 조각 B다.
- **변이 3종(시험 내장, mkdtemp 합성 샘플)**: ① 샘플 소스에 엔진 리터럴
  주입 → RED ② 샘플 소스에 엔진 이름 분기 비교 주입 → RED ③ 허용 목록에서
  한 행을 뺀 뒤 실제 스캔과 대조 → 그 행이 "새 적중"으로 다시 나타남.

## 한계 (PM 설계 §h 그대로)

- 이 설계는 "다른 회사 엔진에서 실제로 돈다"를 증명하지 않는다.
- ⓐ의 모델 근거는 런처 argv(레지스트리)와 워크트리 단위 세션 기록이다.
  라운드별 "실제 모델"을 원장에 남기는 장치는 없다.
- ⓐ의 쌍 매칭은 라벨 규약에 기댄 추론이다 -- `for:` 줄로 직접 대조한 쌍은
  표본 2개뿐(PM 설계 §a)이고, 이 CLI는 라벨 자체의 구조(캡처 1 = 작성
  라벨)만으로 짝짓는다.
- ⓑ-1 허용 목록의 E2/E3/E5/B2-TODO 분류는 이 라운드의 판단([추론])이다 --
  정밀한 재분류는 조각 B에서 한다.
- 엔진 분기 코드·`ENGINE_BY_ROLE`·런처 기본값 수정, 엔진 프로필 설정 이관,
  가짜 엔진 어댑터는 이 라운드의 범위 밖이다(조각 B·C).
