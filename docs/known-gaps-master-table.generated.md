# known-gaps 마스터 표 (기계 생성)

생성기: `node scripts/check/generate-gaps-master-table.mjs` · 대상: `docs/enforcement-known-gaps.md` · 생성 시각은 이 파일 자체에 기록하지 않는다(§2-2 index-schema-draft.md 주의사항과 동일 이유 -- 판정 로직이 타임스탬프에 의존하면 안 되므로, 재실행마다 diff가 나는 필드를 산출물에 넣지 않는다).

## 마스터 표

| ID  | 수     | 범위·정의                                                               | 명령                                                                                                                         | 출력     |
| --- | ------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | 347058 | 대상 파일(docs/enforcement-known-gaps.md) 바이트 크기                   | `stat -c%s docs/enforcement-known-gaps.md`                                                                                   | `347058` |
| 2   | 99     | 표 행(`\| N \| ... \|`) 총수                                            | `git grep -c -E '^\| *#?[0-9]+ *\|' -- docs/enforcement-known-gaps.md \| cut -d: -f2`                                        | `99`     |
| 3   | 99     | 표 행 고유 번호 수                                                      | `git grep -o -h -E '^\| *#?[0-9]+ *\|' -- docs/enforcement-known-gaps.md \| grep -o -E '[0-9]+' \| sort -u \| wc -l`         | `99`     |
| 4   | 0      | 표 행 중복 수(=ID2-ID3)                                                 | (산식)                                                                                                                       | `0`      |
| 5   | 0      | 표 행에서 #94 매치 수(결번 확인)                                        | `git grep -o -h -E '^\| *#?[0-9]+ *\|' -- docs/enforcement-known-gaps.md \| grep -o -E '[0-9]+' \| grep -c '^94$' \|\| true` | `0`      |
| 6   | 23     | 산문 절 헤더(`^## ... gap#NN`) 줄 수                                    | `git grep -c -E '^## .*gap ?#[0-9]+' -- docs/enforcement-known-gaps.md \| cut -d: -f2`                                       | `23`     |
| 7   | 2      | gap#93 헤더 줄 기준 등장 수                                             | `git grep -c -E '^## .*gap#93' -- docs/enforcement-known-gaps.md \| cut -d: -f2`                                             | `2`      |
| 8   | 4      | gap#93 매치 줄 수(rg -c, 같은 줄 중복은 1로)                            | `rg -c 'gap#93' docs/enforcement-known-gaps.md`                                                                              | `4`      |
| 9   | 5      | gap#93 총 등장 토큰 수(같은 줄 중복도 개별 계산)                        | `rg -o -n 'gap#93' docs/enforcement-known-gaps.md \| wc -l`                                                                  | `5`      |
| 10  | 90     | 표 행 분류 열 `KNOWN GAP` 매치 줄 수                                    | `grep -c "KNOWN GAP" docs/enforcement-known-gaps.md`                                                                         | `90`     |
| 11  | 5      | 표 행 분류 열 `NEW DEFECT` 매치 줄 수                                   | `grep -c "NEW DEFECT" docs/enforcement-known-gaps.md`                                                                        | `5`      |
| 12  | 1      | 표 행 분류 열 `BLOCKED(` 매치 줄 수                                     | `grep -c "BLOCKED(" docs/enforcement-known-gaps.md`                                                                          | `1`      |
| 13  | 95     | ID10+ID11(실제 gap 근사치)                                              | (산식)                                                                                                                       | `95`     |
| 14  | 98     | ID2-ID12(BLOCKED #10 제외한 계수)                                       | (산식)                                                                                                                       | `98`     |
| 15  | 3      | ID14-ID13(미해소 어긋남, 그대로 보고)                                   | (산식)                                                                                                                       | `3`      |
| 16  | 19     | `enforcement-known-gaps.md` 경로 문자열을 참조하는 파일 수(저장소 전체) | `git grep -l "enforcement-known-gaps.md" -- . \| wc -l`                                                                      | `19`     |
| 17  | 39     | 위 경로 문자열의 저장소 전체 매치 수                                    | `git grep -o "enforcement-known-gaps.md" -- . \| wc -l`                                                                      | `39`     |
| 18  | 26     | `enforcement-v1.md` 경로 문자열을 참조하는 파일 수                      | `git grep -l "enforcement-v1.md" -- . \| wc -l`                                                                              | `26`     |
| 19  | 53     | 위 경로 문자열의 저장소 전체 매치 수                                    | `git grep -o "enforcement-v1.md" -- . \| wc -l`                                                                              | `53`     |
| 20  | 19     | 느슨한 단어 "known-gaps"(확장자 없이)를 참조하는 파일 수                | `git grep -l "known-gaps" -- . \| wc -l`                                                                                     | `19`     |
| 21  | 42     | 위 느슨한 단어의 저장소 전체 매치 수                                    | `git grep -o "known-gaps" -- . \| wc -l`                                                                                     | `42`     |
| 22  | 3950   | 정본 CI 총 시험 수(node scripts/check/isolated-suite-runner.mjs)        | (산식)                                                                                                                       | `3950`   |
| 23  | 3944   | 정본 CI pass 수                                                         | (산식)                                                                                                                       | `3944`   |
| 24  | 0      | 정본 CI fail 수                                                         | (산식)                                                                                                                       | `0`      |
| 25  | 6      | 정본 CI skip 수                                                         | (산식)                                                                                                                       | `6`      |
| 26  | 100    | 표 행 번호 최댓값(1~N 범위의 상한)                                      | `git grep -o -h -E '^\| *#?[0-9]+ *\|' -- docs/enforcement-known-gaps.md \| grep -o -E '[0-9]+' \| sort -n \| tail -1`       | `100`    |

## 메타 수(코드로 계산, 손으로 세지 않음)

- 표에 실린 측정 행 수: **26**
- 설계 제외 값 수: **3**

## 설계 제외 목록(측정 아님, §2 규칙4)

앵커 검증(그 근거 문구가 선언된 문서에 실제로 있는지): **3/3 확인**(2R, 값이 아니라 자리로 묶음 -- §2R 참조).

- `1` -- docs/known-gaps-index-schema-draft.md §2-2 -- schemaVersion 제안값(아직 존재하지 않는 인덱스 파일의 필드) -- 앵커: `"schemaVersion": 1,`(docs/known-gaps-index-schema-draft.md)
- `204800` -- docs/known-gaps-index-schema-draft.md §2-2 -- shardByteLimit 제안값(바이트, = 200KiB) -- 앵커: `"shardByteLimit": 204800,`(docs/known-gaps-index-schema-draft.md)
- `200` -- docs/known-gaps-split-design.md §2-3 -- shard 상한 예시(KiB 단위 표기, 204800과 동일 제안값의 다른 표기) -- 앵커: `상한(예: 200KiB`(docs/known-gaps-split-design.md)

## 누락 리포트(문서 본문 강조 수 vs 표)

정의: `docs/known-gaps-split-design.md`·`docs/known-gaps-index-schema-draft.md`에서 펜스 코드 블록 밖에 `**N**` 형태로 굵게 강조된 순수 숫자를 "표에 실려야 할 측정값"으로 간주한다(두 문서의 실제 서술 관행). 표에 없으면 누락으로 리포트한다 -- ★2R: 설계 제외 목록은 더 이상 이 판단을 거르지 않는다(위 앵커 검증으로만 쓰임, REVIEW 1R D 반려 수리). 오탐 주장 범위: fixture 3건 + 현재 실문서 2건에서 오탐 0(일반적인 오탐률 0 주장 아님).

누락 0건.
