import { existsSync, readFileSync } from "node:fs";
import { readRegistryDiagnostics } from "../check/seat-origin-registry.mjs";
import {
  SEAT_BIND_REASON,
  KNOWN_SEAT_ROLES,
  DELIVERY_BIND_VERDICT,
  decideSeatBindAtDelivery,
  normalizeRole,
  parseTerminalListText,
  selectRoleBoundSeat,
  summarizeReceiptBindings,
} from "./seat-role-bind-core.mjs";

// HYK-402 S1 (seat-role-s1-1) -- 역할 결속 좌석 선별 CLI. 판단은 전부
// seat-role-bind-core.mjs(순수 함수) 몫이고, 이 파일은 «파일 읽기 + 출력 +
// 종료코드»만 한다.
//
// 이 CLI 는 `orca` 를 부르지 않는다(spawn 0 · orca-adapter import 0) -- 배달기가
// 이미 받은 `orca terminal list --json` 출력을 파일로 저장해 `--terminal-list`
// 로 넘긴다(이미 쓰는 좌석 증명 게이트의 `--dispatch-show`/`--terminal-show`
// 파일 입력 관례와 같다). 그래서 orca 조회가 한 번도 늘지 않는다.
//
// 종료코드: 0 = SELECTED(또는 집계 완료) · 1 = REFUSED(거부 -- 사유와 후보
// 좌석 `pane=role` 이 stdout 에 나온다) · 2 = 사용법 오류(인자 누락 · 모르는
// 인자 · 모르는 역할; 사유는 stderr).
//
// S1 만으로는 살아 있는 배달이 바뀌지 않는다: 이 CLI 를 배달기가 부르도록
// 결선하는 일(S2 · 관제실 dispatch-worker.ps1 변경)은 이 라운드 범위 밖이다.
// 칠 정확한 줄은 docs/control-room-patches/HYK-402-seat-role-bind-s1.md.
//
// HYK-402 S2 (seat-role-s2-1): `--record-only` 모드 -- 배달 «순간» 판정을 기록용으로만
// 낸다. 종료코드는 «언제나 0» (사용법 오류 · 깨진 입력 · 예외도 0 -- 판정은 stdout
// 한 줄 JSON `{"seat_bind":{verdict,reason,...}}` 의 verdict 가 말한다). 어떤 경우에도
// 배달기를 막지 않는다: 판정 실패는 ERROR · 근거 없음은 UNDECIDABLE 로 «적힌다».
// S1 의 거부 문면 대신 쓰는 패치는 docs/control-room-patches/HYK-402-seat-role-bind-s2.md.

export const USAGE =
  "usage: seat-role-bind-cli.mjs --terminal-list <json file> --worktree <path> --role <CODER|REVIEW|VERIFY|PM> --registry-path <jsonl> [--handle <handle>]\n" +
  "       seat-role-bind-cli.mjs --audit-receipts <receipts.jsonl> --registry-path <jsonl>   (읽기 전용 집계)\n" +
  "  --terminal-list 는 `orca terminal list --json` 출력을 저장한 파일이다(이 CLI 는 orca 를 실행하지 않는다).\n" +
  "  exit 0 = SELECTED / 집계 완료 · 1 = REFUSED · 2 = 사용법 오류.";

const FLAG_TO_FIELD = Object.freeze({
  "--terminal-list": "terminalList",
  "--worktree": "worktree",
  "--role": "role",
  "--registry-path": "registryPath",
  "--handle": "handle",
  "--audit-receipts": "auditReceipts",
});

function parseArgv(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const field = FLAG_TO_FIELD[argv[i]];
    if (!field) return { error: `unrecognized argument '${argv[i]}'` };
    const value = argv[i + 1];
    if (typeof value !== "string" || value === "" || value.startsWith("--")) {
      return { error: `flag '${argv[i]}' needs a value` };
    }
    parsed[field] = value;
    i += 1;
  }
  return { parsed };
}

function validateSelectMode(p) {
  const missing = ["terminalList", "worktree", "role", "registryPath"].filter(
    (k) => !p[k],
  );
  if (missing.length > 0) {
    return `missing required flag(s) for select mode: ${missing.join(", ")}`;
  }
  if (!KNOWN_SEAT_ROLES.includes(normalizeRole(p.role))) {
    return `unknown role '${p.role}' (expected ${KNOWN_SEAT_ROLES.join("|")})`;
  }
  return null;
}

function validateMode(p) {
  if (p.auditReceipts) {
    if (!p.registryPath) return "audit mode needs --registry-path";
    const stray = ["terminalList", "worktree", "role", "handle"].filter(
      (k) => p[k],
    );
    return stray.length > 0
      ? `audit mode does not take select-mode flag(s): ${stray.join(", ")}`
      : null;
  }
  return validateSelectMode(p);
}

function loadRegistry(registryPath) {
  if (!existsSync(registryPath)) {
    return {
      ok: false,
      detail: `seat registry '${registryPath}' does not exist`,
    };
  }
  try {
    const { records, corruptedLineCount } =
      readRegistryDiagnostics(registryPath);
    return { ok: true, records, corruptedLineCount };
  } catch (err) {
    return { ok: false, detail: `seat registry unreadable (${err.message})` };
  }
}

function refusedText(reason, detail, seats = [], ctx = {}) {
  const header =
    `REFUSED reason=${reason}` +
    (ctx.worktree ? ` worktree=${ctx.worktree}` : "") +
    (ctx.role ? ` requested_role=${ctx.role}` : "") +
    ` detail=${detail}`;
  const lines = seats.map(
    (s) =>
      `  seat pane=${s.paneKey || "(none)"} role=${s.role} state=${s.state} handle=${s.handle}`,
  );
  return [header, ...lines].join("\n");
}

function runSelect(p) {
  const role = normalizeRole(p.role);
  const ctx = { worktree: p.worktree, role };
  let listText;
  try {
    listText = readFileSync(p.terminalList, "utf8");
  } catch (err) {
    return {
      exitCode: 1,
      stdout: refusedText(
        SEAT_BIND_REASON.TERMINAL_LIST_INVALID,
        `terminal list file unreadable (${err.message})`,
        [],
        ctx,
      ),
    };
  }
  const list = parseTerminalListText(listText);
  if (!list.ok) {
    return {
      exitCode: 1,
      stdout: refusedText(
        SEAT_BIND_REASON.TERMINAL_LIST_INVALID,
        list.detail,
        [],
        ctx,
      ),
    };
  }
  const registry = loadRegistry(p.registryPath);
  if (!registry.ok) {
    return {
      exitCode: 1,
      stdout: refusedText(
        SEAT_BIND_REASON.REGISTRY_LOAD_FAILED,
        registry.detail,
        [],
        ctx,
      ),
    };
  }
  const decision = selectRoleBoundSeat({
    terminals: list.terminals,
    worktree: p.worktree,
    role,
    registryRecords: registry.records,
    handle: p.handle,
  });
  if (!decision.ok) {
    const corrupted =
      registry.corruptedLineCount > 0
        ? `\n  registry_corrupted_lines=${registry.corruptedLineCount}`
        : "";
    return {
      exitCode: 1,
      stdout:
        refusedText(decision.reason, decision.detail, decision.seats, ctx) +
        corrupted,
    };
  }
  const corruptedSuffix =
    registry.corruptedLineCount > 0
      ? ` registry_corrupted_lines=${registry.corruptedLineCount}`
      : "";
  return {
    exitCode: 0,
    stdout:
      `SELECTED handle=${decision.handle} pane=${decision.paneKey} role=${decision.role}` +
      ` worktree=${p.worktree}${corruptedSuffix}`,
  };
}

// 영수증 원장은 «읽기만» 한다 -- 한 줄도 다시 쓰지 않고, 손상된 줄은 건수로만
// 드러낸다.
function readJsonlDiagnostics(path) {
  const records = [];
  let corrupted = 0;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      corrupted += 1;
    }
  }
  return { records, corrupted };
}

function formatAudit(summary, meta) {
  const c = summary.counts;
  const s = summary.sinceRegistryStart;
  const reasons = Object.entries(summary.undecidableByReason)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return [
    `AUDIT receipts=${summary.total} registry_records=${meta.registryRecords}` +
      ` registry_corrupted_lines=${meta.registryCorrupted} receipts_corrupted_lines=${meta.receiptsCorrupted}`,
    `PERIOD first=${summary.period.first} last=${summary.period.last} registry_first_launched_at=${summary.period.registryFirst}`,
    `COUNTS MATCH=${c.MATCH} MISMATCH=${c.MISMATCH} UNDECIDABLE=${c.UNDECIDABLE} SKIPPED_CORRECTION=${c.SKIPPED_CORRECTION}`,
    `UNDECIDABLE_BY_REASON ${reasons || "(none)"}`,
    `SINCE_REGISTRY_START receipts=${s.receipts} MATCH=${s.counts.MATCH} MISMATCH=${s.counts.MISMATCH} UNDECIDABLE=${s.counts.UNDECIDABLE} SKIPPED_CORRECTION=${s.counts.SKIPPED_CORRECTION}`,
    `MISMATCH_DISPATCH_IDS ${summary.mismatchDispatchIds.join(" ") || "(none)"}`,
  ].join("\n");
}

function runAudit(p) {
  const registry = loadRegistry(p.registryPath);
  if (!registry.ok) {
    return {
      exitCode: 1,
      stdout: refusedText(
        SEAT_BIND_REASON.REGISTRY_LOAD_FAILED,
        registry.detail,
      ),
    };
  }
  let receipts;
  try {
    receipts = readJsonlDiagnostics(p.auditReceipts);
  } catch (err) {
    return {
      exitCode: 1,
      stdout: `REFUSED reason=RECEIPTS_UNREADABLE detail=${err.message}`,
    };
  }
  const summary = summarizeReceiptBindings(receipts.records, registry.records);
  return {
    exitCode: 0,
    stdout: formatAudit(summary, {
      registryRecords: registry.records.length,
      registryCorrupted: registry.corruptedLineCount,
      receiptsCorrupted: receipts.corrupted,
    }),
  };
}

// ---- S2: 배달 순간 «기록만» 모드 ------------------------------------------------

const RECORD_ONLY_FLAG_TO_FIELD = Object.freeze({
  "--terminal-list": "terminalList",
  "--worktree": "worktree",
  "--role": "role",
  "--registry-path": "registryPath",
  "--handle": "handle",
  "--delivered-at-ms": "deliveredAtMs",
});

function recordOnlyVerdict(verdict, reason, extra = {}) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      seat_bind: { verdict, reason, candidates: "", ...extra },
    }),
    stderr: "",
  };
}

function parseRecordOnlyArgv(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--record-only") continue;
    const field = RECORD_ONLY_FLAG_TO_FIELD[argv[i]];
    if (!field) return { error: `unrecognized argument '${argv[i]}'` };
    const value = argv[i + 1];
    if (typeof value !== "string" || value === "" || value.startsWith("--")) {
      return { error: `flag '${argv[i]}' needs a value` };
    }
    parsed[field] = value;
    i += 1;
  }
  return { parsed };
}

function loadRecordOnlyRegistry(registryPath) {
  if (!existsSync(registryPath)) {
    return { fail: recordOnlyVerdict("UNDECIDABLE", "REGISTRY_ABSENT") };
  }
  try {
    const { records, corruptedLineCount } =
      readRegistryDiagnostics(registryPath);
    return { records, corruptedLineCount };
  } catch {
    return { fail: recordOnlyVerdict("ERROR", "REGISTRY_UNREADABLE") };
  }
}

function runRecordOnlyBody(argv) {
  const { parsed, error } = parseRecordOnlyArgv(argv);
  if (error) return recordOnlyVerdict("ERROR", "RECORD_ONLY_ARGS_INVALID");
  const missing = ["terminalList", "worktree", "role", "registryPath"].filter(
    (k) => !parsed[k],
  );
  if (missing.length > 0)
    return recordOnlyVerdict("ERROR", "RECORD_ONLY_ARGS_MISSING");
  let deliveredAtMs;
  if (parsed.deliveredAtMs !== undefined) {
    deliveredAtMs = Number(parsed.deliveredAtMs);
    if (!Number.isFinite(deliveredAtMs) || deliveredAtMs <= 0)
      return recordOnlyVerdict("ERROR", "DELIVERED_AT_INVALID");
  } else {
    deliveredAtMs = Date.now();
  }
  let listText;
  try {
    listText = readFileSync(parsed.terminalList, "utf8");
  } catch {
    return recordOnlyVerdict("ERROR", SEAT_BIND_REASON.TERMINAL_LIST_INVALID);
  }
  const list = parseTerminalListText(listText);
  if (!list.ok)
    return recordOnlyVerdict("ERROR", SEAT_BIND_REASON.TERMINAL_LIST_INVALID);
  const registry = loadRecordOnlyRegistry(parsed.registryPath);
  if (registry.fail) return registry.fail;
  const d = decideSeatBindAtDelivery({
    terminals: list.terminals,
    worktree: parsed.worktree,
    role: parsed.role,
    registryRecords: registry.records,
    handle: parsed.handle,
    deliveredAtMs,
  });
  return recordOnlyVerdict(d.verdict, d.reason, {
    candidates: d.candidates,
    delivered_at_ms: deliveredAtMs,
    registry_records: registry.records.length,
    registry_corrupted_lines: registry.corruptedLineCount,
    ...(d.selectReason ? { select_reason: d.selectReason } : {}),
  });
}

// 어떤 예외도 «종료코드 0 + ERROR JSON» 으로 접는다(배달기를 막지 않는다).
export function runRecordOnly(argv) {
  try {
    return runRecordOnlyBody(argv);
  } catch {
    return recordOnlyVerdict(
      DELIVERY_BIND_VERDICT.ERROR,
      "RECORD_ONLY_EXCEPTION",
    );
  }
}

// argv -> { exitCode, stdout, stderr }. 파일 읽기 외 부작용 0.
export function runSeatRoleBindCli(argv) {
  if (argv.includes("--help"))
    return { exitCode: 0, stdout: USAGE, stderr: "" };
  if (argv.includes("--record-only")) return runRecordOnly(argv);
  const { parsed, error } = parseArgv(argv);
  const problem = error ?? (parsed ? validateMode(parsed) : null);
  if (problem) {
    return { exitCode: 2, stdout: "", stderr: `${problem}\n${USAGE}` };
  }
  const result = parsed.auditReceipts ? runAudit(parsed) : runSelect(parsed);
  return { ...result, stderr: "" };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/seat-role-bind-cli.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  let result;
  try {
    result = runSeatRoleBindCli(argv);
  } catch (err) {
    // S1 모드의 예외는 지금까지처럼 터진다. record-only 만 «0 + ERROR» 로 접는다.
    if (!argv.includes("--record-only")) throw err;
    result = recordOnlyVerdict("ERROR", "RECORD_ONLY_EXCEPTION");
  }
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
