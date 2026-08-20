# HYK-330 — 관제실 pm-guard 훅 매처에 `mcp__claude_ai_Linear__.*` 추가 (제안 문면)

## 적용 상태: **제안** — 이 문서는 아직 관제실에 적용되지 않았다. ORCH가

coder-task.md §3의 6단계 전례 절차(문면 → 독립 검토 → 기계 추출 →
지문·백업·파싱 검사 → 관제실 git 커밋 → 발동 관측)를 밟아야 발동한다.
⛔이 CODER 라운드는 관제실 파일을 고치지 않는다(coder-task.md §0
비타협2 "관제실 쓰기 0").

## §0 이 조각은 «저장소가 이미 아는 것을 관제실에 따라잡히게» 한다

이슈 제목만 보면 pm-guard 매처 정규식 자체가 문제처럼 보이지만,
**저장소 쪽은 이미 고쳐져 있다**(coder-task.md §1 ORCH 실측):

- `scripts/check/pm-guard.mjs:23-24` — `LINEAR_WRITE_TOOL_RE` 가
  `mcp__(linear-server|claude_ai_Linear)__(save_|create_|delete_)` 로
  **이미 두 접두사 모두** 덮는다.
- `scripts/check/enforcement-inventory.json:94` — 정본 매처 문자열이
  `Edit|Write|MultiEdit|NotebookEdit|mcp__linear-server__.*|mcp__claude_ai_Linear__.*`
  로 **이미 두 계열 모두** 있다.

빠진 곳은 **관제실 설정 파일 딱 한 줄**이다:
`D:\문서관리\하네스-관제실\.claude\settings.local.json` 15행이 아직

```
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|mcp__linear-server__.*",
```

로, `mcp__claude_ai_Linear__.*` 이 빠진 옛 모양이다. 저장소 inventory
94행이 정본이고 관제실이 그것보다 뒤처져 있다 — 이 문서는 그 간극을
메우는 패치다.

## §1 무엇이 뚫려 있는가

관제실 PM 좌석의 `PreToolUse` 훅(`pm-guard.mjs`)은 이 매처 문자열이
`mcp__claude_ai_Linear__.*` 를 포함하지 않는 한, PM 세션이
`mcp__claude_ai_Linear__save_issue` 같은 Linear 쓰기 도구를 호출해도
**애초에 훅이 발동하지 않는다** — 매처가 안 걸리면 `pm-guard.mjs` 자체가
실행되지 않으므로, 그 안의 `LINEAR_WRITE_TOOL_RE` 가 두 접두사를 다
알아도 무의미하다. 매처가 1차 방아쇠이고 정규식은 그 뒤의 2차 판정이다.

## §2 수리 방침

매처 문자열 끝에 `|mcp__claude_ai_Linear__.*` 를 추가해, 저장소
`enforcement-inventory.json:94` 의 정본 모양과 같게 만든다. 이 패치는
문자열 하나만 바꾼다 — 훅 로직, `pm-guard.mjs` 내부 정규식, 다른 훅
결선은 전혀 건드리지 않는다.

## §3 기계 적용 단위 (추출 대상, 정확히 1개)

```control-room-patch-unit
id: hyk330-pm-guard-linear-prefix
mode: replace
@@ANCHOR@@
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|mcp__linear-server__.*",
@@CONTENT@@
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|mcp__linear-server__.*|mcp__claude_ai_Linear__.*",
@@END@@
```

**개수 확인**: 위 1개가 이 문서의 진짜 추출 대상 전부다 — 이 문서 안의
다른 인용(§0의 원문 코드 블록)은 ` ```control-room-patch-unit ` 태그를
쓰지 않는 일반 인용문이므로 추출 대상이 아니다.

## §4 실측 원본

| 항목                      | 값                                                                               |
| ------------------------- | -------------------------------------------------------------------------------- |
| 대상 파일                 | `D:\문서관리\하네스-관제실\.claude\settings.local.json`                          |
| 이 문서 기준 원본 SHA-256 | `e27a1b19f07c66e1ccf1a3123c0ce7b90abd79bd201786e4ee409afa8d334bf8`               |
| 원본 크기                 | 980 바이트                                                                       |
| 줄바꿈                    | LF (CRLF 아님)                                                                   |
| 원본 신원(저장소 픽스처)  | `scripts/check/fixtures/control-room-settings-2026-08-20-hyk330-before.json.txt` |

이 문서의 앵커는 이 SHA-256의 원문을 기준으로 잡았다. 관제실 파일이 이
값과 다르면(그 사이 다른 변경이 있었다면) §3의 도구가 앵커 검색에서
`ANCHOR_NOT_FOUND` 로 fail-closed 거부한다.

## §5 저장소 쪽 시험 — 「문서 → 적용본」재현 + 실제 매처 효과 검증

### 도구로 재현

```powershell
node scripts/check/control-room-patch-apply.mjs --doc docs/control-room-patches/HYK-330-pm-guard-linear-prefix.md --source scripts/check/fixtures/control-room-settings-2026-08-20-hyk330-before.json.txt --out <임시경로>
```

출력은
`scripts/check/fixtures/control-room-settings-2026-08-20-hyk330-applied.json.txt`
와 바이트 동일해야 한다
(`scripts/check/control-room-patch-apply-hyk330-collect.test.mjs` 가 고정).

### 효과 시험

`scripts/check/control-room-patch-apply-hyk330-effect.test.mjs` 가 적용본
JSON을 파싱해 `hooks.PreToolUse[0].matcher` 문자열을 정규식으로 만들어,
`mcp__claude_ai_Linear__save_issue` 는 **매치하고**,
`mcp__claude_ai_Linear__get_issue`(읽기 도구)는 **매치하지 않음**을
고정한다. ⛔실제 Linear MCP 도구는 호출하지 않는다 — 매처 문자열을
정규식으로 만들어 이름 문자열에 대조할 뿐이다.

## §6 정직 표기 — 이름 목록 매칭은 2차 층이고, 원리적으로 새 커넥터를 못 덮는다

이 패치는 관제실 훅의 **방아쇠(매처)** 를 저장소 정본과 맞출 뿐이다.
`pm-guard.mjs` 자신의 주석(6-24행)과 `enforcement-inventory.json` 의
`hyk267_layer_note` 가 이미 밝히듯, 매처 문자열이든 그 안의
`LINEAR_WRITE_TOOL_RE` 든 **이름 목록 매칭은 2차 방어층**이다 —
오늘 아는 두 커넥터(`linear-server`, `claude_ai_Linear`)의 접두사만
막을 뿐, 내일 새 이름의 3번째 MCP 커넥터가 같은 Linear 쓰기 능력을
노출하면 이 매처도 이 패치도 그 커넥터를 모른 채 그대로 통과시킨다.
**1차 방어는 PM 세션을 애초에 빈 MCP 설정으로 띄워 `mcp__*` 도구
자체가 존재하지 않게 하는 것**이며, 그 층은 세션 launch line에 있고
이 저장소도 이 패치도 그것을 검증할 수 없다. 이 패치를 적용했다고
"Linear 쓰기가 막혔다"로 읽지 말고, "오늘 아는 두 접두사가 막혔다"로
읽어야 한다.

## §7 ORCH 적용 절차 (coder-task.md §3 전례, HYK-286과 동일 6단계)

1. **지문 대조**: 적용 전 관제실 `settings.local.json` 의 SHA-256이
   §4 표의 값과 같은지 확인.
2. **백업**: 타임스탬프 붙은 사본으로 복사.
3. §3 도구 실행. `exit 0` 아니면 여기서 멈춘다(`--out` 미기록이므로
   원본은 안전).
4. **파싱 검사**: `JSON.parse` 로 `--out` 이 유효한 JSON인지 확인.
5. 통과하면 `--out` 내용을 관제실 실물 경로로 덮어쓰고 git add/commit
   (관제실이 git 저장소라면 — 아니면 파일만 교체).
6. **발동 관측**: PM 세션에서 `mcp__claude_ai_Linear__save_issue` 류
   호출을 1회 시도(또는 관측)해, 훅이 실제로 발동하는지 확인(이 라운드
   범위 밖 — ORCH 몫). ⛔이 CODER 라운드는 실제 도구 호출을 하지
   않는다(coder-task.md §0 비타협7).

## ⛔하지 않은 것

- 관제실 파일 수정(ORCH 몫) — 이 라운드는 저장소 안 문서·픽스처·
  시험만 건드렸다.
- `pm-guard.mjs` 내부 `LINEAR_WRITE_TOOL_RE` 나 다른 훅 결선 변경 —
  저장소 쪽은 이미 정본(HYK-273/HYK-267)이므로 무변경.
- 실제 Linear MCP 쓰기 도구 호출 — 매처 문자열을 정규식으로만 시험했다.
- 3번째 이후 커넥터에 대한 새 위조 방어 — §6 정직 한계 그대로, 새로
  만들지 않았다.
