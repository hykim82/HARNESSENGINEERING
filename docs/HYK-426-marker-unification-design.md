# HYK-426 — done-stamp 마커 판독 문법 단일화

## 1. 막다른 모양 (수리 전)

`scripts/check/relay-handshake.mjs`의 소비자는 `done_stamped_by: finalize-done`
마커를 **칼럼 0**에서만 인정했다(`DONE_STAMPED_BY_MARKER_RE`,
`/^done_stamped_by:\s*finalize-done\s*$/im`, 당시 relay-handshake.mjs:402). 복구
도구인 `scripts/relay/finalize-done.mjs`의 `hasFinalizeDoneMarker`는 그 자리의
있고 없음을 `rawLine.trim() === FINALIZE_DONE_MARKER_LINE`으로만 판별했다(당시
finalize-done.mjs:86-90).

마커 줄 앞에 공백 한 칸이라도 붙으면(예: ` done_stamped_by: finalize-done`):

- 소비자 쪽: `^`은 칼럼 0만 고정하므로 매치 실패 → "마커 없음" → 거부
  (`relay-handshake: ... DONE line has no finalize-done marker`).
- 도구 쪽: `trim()`이 앞 공백을 지우므로 매치 성공 → "마커 있음" →
  `unmarkedWellFormedSingle`이 거짓이 되어 복구 갈래(`REPLACED_UNMARKED`)로
  들어가지 못하고 `ALREADY_FINALIZED`로 거부(`finalize-done never
overwrites`).

두 쪽 다 거부 → 그 라운드는 영구히 소비되지 않는다(file_unchanged=true,
사람 손 개입 없이는 탈출 불가). 이 모양은 이 라운드 착수 전 실측으로 재현했다
(result 파일 §2 RED 먼저 칸 — CLI 두 개를 그대로 호출, 소비자 exit 1 + 도구
exit 1 ALREADY_FINALIZED).

## 2. 방향 선택 — 소비자 규칙(칼럼 0)으로 맞춘다

소비자를 `trim()`으로 느슨화하는 선택은 기각한다 — 그러면 손으로 들여 쓴
표지도 기계 도장으로 통과해, 게이트의 "기계가 직접 썼는가"라는 전제가
깨진다. 대신 **도구가 소비자의 칼럼-0 규칙을 그대로 따르게** 만든다:

1. `relay-handshake.mjs`가 `DONE_STAMPED_BY_MARKER_RE`를 그대로 두고, 같은
   판정을 하는 함수 하나를 내보낸다: `hasDoneStampedByMarker(content)`.
2. `finalize-done.mjs`는 자신의 `hasFinalizeDoneMarker`(및 그 안의
   `trim()` 비교)를 지우고, 그 자리에서 `hasDoneStampedByMarker`를 가져와
   쓴다.
3. 그 결과, 앞 공백 마커는 이제 **양쪽 모두에서 "없음"**으로 읽힌다 → 도구
   입장에서는 `unmarkedWellFormedSingle` = true → 이미 있던
   `REPLACED_UNMARKED` 복구 갈래(HYK-418 §2-3)로 들어가 한 번 더 기계
   도장을 새로 찍는다 → 그 다음 소비자 재검사는 통과한다. **새 탈출
   코드는 만들지 않았다** — 기존 "마커 없는 well-formed DONE" 복구 경로를
   재사용했을 뿐이다.

## 3. "순환 import"였다는 옛 주석은 반대 방향 얘기였다

`finalize-done.mjs`의 옛 주석(수리 전 :344-347)은 "relay-handshake.mjs를
가져오면 순환(relay-handshake → finalize-done → relay-handshake)이 된다"고
적어 두고 자체 상수로 재derive했다. 그 추론은 틀렸다 — 이 파일은 이미
`DONE_RE`/`isWellFormedDoneTimestamp`/`resolveResultTaskId` 등을
`relay-handshake.mjs`에서 **같은 방향**으로 가져오고 있었다(finalize-done →
relay-handshake, 반대 방향 없음). `hasDoneStampedByMarker`를 같은 방향으로
하나 더 가져오는 것은 순환을 만들지 않는다 — 이미 있던 의존 방향을 한 번 더
쓰는 것뿐이다. 주석이 말한 "순환"은 (지금은 쓰지 않는) 반대 방향 import를
가정한 혼동이었다.

## 4. 바뀌지 않은 것

- 소비자의 `DONE_STAMPED_BY_MARKER_RE`(칼럼 0 · `im` 플래그) 자체 — 한 글자도
  안 바뀌었다.
- `>>> DONE:` 줄 판독(`DONE_RE`/`DONE_LINE_RE`) — 이미 둘 다 칼럼 0, 무변.
- first-observation(관측 뒤 재기입 금지, `ACTIVE_OBSERVATION_BLOCKED`) 게이트
  — 앞 공백 마커로 재현해도 그대로 막는다(관측 뒤라면 탈출 경로는 이
  라운드 범위 밖).
- 마커를 **쓰는** 쪽(`FINALIZE_DONE_MARKER_LINE`, 칼럼 0 리터럴) — 그대로
  유지. 이번 변경은 마커를 **읽는** 두 곳만 하나로 모았다.

## 5. 한계

- 탈출은 관측 **전** finalize-done 1회까지다 — 관측 **후**는 설계된
  재기입 금지(HYK-353 2R §1)이고, 이 라운드 범위 밖이다.
- 이 문서의 재현은 전부 합성(mkdtemp) 픽스처다 — 실물에서 앞 공백 마커가
  실제로 생기는 사례는 다음에 생길 때 라이브로 확인된다.
