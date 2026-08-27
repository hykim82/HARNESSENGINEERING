# HYK-274 1R 패치 문서 — 게이트-기준.md S19 문면 정정(완료 조건 3)

**근거** = coder-task.md `HYK-274-stale-screen-1` §5(완료 조건 3) + §6/§2 실측(`orca terminal read --screen`이 76초+ 미반영·입력줄 잔류로 무한정 낡을 수 있다는 재현).
**적용 방식** = `node scripts/check/control-room-patch-apply.mjs --doc <이 문서> --source <원본> --out <출력>` (⛔이 도구는 실제 관제실 경로를 절대 쓰지 않는다 — `--source`/`--out`만 쓴다, 둘 다 파일이다). **적용은 ORCH가 한다** — 이 워커는 라이브 `D:\문서관리\하네스-관제실\게이트-기준.md`를 열지도 고치지도 않았다.
**성격** = **세 줄 교체(replace)**. S19 행 자체가 "배달 직후 착수 확인 = 화면으로"라고 못박은 게 지금은 사실이 아니다(coder.md 실측: `dispatch-start-confirm-cli.mjs`+`dispatch-start-size-core.mjs`가 이미 화면 대신 세션 기록 파일 크기로 그 확인을 기계화했다, orca 호출 0) — 그 문면을 사실과 맞춘다. ⓐ(메뉴 잔류 확인 = 화면으로)와 ⓑ(MCP 실측 근거)는 **건드리지 않는다** — 메뉴 잔류는 화면 렌더 자체가 증거라 이 조각의 결함(화면이 «낡을» 수 있다는 지연 문제)과 다른 성격이다.

**대응**

- 단위 1(`hyk274-s19-c-not-screen-only`) — ⓒ절 "화면으로 1회 확인한다"를 "1회 확인한다 + ⛔«화면으로»가 아니다 + 정본 방법 명시"로 교체.
- 단위 2(`hyk274-s19-checklist-column`) — "볼 것" 열의 "배달 직후 착수 확인 1회를 했는지"에 "세션 기록 파일 크기 증가로(화면이 아니라)"를 끼워 넣는다.
- 단위 3(`hyk274-s19-hyk272-annotation`) — "기계화 대상" 목록의 HYK-272 항목에 "★HYK-274 실측: 이미 세션 로그 크기 기반으로 기계화됨"을 덧붙인다(이 이슈가 그 기계화가 이미 있었음을 확인한 실측이므로).

**before/applied fixture** = `scripts/check/fixtures/control-room-gate-criteria-2026-08-27-hyk274-s19-before.md.txt`(SHA-256 `adc735bfc0ddc22206fbac9bb321cb302db0586c04d24ae134fe15f2af74f7dd`, 라이브 `게이트-기준.md` 11행과 byte-identical — 2026-08-27 23시대 직접 대조 확인) / `…-applied.md.txt`(SHA-256 `b836bccc3492ef7ab44d9e01cb23332f94d685c2be2bad944d8804e6a2d7ea1c`).

---

## 단위 1 — ⓒ절: "화면으로"를 지우고 정본 방법을 명시

```control-room-patch-unit
id: hyk274-s19-c-not-screen-only
mode: replace
@@ANCHOR@@
★**ⓒ 배달 직후 «워커가 실제로 움직였는지」를 화면으로 1회 확인한다**(완료 감시와 «별개» — 완료 감시는 «끝났는가»만 보고 «시작했는가»는 못 본다).
@@CONTENT@@
★**ⓒ 배달 직후 «워커가 실제로 움직였는지」를 1회 확인한다**(완료 감시와 «별개» — 완료 감시는 «끝났는가»만 보고 «시작했는가»는 못 본다). ⛔**«화면으로»가 아니다**(HYK-274 · 2026-08-27 실측 반영) — `orca terminal read --screen`은 76초+ 미반영·입력줄 잔류 등으로 무한정 낡을 수 있어 이 확인의 단독 근거가 될 수 없다. 정본 방법 = **세션 기록 파일 총 바이트 수 증가**(`dispatch-start-confirm-cli.mjs` + `dispatch-start-size-core.mjs`, orca 호출 0)로 «시작함/시작 못 함/시작 후 멈춤» 3상태를 판정한다 — 배달 경로에 이미 결선되어 있다.
@@END@@
```

## 단위 2 — "볼 것" 열: 확인 방법 명시

```control-room-patch-unit
id: hyk274-s19-checklist-column
mode: replace
@@ANCHOR@@
배달 직후 착수 확인 1회를 했는지
@@CONTENT@@
배달 직후 착수 확인 1회를 **세션 기록 파일 크기 증가로**(화면이 아니라) 했는지
@@END@@
```

## 단위 3 — 기계화 대상 HYK-272 각주

```control-room-patch-unit
id: hyk274-s19-hyk272-annotation
mode: replace
@@ANCHOR@@
**HYK-272**(배달기가 제출을 확인하지 않음)
@@CONTENT@@
**HYK-272**(배달기가 제출을 확인하지 않음, ★HYK-274 실측: 이미 세션 로그 크기 기반으로 기계화됨)
@@END@@
```
