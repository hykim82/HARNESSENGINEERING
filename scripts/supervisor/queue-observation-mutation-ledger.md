# queue-observation-adapter.mjs mutation 원장

HYK-183 v1 사이클2a (coder-task.md §3-4) -- `queue-manifest-mutation-ledger.md`와
같은 형식. 각 가드를 하나씩 무력화하고
`node --test scripts/supervisor/queue-observation-adapter.test.mjs`를 재실행해
RED가 나는지, 그 RED의 원인이 실제로 그 가드인지(실패한 테스트 이름이 그
가드를 정확히 겨냥하는지) 개별 확인했다.

**절차**: 각 행마다 (1) `queue-observation-adapter.mjs`에서 대상 가드를 무력화
(2) `node --test scripts/supervisor/queue-observation-adapter.test.mjs` 실행
(3) 실패한 테스트 이름·개수 기록 (4)
`git checkout -- scripts/supervisor/queue-observation-adapter.mjs`로 원상 복구
(5) `git diff --exit-code`로 원복 확인.

| #   | 무력화한 가드                                                                                                                                                  | 실패한 테스트 수 | RED 원인이 그 가드와 일치하는가                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **[git 수집]** `is_dirty` 계산(`toText(status.stdout).length > 0` → 항상 `false`)                                                                              | 1                | 일치 -- "untracked file added only -> WORKTREE_DIRTY" 테스트가 `START_ALLOWED`를 얻어 실패                                                                                                                                       |
| 2   | **[git 수집]** `is_alternate_checkout` 비교(`resolvedGitDir !== resolvedCommonDir` → 항상 `false`)                                                             | 1                | 일치 -- 연결된 워크트리 테스트가 `ALTERNATE_CHECKOUT` 대신 `START_ALLOWED`를 얻어 실패                                                                                                                                           |
| 3   | **[git 수집]** `is_merge_commit` 계산(`parentCount >= 2` → 항상 `false`)                                                                                       | 5                | 일치 -- 정상 시나리오(머지 커밋에 의존하는 모든 테스트: normal/BLOB_HASH_MISMATCH/WORKTREE_DIRTY/ALTERNATE_CHECKOUT/NOT_APPROVED)가 전부 `NOT_MERGE_COMMIT`로 새서 실패. 이 가드가 이 스위트 대부분의 전제조건임을 실측으로 확인 |
| 4   | manifest 미추적 판정 가드(`!isNonEmptyString(sha)` 게이트 → `if(false)`)                                                                                       | 1                | 일치 -- "manifest file never committed -> MANIFEST_FILE_NOT_TRACKED" 테스트 실패(빈 sha로 다음 git 호출이 대신 실패해 다른 사유가 나옴 -- 여전히 그 가드가 없으면 계약이 깨진다는 증거)                                          |
| 5   | **승인 UNDECIDABLE 판정**(`resolveApproval`의 마지막 `return failure(...)`를 `return ok({ humanApproved: false })`로 치환 -- 이번 사이클에서 가장 중요한 가드) | 1                | 일치 -- "UNDECIDABLE -> collection failure, human_approved is never defaulted to false" 테스트가 정확히 그 단언에서 실패. UNDECIDABLE이 조용히 `false`로 둔갑하는 사고를 이 테스트가 유일하게 잡는다는 것을 실측으로 확인        |
| 6   | `GIT_COMMAND_FAILED` 게이트(`result.code !== 0` → `if(false)`)                                                                                                 | 1                | 일치 -- "repoRoot is not a git repository -> GIT_COMMAND_FAILED" 테스트 실패                                                                                                                                                     |
| 7   | `validateArgs`의 `repoRoot` 검사(`!isNonEmptyString(repoRoot)` → `if(false)`)                                                                                  | 2                | 일치 -- "missing repoRoot" · "repoRoot wrong type(number)" 두 인자방어 테스트 실패                                                                                                                                               |
| 8   | `parseManifestJson`의 catch 분기(실패 반환 → `return ok({ manifest: {} })`로 치환, 파싱 실패를 삼킴)                                                           | 1                | 일치 -- "broken JSON -> MANIFEST_JSON_PARSE_FAILED" 테스트 실패(깨진 JSON을 조용히 빈 객체로 둔갑시켰기 때문)                                                                                                                    |

## 원복 확인

각 행마다 `git checkout -- scripts/supervisor/queue-observation-adapter.mjs`
직후 `git diff --exit-code scripts/supervisor/queue-observation-adapter.mjs`를
실행해 종료 코드 0(차이 없음)을 확인했다. 마지막 행(#8) 이후
`node --test scripts/supervisor/queue-observation-adapter.test.mjs` 전체를
재실행해 22/22 pass, 0 fail을 재확인했다(원장 작성을 위해 코드를 약화한 채로
남겨두지 않았다).

## 다루지 않은 세부 가드 (범위 기록 -- 은폐 아님)

- `collectRepoSection`의 `head_commit`/`head_branch_name` 텍스트 추출
  (`toText`)은 개별로 무력화하지 않았다 -- 이 값이 잘못되면 코어의
  `NOT_PROTECTED_BRANCH`/`COMMIT_MISMATCH` 검사가 대신 걸려서, 결국 위 #3과
  같은 계열의 "전제조건 붕괴"로 수렴한다(대표성은 #3이 가진다).
- `manifest_blob.sha256`/`expected_sha256` 각각의 해시 계산 개별 무력화는
  하지 않았다 -- `queue-manifest-core.test.mjs`의 `BLOB_HASH_MISMATCH`
  반례(SV-3 계열)가 이미 "두 해시가 다르면 걸린다"는 코어 계약을 검증하고,
  이 어댑터 쪽에서는 "작업 트리 바이트로 하나, cat-file blob 바이트로
  다른 하나를 잰다"는 결선 자체가 §3-1 표에 그대로 반영돼 있어 정적으로
  검토 가능하다(둘 다 같은 변수로 계산하도록 실수로 합쳐지면 위 mutation
  #8과 유사하게 "항상 통과"로 새는데, 이는 스키마 정합 테스트(C절)가
  `bytes`/`sha256` 타입은 잡지만 값 동일성 위조까지는 잡지 않는다 --
  코어 테스트의 `BLOB_HASH_MISMATCH` 반례가 실제 방어선이다).
- `toGitPathArg`(경로 구분자 변환)는 무력화-복원 사이클을 별도로 돌리지
  않았다 -- 이 리포의 실측 fixture(`queue.json`, 하위 디렉터리 없음)로는
  Windows에서도 backslash 변환이 실제로 트리거되지 않는다(단일 세그먼트
  경로라 `split(path.sep).join("/")`이 사실상 no-op). 하위 디렉터리를 포함한
  manifestPath에 대한 실측은 이 사이클 범위 밖으로 남긴다(범위 기록).
