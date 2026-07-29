# queue-manifest-core.mjs mutation 원장

HYK-183 v1 사이클1 (coder-task.md §3-3) -- 각 가드를 하나씩 무력화(`if (...)`
조건을 `if (false)`로 치환)하고 `node --test scripts/supervisor/*.test.mjs`를
재실행해 RED가 나는지, 그리고 그 RED의 원인이 실제로 그 가드인지(실패한
테스트 이름이 해당 사유 코드를 정확히 단언하는지) 개별 확인했다.

**절차**: 각 행마다 (1) `queue-manifest-core.mjs`에서 대상 가드의 조건을
`false`로 치환 (2) `node --test scripts/supervisor/*.test.mjs` 실행 (3) 실패한
테스트 이름·개수 기록 (4) `git checkout -- scripts/supervisor/queue-manifest-core.mjs`
로 원상 복구 (5) `git diff --exit-code`로 원복 확인. 마지막 열은 "실패한
테스트가 그 사유 코드를 정확히 단언하고 있었는가"를 개별 확인한 결과다(4b-2b-3
반례 -- "빨개졌다"만 보고 원인을 확인하지 않아 죽은 방어선 5개가 잘못
기록됐던 사고를 되풀이하지 않기 위함).

| #   | 무력화한 가드                                                                 | 실행한 명령                                 | 실패한 테스트 수 | RED 원인이 그 가드와 일치하는가                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `OBSERVATION_MISSING` (최상위 `isPlainObject(observation)` 게이트)            | `node --test scripts/supervisor/*.test.mjs` | 6                | 일치 -- null/undefined/문자열/숫자/배열/불리언 6종 fail-closed 테스트 전부 `OBSERVATION_MISSING`을 단언하다 실패                                                                                                                                                 |
| 2   | `hasRequiredSections` (repo/manifest_commit/manifest_blob/manifest 존재 검사) | 〃                                          | 5                | 일치 -- `{}` 및 4개 섹션 개별 결손 테스트가 `OBSERVATION_MALFORMED`를 단언하다 실패                                                                                                                                                                              |
| 3   | `NOT_PROTECTED_BRANCH`                                                        | 〃                                          | 2                | 일치 -- 전용 테스트 + "모든 START_BLOCKED는 entries=[]" 집계 테스트(이 mutator를 포함)가 실패                                                                                                                                                                    |
| 4   | `NOT_MERGE_COMMIT`                                                            | 〃                                          | 2                | 일치 -- 전용 테스트 + 집계 테스트 실패                                                                                                                                                                                                                           |
| 5   | `NOT_HUMAN_APPROVED`                                                          | 〃                                          | 1                | 일치 -- 전용 테스트만 실패(집계 테스트는 이 mutator를 포함하지 않음)                                                                                                                                                                                             |
| 6   | `COMMIT_MISMATCH`                                                             | 〃                                          | 1                | 일치                                                                                                                                                                                                                                                             |
| 7   | `BLOB_HASH_MISMATCH`                                                          | 〃                                          | 1                | 일치                                                                                                                                                                                                                                                             |
| 8   | `WORKTREE_DIRTY`                                                              | 〃                                          | 2                | 일치 -- 전용 테스트 + 집계 테스트(이 mutator 포함) 실패                                                                                                                                                                                                          |
| 9   | `ALTERNATE_CHECKOUT`                                                          | 〃                                          | 1                | 일치                                                                                                                                                                                                                                                             |
| 10  | `QUEUE_EPOCH_REGRESSED`                                                       | 〃                                          | 1                | 일치                                                                                                                                                                                                                                                             |
| 11  | `ORDINAL_DUPLICATE`                                                           | 〃                                          | 3                | 일치 -- 전용 테스트 + `previous_approved===null` 계열 재확인 테스트 + `enabled:false` 유일성 참여 테스트, 셋 다 `ORDINAL_DUPLICATE` 단언에서 실패                                                                                                                |
| 12  | `ORDINAL_NOT_MONOTONIC`                                                       | 〃                                          | 1                | 일치                                                                                                                                                                                                                                                             |
| 13  | `ISSUE_DUPLICATE`                                                             | 〃                                          | 1                | 일치                                                                                                                                                                                                                                                             |
| 14  | `ENTRY_MALFORMED` (핵심 -- 판정 순서 재설계로 도달 가능하게 만든 가드)        | 〃                                          | 3                | 일치 -- 타입오류(enabled: "true") · 필드결손(approved_merge_commit 없음) · 필드초과(priority 추가) 3개 전용 테스트가 각각 `ENTRY_MALFORMED`를 단언하다 실패. 이 결과로 §3-1 설계 메모의 우려(ENTRY_MALFORMED가 죽은 방어선이 될 위험)가 해소됐음을 실측으로 확인 |
| 15  | `APPEND_ONLY_*` (REMOVED/REORDERED/MUTATED 3종을 내는 `checkAppendOnly` 호출) | 〃                                          | 4                | 일치 -- REMOVED/REORDERED/MUTATED 전용 테스트 3개 + `enabled:false` 항목의 append-only 참여 테스트, 4개 전부 실패                                                                                                                                                |
| 16  | `OBSERVATION_SCHEMA_UNSUPPORTED` (두 개의 중복 체크 모두)                     | 〃                                          | 1                | 일치                                                                                                                                                                                                                                                             |
| 17  | `MANIFEST_SCHEMA_UNSUPPORTED`                                                 | 〃                                          | 1                | 일치                                                                                                                                                                                                                                                             |

## 원복 확인

각 행마다 `git checkout -- scripts/supervisor/queue-manifest-core.mjs` 직후
`git diff --exit-code scripts/supervisor/queue-manifest-core.mjs`를 실행해
종료 코드 0(차이 없음)을 확인했다. 마지막 행(#17) 이후 전체 스위트를
재실행해 66/66 pass, 0 fail을 재확인했다(원장 작성을 위해 코드를 약화한
채로 남겨두지 않았다).

## 다루지 않은 세부 가드 (범위 기록 — 은폐 아님)

`isRepoSectionWellFormed`/`isManifestCommitSectionWellFormed`/
`isManifestBlobSectionWellFormed`/`isManifestSectionWellFormed`의 개별 필드
타입 체크(예: `repo.is_dirty`가 문자열이면 걸리는 지점)는 전부 동일한
`OBSERVATION_MALFORMED` 사유 코드로 수렴하며, 이미 `queue-manifest-core.test.mjs`의
`fail-closed:` 계열 테스트(`is_dirty as string`, `is_alternate_checkout as
string`, `queue_epoch negative`, `entries not array`, `entries contains
null`, `previous_approved missing field` 등)가 각 필드 단위로 개별 검증한다.
가드 단위로는 #2(`hasRequiredSections`)의 무력화가 이 층 전체의 진입점을
막아 대표성을 가지므로, 하위 필드별 개별 무력화-복원 사이클은 이 원장에서
반복하지 않았다. `UNDECIDABLE` 사유 코드는 이 코어의 어떤 분기에서도
사용되지 않는다(현재 구현이 모든 malformed 케이스를 위 16개 사유 중 하나로
결정적으로 분류할 수 있기 때문 -- §3-1 표에 정의는 있으나 이 사이클의
관측 스키마 범위에서는 도달 지점이 없다. 다음 사이클에서 실제 어댑터가
"판정불가"한 관측을 만들어낼 수 있다면 그때 도달 지점이 생긴다).
