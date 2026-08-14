# PM 태스크: <제목>

<!-- ORCH가 모드B(운영 위임) 시 PM 레인의 relay 디렉터리(관례: `<control room>/PM/relay/pm-task.md`)로
     드롭하는 골격. task_id·dropped_at 헤더는 relay-handshake 필수 형식과 동일.
     드롭 후 ORCH는 STATUS §1 자기 행 "PM go" 갱신 + relay-watch(있다면) 백그라운드 실행.
     이 파일은 참고용 골격이다 — 실제 사본은 각 프로젝트의 PM 레인에 배치해 쓴다. -->

```
task_id: <Linear이슈>-pm-N        ← 이슈가 없으면 ORCH가 먼저 생성(진단도 추적 대상)
dropped_at: YYYY-MM-DD HH:MM KST
type: <REPLACE_ME — B1 역질문 | B2 진단·개선안 | B3 시스템검증 중 하나>
track: <이 프로젝트의 트랙/영역 이름>
관련: Linear <이슈> · 패킷 <packet_id, 있으면> · 사이클 <관련 task_id들>
```

<!-- PM 스냅샷 봉투 안내(G5·B2/B3 필수): 아래 실제 봉투는 pm-snapshot-gate가 파싱한다.
     type: B2/B3는 필수, B1은 면제, `linear_evidence: none`을 태스크에 명시하면 B2/B3여도 면제.
     captured_at은 `YYYY-MM-DD HH:MM KST` 형식 그대로(초 금지). issue 행은 이슈당 최소 1줄. -->

```
<!-- pm-snapshot
snapshot_id: SNAP-YYYYMMDD-HHMM
captured_at: YYYY-MM-DD HH:MM KST
issue_ids: HYK-N, HYK-M
issue HYK-N: state=Todo; excerpt="REPLACE_ME 발췌"
omitted_fields: none
unknown: none
-->
```

## 증상 / 질문 — 관측된 사실만 (ORCH의 추정은 반드시 "가설:" 접두로 구분)

- 무엇이 언제(시각) 어떻게 어긋났나 / 또는 무엇을 재정의해달라:
- 증거 포인터(로그·파일 경로·커밋·이슈 코멘트·STATUS 시점):

## 스코프

- 포함:
- 제외(명시):
- (B3이면) 점검 층 목록 — 예: 훅 발화 여부 / 문서↔강제층 정합 / 게이트 커버리지 / relay 규약 준수 / 관제실↔repo 드리프트

## 산출물 요구

- **B2·B3**: 상세 보고서 = PM 산출물 폴더(관례: `<control room>/PM/산출물/<트랙>/YYYY-MM-DD-<주제>/`) — 골격: 증상 → 증거(재현) → 원인(가설→검증) → 영향 범위 → **개선안(등급 필수: [즉시]/[실행필요]/[관찰])** → 한계. [실행필요]가 있으면 위임 패킷 초안 동봉(승인란 공란 — 서명은 사람).
- **B1**: 답을 `relay/pm.md`에 직접(별도 산출물 파일 불필요). 관련 PRD/패킷 수정이 필요하면 직접 고치고 변경 이력 1줄.
- 공통: `relay/pm.md` = 상단 `task_id:` 에코 + 요약(≤5줄) + 산출물 경로 + 마지막 줄 `>>> DONE: PM @ 시각 KST`. ⛔**쓴 뒤에는 이 결과 파일을 다시 고치지 마라** — 소비 영수증이 그 시점의 지문을 기록하므로, 서식만 고쳐도 이미 소비된 라운드가 영구 «미소비»로 오판된다(HYK-244 실사고).

## 완료 기준 (검증 가능하게)

- 예: "원인을 재현 증거와 함께 특정했다" / "점검 층 전부에 PASS·FAIL·미검 판정을 붙였다(미검엔 사유)"
