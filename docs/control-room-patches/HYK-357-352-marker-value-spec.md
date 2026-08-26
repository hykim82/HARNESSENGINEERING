# HYK-357 + HYK-352 1R 패치 문서 — `worker-dispatch-rule.md` 52행·148행 값 규격 못박기

**근거** = coder-task.md `HYK-357-352-marker-value-spec-1` §1(ⓐⓑⓒ 실측) + §2-A(문면에 반드시 들어갈 것 1·2).
**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본> --out <출력>` (⛔이 도구는 실제 관제실 경로를 절대 쓰지 않는다 — `--source`/`--out` 만 쓴다, 둘 다 파일이다).
**성격** = **두 줄 교체(replace)**. HYK-335와 달리 이번 두 단위는 `insert_after`가 아니라 `replace`다 — 기존 52행·148행 자체가 "값 규격이 없다"는 결함을 담고 있으므로 그 줄을 교체해 규격을 못박는다. 두 단위 모두 앵커 문장 자체는 그대로 남기고(문구 삭제 없음) 그 뒤에 규격 문장을 이어 붙이는 형태다 — 기존 절의 다른 부분은 한 글자도 바꾸지 않는다.

**대응**

- ⓐ(HYK-352, coder-task.md §1ⓐ) — 52행 DONE 줄에 **초 단위(`YYYY-MM-DD HH:MM:SS KST`) 형식**과 **정본 도구 `finalize-done`**을 명시 → 아래 `hyk352-done-seconds-precision` 단위
- ⓑ(HYK-357, coder-task.md §1ⓑ) — 148행에 **다섯 표지 각각의 값 규격**(특히 `for:`/`task_id:`/`verdict:`)을 명시 → 아래 `hyk357-marker-value-spec` 단위
- coder-task.md §2-A-3의 "이 파일은 claude 좌석에만 시스템 프롬프트로 실린다" 정직 한계 문장은 **어느 단위도 건드리지 않는다**(그 문장은 이 두 앵커 밖, 파일 끝부분에 있다).

⚠️**표기 주의** — 단위 블록 안의 명령 예시는 `~~~` 울타리를 쓴다. 추출 정규식이 첫 ``` 에서 끊기기 때문이며, 마크다운 렌더 결과는 동일하다(HYK-335 선례와 동일 규율).

---

## 단위 1 — ⓐ DONE 시각 초 단위 + `finalize-done` 명시 (52행)

```control-room-patch-unit
id: hyk352-done-seconds-precision
mode: replace
@@ANCHOR@@
- 미커밋 종료 금지. 완료 시 `.harness/<역할>.md`에 결과 + `>>> DONE: <역할> @ <실제 시각 KST>` 를 쓴다(시각은 그때 직접 읽어서).
@@CONTENT@@
- 미커밋 종료 금지. 완료 시 `.harness/<역할>.md`에 결과 + `>>> DONE: <역할> @ <실제 시각 KST>` 를 쓴다(시각은 그때 직접 읽어서). ★DONE 줄의 시각은 **`YYYY-MM-DD HH:MM:SS KST`**(초 단위까지) 형식이어야 한다 — 분 단위(초 생략)는 **거부**된다: 같은 분 안에서 끝난 서로 다른 라운드를 구분할 수 없기 때문이다(HYK-352 · «완화 불가»). ⚠️같은 파일의 `dropped_at`은 분 정밀도(`YYYY-MM-DD HH:MM KST`)다 — **DONE과 dropped_at의 정밀도는 다르다**, 뭉뚱그리지 마라. 정본 기록 도구는 **`finalize-done`**이다 — 형식이 틀렸는데 아직 아무도 소비하지 않았다면 손으로 고치지 말고 `finalize-done`으로 **1회 재발행**하라(손기입 금지 규율과 어긋나지 않는다).
@@END@@
```

## 단위 2 — ⓑ 다섯 표지 값 규격, 특히 `for:`/`task_id:`/`verdict:` (148행)

```control-room-patch-unit
id: hyk357-marker-value-spec
mode: replace
@@ANCHOR@@
**`for:` · `role:` · `task_id:` · `verdict:` · `>>> DONE:` 는 결과 파일 전체에서 각각 정확히 1개여야 한다. 재작업 라운드에서 이전 기록을 보존할 때 그 블록에 표지 줄을 남기지 마라**(본문·수치는 보존하되 표지만 뺀다).
@@CONTENT@@
**`for:` · `role:` · `task_id:` · `verdict:` · `>>> DONE:` 는 결과 파일 전체에서 각각 정확히 1개여야 한다. 재작업 라운드에서 이전 기록을 보존할 때 그 블록에 표지 줄을 남기지 마라**(본문·수치는 보존하되 표지만 뺀다).

★**다섯 표지 각각의 «값» 규격** (HYK-357 · 2026-08-25 실사고: `for: ORCH`를 적어 올바른 `task_id:`가 있었는데도 소비 영수증 미작성 + rejected 판정이 원장에 조용히 미기록됐다):

- `for:` = **검토자가 판정하는 CODER 라운드의 harness task_id**(예: `HYK-356-coder-1`)를 적는 칸이다. ⛔**역할명·사람 이름을 적는 칸이 아니다** — `ORCH`처럼 적으면 그 값이 `HYK-<숫자>`로 시작하지 않아 판정 불가로 거부되고, `task_id:`가 멀쩡했더라도 조용히 그쪽으로 넘어가지 않는다.
- `task_id:` = **자기 라운드 자신의 `harness_label`**(0절, `HYK-…` 형식)이다 — `for:`가 가리키는 «판정 대상 라운드»와는 **다른 값**이며, **다른 것이 정상이다**(0절과 같은 원칙: 서로 다른 이름공간을 맞대어 보지 마라).
- `verdict:` = **`approved` 또는 `rejected` 둘 중 하나만** 적는다. 다른 낱말(예: `maybe`, `보류`)은 값 규격 위반이라 조용한 무기록으로 이어진다(HYK-335 실사고와 같은 형태의 실패).
@@END@@
```
