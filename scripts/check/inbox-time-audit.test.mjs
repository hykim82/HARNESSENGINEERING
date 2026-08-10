// HYK-186 2R §4-4 -- fixtures synthesized entirely inside a mkdtemp
// directory (never reads D:\문서관리\통역\받는함\ -- the exact 2026-08-05
// CI incident this task's own instructions warn against re-triggering).
// Portability: this test only relies on (a) each file's REAL birthtime (set
// by the OS at creation, read-only, works identically on Windows/Linux) and
// (b) mtime, which IS settable cross-platform via fs.utimesSync -- it never
// attempts to fabricate a birthtime, sidestepping the Linux
// no-settable-birthtime gap entirely.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  utimesSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  auditFile,
  auditDirectory,
  formatAuditLine,
} from "./inbox-time-audit.mjs";
import { INBOX_AUDIT_VERDICT } from "./inbox-time-audit-core.mjs";

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-time-audit-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Builds today's HH:MM header text so extractHeaderTimeMs's day-anchor
// (derived from the file's own real creation date) lines up regardless of
// what day this test happens to run on.
function headerFor(date, hh, mm) {
  return `시각: ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}\n본문\n`;
}

test("0104-형 반례(합성): 헤더가 실제 CreationTime보다 55분 이른 시각을 주장 -> MISMATCH", () => {
  withDir((dir) => {
    const now = new Date();
    // header claims 55 minutes BEFORE the real (now) creation time.
    const claimed = new Date(now.getTime() - 55 * 60 * 1000);
    const path = join(dir, "0104-sample.txt");
    writeFileSync(
      path,
      headerFor(now, claimed.getHours(), claimed.getMinutes()),
      "utf8",
    );
    const entry = auditFile({ filePath: path, basename: "0104-sample.txt" });
    assert.equal(entry.verdict, INBOX_AUDIT_VERDICT.MISMATCH);
    const line = formatAuditLine(entry);
    assert.match(line, /MISMATCH/);
    assert.match(line, /어긋남/);
  });
});

test("0303-형 반례(합성): 헤더는 실제 CreationTime과 일치하지만, 이후 파일 이동으로 mtime이 26분 늦어짐 -> NORMAL (mtime 단독이면 오탐)", () => {
  withDir((dir) => {
    const now = new Date();
    const path = join(dir, "0303-sample.txt");
    writeFileSync(
      path,
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );
    const created = statSync(path); // real birthtime, captured before the move

    // 처리됨\ 폴더로 "이동"을 흉내: mtime만 +26분 뒤로 미룬다(atime도 함께
    // 넘겨야 하는 utimesSync 계약이라 동일 값을 준다). birthtime은
    // utimesSync로 건드릴 수 없다(플랫폼 무관 -- 그래서 이 시험은 그것을
    // 시도조차 하지 않는다).
    const movedMtime = new Date(created.mtimeMs + 26 * 60 * 1000);
    utimesSync(path, movedMtime, movedMtime);

    const entry = auditFile({ filePath: path, basename: "0303-sample.txt" });
    assert.equal(
      entry.verdict,
      INBOX_AUDIT_VERDICT.NORMAL,
      `expected NORMAL (creationTime corroborates header), got ${entry.verdict}/${entry.reasonCode}`,
    );
    const line = formatAuditLine(entry);
    assert.match(line, /NORMAL/);
    assert.match(line, /mtime은 보조로만 봄/);
  });
});

test("auditDirectory + groupByFilenameMinute: 동일 분(파일명) 파일이 둘이면 병합 없이 둘 다 감사된다", () => {
  withDir((dir) => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    writeFileSync(
      join(dir, `${hh}${mm}-a.txt`),
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );
    writeFileSync(
      join(dir, `${hh}${mm}-b.txt`),
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );

    const { entries, groups } = auditDirectory({ dir });
    assert.equal(entries.length, 2);
    const key = `${hh}${mm}`;
    assert.equal(
      groups.get(key).length,
      2,
      "both same-minute files must survive the group, not be collapsed to one",
    );
  });
});

test("헤더를 못 찾는 파일 -> UNDECIDABLE (정상으로 조용히 접지 않음), formatAuditLine이 사람 말로 보여줌", () => {
  withDir((dir) => {
    const path = join(dir, "nohints.txt");
    writeFileSync(path, "본문에 시각 정보가 전혀 없음\n", "utf8");
    const entry = auditFile({ filePath: path, basename: "nohints.txt" });
    assert.equal(entry.verdict, INBOX_AUDIT_VERDICT.UNDECIDABLE);
    assert.match(formatAuditLine(entry), /UNDECIDABLE/);
  });
});

// ---------------------------------------------------------------------------
// HYK-186 3R P1-3 -- durable report artifact (독립 검토 반려: stdout만으로는
// "로그에만 남는 것", 도달 요건 미충족).
// ---------------------------------------------------------------------------
import { readFileSync, existsSync, mkdirSync as _mkdirSync } from "node:fs";
import { dirname as _dirname } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  buildAuditReportBatch,
  writeAuditReport,
} from "./inbox-time-audit.mjs";

const CLI_PATH = join(
  _dirname(_fileURLToPath(import.meta.url)),
  "inbox-time-audit.mjs",
);

test("writeAuditReport: report file absent -> created with a header line + one batch, APPEND policy (never overwritten)", () => {
  withDir((dir) => {
    const reportPath = join(dir, "audit-report.md");
    assert.equal(existsSync(reportPath), false);
    writeAuditReport({
      reportPath,
      batchText: buildAuditReportBatch({
        entries: [],
        runAtMs: Date.parse("2026-08-10T00:00:00.000Z"),
        dir: "/inbox-1",
      }),
    });
    const content = readFileSync(reportPath, "utf8");
    assert.match(content, /^# inbox-time-audit durable report \(append-only/);
    assert.match(
      content,
      /## Audit run 2026-08-10T00:00:00\.000Z \(dir: \/inbox-1\)/,
    );
  });
});

test("writeAuditReport: two runs (even inside the same minute) both survive -- append, not overwrite/dedupe", () => {
  withDir((dir) => {
    const reportPath = join(dir, "audit-report.md");
    const runA = Date.parse("2026-08-10T00:00:00.100Z");
    const runB = Date.parse("2026-08-10T00:00:00.900Z"); // same minute, different ms
    writeAuditReport({
      reportPath,
      batchText: buildAuditReportBatch({
        entries: [],
        runAtMs: runA,
        dir: "/inbox-1",
      }),
    });
    writeAuditReport({
      reportPath,
      batchText: buildAuditReportBatch({
        entries: [],
        runAtMs: runB,
        dir: "/inbox-1",
      }),
    });
    const content = readFileSync(reportPath, "utf8");
    assert.match(content, /Audit run 2026-08-10T00:00:00\.100Z/);
    assert.match(content, /Audit run 2026-08-10T00:00:00\.900Z/);
    // header line ("# inbox-time-audit...") must appear exactly once --
    // the second run must NOT re-truncate/re-create the file.
    const headerCount =
      content.split("# inbox-time-audit durable report").length - 1;
    assert.equal(
      headerCount,
      1,
      "the file-level header must not be duplicated or the file re-created on the second run",
    );
  });
});

test("buildAuditReportBatch: human-readable formatAuditLine sentences are embedded verbatim in the durable batch", () => {
  withDir((dir) => {
    const now = new Date();
    const claimed = new Date(now.getTime() - 55 * 60 * 1000);
    const path = join(dir, "0104-sample.txt");
    writeFileSync(
      path,
      headerFor(now, claimed.getHours(), claimed.getMinutes()),
      "utf8",
    );
    const entry = auditFile({ filePath: path, basename: "0104-sample.txt" });
    const batch = buildAuditReportBatch({
      entries: [entry],
      runAtMs: Date.now(),
      dir,
    });
    assert.equal(
      batch.includes(formatAuditLine(entry)),
      true,
      "the exact same human sentence formatAuditLine produces for stdout must appear in the durable file too",
    );
  });
});

test("E2E CLI: --report <path> produces a durable file (mkdtemp-only, no D-drive literal anywhere) containing the same lines printed to stdout", () => {
  withDir((inboxDir) => {
    const now = new Date();
    writeFileSync(
      join(inboxDir, "0104-sample.txt"),
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );
    withDir((reportDir) => {
      const reportPath = join(reportDir, "report.md");
      const res = spawnSync(
        process.execPath,
        [CLI_PATH, inboxDir, "--report", reportPath],
        { encoding: "utf8" },
      );
      assert.equal(res.error, undefined);
      assert.equal(
        res.status,
        0,
        "(B) must always exit 0, even while writing the durable report",
      );
      assert.equal(
        existsSync(reportPath),
        true,
        "durable file must exist after the run",
      );
      const reportContent = readFileSync(reportPath, "utf8");
      assert.match(reportContent, /0104-sample\.txt/);
      assert.match(
        res.stdout,
        /0104-sample\.txt/,
        "stdout reach path (2R) must be unaffected by the new --report flag",
      );
    });
  });
});

// HYK-186 4R §2: superseded by the default-activation contract -- no flags
// at all now DOES create a durable report (fixed default path under
// inboxDir). This test used to assert the opposite (2R/3R's opt-in
// behavior); see the "기본 활성화" tests below for the new contract, and
// "--no-report" tests for the only way to suppress it now.
test("E2E CLI: no flags at all -> durable report is still created (default-activation, HYK-186 4R -- superseded opt-in behavior)", () => {
  withDir((inboxDir) => {
    writeFileSync(join(inboxDir, "plain.txt"), "no time hints\n", "utf8");
    const res = spawnSync(process.execPath, [CLI_PATH, inboxDir], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /durable report appended/);
    assert.equal(
      existsSync(join(inboxDir, ".inbox-time-audit-report.md")),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// ★RED 변조 (필수, §3-4): durable write 제거 -> RED.
// ---------------------------------------------------------------------------
function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once (found ${count})`,
  );
}

test("mutation (필수): writeAuditReport call removed from the CLI block -> --report produces no durable file -> RED", () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target = "      writeAuditReport({ reportPath, batchText });\n";
  assertExactlyOneMatch(src, target, "writeAuditReport call site");
  const mutated = src.replace(target, "");

  withDir((mutDir) => {
    // invokedDirectly requires argv[1] to end with
    // "scripts/check/inbox-time-audit.mjs", and this module imports
    // "./inbox-time-audit-core.mjs" by relative path -- the mutant needs
    // both the exact path suffix and a real sibling copy, or its CLI block
    // either never runs at all or crashes on MODULE_NOT_FOUND (neither is
    // the RED signal this test wants).
    const scriptsCheckDir = join(mutDir, "scripts", "check");
    _mkdirSync(scriptsCheckDir, { recursive: true });
    const mutantPath = join(scriptsCheckDir, "inbox-time-audit.mjs");
    writeFileSync(mutantPath, mutated, "utf8");
    writeFileSync(
      join(scriptsCheckDir, "inbox-time-audit-core.mjs"),
      readFileSync(
        join(_dirname(CLI_PATH), "inbox-time-audit-core.mjs"),
        "utf8",
      ),
      "utf8",
    );
    withDir((inboxDir) => {
      writeFileSync(join(inboxDir, "plain.txt"), "no time hints\n", "utf8");
      withDir((reportDir) => {
        const reportPath = join(reportDir, "report.md");
        const res = spawnSync(
          process.execPath,
          [mutantPath, inboxDir, "--report", reportPath],
          { encoding: "utf8" },
        );
        assert.equal(
          res.status,
          0,
          "RED signal is the missing file, not a crash -- exit must still be 0",
        );
        assert.equal(
          existsSync(reportPath),
          false,
          "RED: with writeAuditReport removed, --report is silently a no-op -- no durable file appears despite being requested",
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// HYK-186 3R P2 -- wire-level normal-control 확장(독립 검토 조건 목록).
// ---------------------------------------------------------------------------

// 조건4: CreationTime 부재·0값에서 filename fallback
test("P2 조건4 (creationTime=0 -> filename fallback): birthtimeMs가 0(미지원 플랫폼 관례값)이어도 creationTime을 '있는 값'으로 오판하지 않고 filename으로 폴백 -> NORMAL, 기대값=NORMAL", () => {
  withDir((dir) => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const basename = `${hh}${mm}-zero-birthtime.txt`;
    const path = join(dir, basename);
    writeFileSync(
      path,
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );
    const realStat = statSync(path);
    const fakeStatFn = () => ({ ...realStat, birthtimeMs: 0 });
    const entry = auditFile({ filePath: path, basename, statFn: fakeStatFn });
    assert.equal(
      entry.verdict,
      INBOX_AUDIT_VERDICT.NORMAL,
      `expected NORMAL via filename fallback, got ${entry.verdict}/${entry.reasonCode}`,
    );
    assert.equal(entry.details.evidence, "filenameTime");
  });
});

// 조건7: 첫 5줄 밖 header -> UNDECIDABLE (판정 불가가 정답)
test("P2 조건7 (5줄 밖 header): 시각 정보가 6번째 줄에만 있으면 파서가 못 찾음 -> UNDECIDABLE, 기대값=UNDECIDABLE(판정 불가가 정답, 오탐 아님)", () => {
  withDir((dir) => {
    const path = join(dir, "late-header.txt");
    const content =
      "줄1\n줄2\n줄3\n줄4\n줄5\n시각: 01:04 (6번째 줄, 파서 범위 밖)\n";
    writeFileSync(path, content, "utf8");
    const entry = auditFile({ filePath: path, basename: "late-header.txt" });
    assert.equal(entry.verdict, INBOX_AUDIT_VERDICT.UNDECIDABLE);
  });
});

// 조건8: CRLF/비ASCII·특수 파일명
test("P2 조건8 (CRLF + 비ASCII 파일명): CRLF 줄바꿈 헤더 + 한글/공백/괄호가 든 파일명 -> 정상 파싱 -> NORMAL, 기대값=NORMAL", () => {
  withDir((dir) => {
    const now = new Date();
    const basename = "통역 받는함 (원본) 0104.txt";
    const path = join(dir, basename);
    const crlfContent = `시각: ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}\r\n본문\r\n`;
    writeFileSync(path, crlfContent, "utf8");
    const entry = auditFile({ filePath: path, basename });
    assert.equal(
      entry.verdict,
      INBOX_AUDIT_VERDICT.NORMAL,
      `expected NORMAL, got ${entry.verdict}/${entry.reasonCode}`,
    );
  });
});

// 조건9: 디렉터리·읽기/stat 실패 -> UNDECIDABLE, 전체 실행은 죽지 않는다
test("P2 조건9 (읽기/stat 실패): statFn/readFileFn이 던지면 그 항목만 UNDECIDABLE -- 기대값=UNDECIDABLE, 다른 항목/전체 실행에 영향 없음(크래시 아님)", () => {
  withDir((dir) => {
    const path = join(dir, "unreadable.txt");
    const entry = auditFile({
      filePath: path,
      basename: "unreadable.txt",
      statFn: () => {
        throw new Error("EACCES: permission denied (synthetic)");
      },
    });
    assert.equal(entry.verdict, INBOX_AUDIT_VERDICT.UNDECIDABLE);
    assert.equal(entry.reasonCode, "READ_OR_STAT_FAILED");
    // formatAuditLine must not throw on this shape either.
    assert.doesNotThrow(() => formatAuditLine(entry));
  });
});

test("P2 조건9 (디렉터리 항목): auditDirectory가 하위 디렉터리를 만나도(readdirSync가 디렉터리도 반환) 전체 실행이 죽지 않고 그 항목만 UNDECIDABLE로 남는다", () => {
  withDir((dir) => {
    const now = new Date();
    writeFileSync(
      join(dir, "0104-file.txt"),
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );
    mkdirSync(join(dir, "subdir")); // readdirSync returns this too; readFileSync on it throws EISDIR
    const { entries } = auditDirectory({ dir });
    assert.equal(
      entries.length,
      2,
      "both the file and the directory entry are present -- no crash, no silent drop",
    );
    const fileEntry = entries.find((e) => e.basename === "0104-file.txt");
    const dirEntry = entries.find((e) => e.basename === "subdir");
    assert.equal(fileEntry.verdict, INBOX_AUDIT_VERDICT.NORMAL);
    assert.equal(
      dirEntry.verdict,
      INBOX_AUDIT_VERDICT.UNDECIDABLE,
      "the directory entry degrades to UNDECIDABLE instead of crashing the whole run",
    );
  });
});

// 조건10: 동일 분 파일 다수의 "정상" 케이스 (충돌 자체가 아니라, 그 다수가
// 전부 정상 판정을 받는 경우도 있어야 함을 보인다 -- 2R 시험은 "병합
// 안 함"만 확인했지 "다수가 전부 NORMAL"은 확인하지 않았다).
test("P2 조건10 (동일 분 다수 정상): 같은 분에 파일 3개, 전부 정상 헤더 -> 셋 다 NORMAL, 기대값=NORMAL x3, 병합 없이 각자 판정", () => {
  withDir((dir) => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    for (const suffix of ["a", "b", "c"]) {
      writeFileSync(
        join(dir, `${hh}${mm}-${suffix}.txt`),
        headerFor(now, now.getHours(), now.getMinutes()),
        "utf8",
      );
    }
    const { entries, groups } = auditDirectory({ dir });
    assert.equal(entries.length, 3);
    for (const e of entries) {
      assert.equal(
        e.verdict,
        INBOX_AUDIT_VERDICT.NORMAL,
        `${e.basename} expected NORMAL, got ${e.verdict}`,
      );
    }
    assert.equal(groups.get(`${hh}${mm}`).length, 3);
  });
});

// 조건5 (결손 절반: filename 결손, header는 있음) -- creationTime이 있으면
// filename 결손은 판정에 영향 없음(1차 증거가 이미 충분). 기대값=NORMAL.
test("P2 조건5 (filename 결손, header/creationTime 정상): 파일명에 HHMM 패턴이 없어도 creationTime이 있으니 NORMAL, 기대값=NORMAL", () => {
  withDir((dir) => {
    const now = new Date();
    const basename = "no-time-in-filename.txt";
    writeFileSync(
      join(dir, basename),
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );
    const entry = auditFile({ filePath: join(dir, basename), basename });
    assert.equal(entry.verdict, INBOX_AUDIT_VERDICT.NORMAL);
    assert.equal(
      entry.details.evidence,
      "creationTime",
      "filename 결손은 1차 증거(creationTime)가 있으면 아무 영향이 없다",
    );
  });
});

// 조건5 (나머지 절반: 중복 header) -- ★현재 파서는 "첫 매치"를 그대로
// 쓴다(모호성 감지를 하지 않는다). 이 표본은 그 현재 동작을 있는 그대로
// 고정할 뿐, "정상" 표본으로 세지 않는다 -- 아래 §제외 표에 사유와 함께
// 기재.
test("P2 조건5 (중복 header, 정직 고정용 -- N 표본에 안 셈): 헤더에 시각처럼 보이는 토큰이 2개면 첫 번째 것만 쓴다(모호성 감지 없음, 있는 그대로의 동작 고정)", () => {
  withDir((dir) => {
    const now = new Date();
    const basename = "dup-header.txt";
    const content = `시각: ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}\n다른시각: 23:59\n`;
    writeFileSync(join(dir, basename), content, "utf8");
    const entry = auditFile({ filePath: join(dir, basename), basename });
    // creationTime(now)과 첫 번째 토큰(now)이 일치하므로 NORMAL -- 두 번째
    // 토큰(23:59)은 무시된다는 것이 이 시험이 고정하는 사실.
    assert.equal(entry.verdict, INBOX_AUDIT_VERDICT.NORMAL);
  });
});

// 조건6 (잘못된 HH/MM 범위, 정직 고정용 -- N 표본에 안 셈): 크래시하지
// 않는다는 것만 확인한다(범위 검증은 이 판정기 범위 밖 -- 아래 §제외 표).
test("P2 조건6 (잘못된 HH/MM, 정직 고정용 -- N 표본에 안 셈): '99:99'류도 크래시 없이 결정론적으로 처리됨(범위 검증은 하지 않음, 있는 그대로 고정)", () => {
  withDir((dir) => {
    const basename = "bad-range.txt";
    writeFileSync(join(dir, basename), "시각: 99:99\n", "utf8");
    assert.doesNotThrow(() => {
      const entry = auditFile({ filePath: join(dir, basename), basename });
      // 어떤 verdict가 나오든(대개 MISMATCH) 예외 없이 {ok,verdict,...}
      // 형태를 반환한다는 것만 확인 -- 값 자체는 이 시험의 관심사가 아님.
      assert.equal(typeof entry.verdict, "string");
    });
  });
});

// ---------------------------------------------------------------------------
// HYK-186 4R §2 -- 합격 기준 3요소(기본 활성화 · 고정 기본 경로 · --no-report
// 명시적 끄기만) + (B) 성격 불변(exit 0 항상, 리포트 쓰기 실패 포함).
// ---------------------------------------------------------------------------
import {
  resolveReportPath,
  DEFAULT_REPORT_BASENAME,
  REPORT_PATH_ENV_VAR,
} from "./inbox-time-audit.mjs";

// --- resolveReportPath (순수 함수) ---

test("resolveReportPath: 플래그 없음 -> 고정 기본 경로 = join(dir, DEFAULT_REPORT_BASENAME)", () => {
  const result = resolveReportPath({ dir: "/some/inbox", env: {} });
  assert.equal(result, join("/some/inbox", DEFAULT_REPORT_BASENAME));
});

test("resolveReportPath: --no-report -> null (명시적 끄기만 인정)", () => {
  const result = resolveReportPath({
    dir: "/some/inbox",
    noReport: true,
    env: {},
  });
  assert.equal(result, null);
});

test("resolveReportPath: --report <path> -> 그 경로 그대로(기존 하위호환, 기본 경로 무시)", () => {
  const result = resolveReportPath({
    dir: "/some/inbox",
    explicitReportPath: "/custom/report.md",
    env: {},
  });
  assert.equal(result, "/custom/report.md");
});

test(`resolveReportPath: 환경변수(${REPORT_PATH_ENV_VAR}) override -- 명시 --report도 --no-report도 없을 때만 적용`, () => {
  const withEnv = resolveReportPath({
    dir: "/some/inbox",
    env: { [REPORT_PATH_ENV_VAR]: "/env/report.md" },
  });
  assert.equal(withEnv, "/env/report.md");
  // --report가 있으면 env보다 우선(명시가 더 강함).
  const explicitWins = resolveReportPath({
    dir: "/some/inbox",
    explicitReportPath: "/explicit/report.md",
    env: { [REPORT_PATH_ENV_VAR]: "/env/report.md" },
  });
  assert.equal(explicitWins, "/explicit/report.md");
  // --no-report가 있으면 env가 있어도 null(명시적 끄기가 최우선).
  const noReportWins = resolveReportPath({
    dir: "/some/inbox",
    noReport: true,
    env: { [REPORT_PATH_ENV_VAR]: "/env/report.md" },
  });
  assert.equal(noReportWins, null);
});

// --- 요구1: 기본 활성화 -- 플래그 없이 돌린 실제 CLI 출력 ---

test("★요구1 (기본 활성화): 플래그 없이 돌린 실제 CLI 출력 원문 -- 어디에 생겼는지 경로까지 확인", () => {
  withDir((inboxDir) => {
    const now = new Date();
    writeFileSync(
      join(inboxDir, "0104-sample.txt"),
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );
    const res = spawnSync(process.execPath, [CLI_PATH, inboxDir], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    const expectedPath = join(inboxDir, DEFAULT_REPORT_BASENAME);
    assert.match(res.stdout, /0104-sample\.txt/);
    assert.match(
      res.stdout,
      new RegExp(
        `durable report appended: ${expectedPath.replace(/[\\.]/g, "\\$&")}`,
      ),
    );
    assert.equal(
      existsSync(expectedPath),
      true,
      "the fixed-default report file must actually exist on disk",
    );
    const content = readFileSync(expectedPath, "utf8");
    assert.match(
      content,
      /0104-sample\.txt/,
      "the durable file must contain the same audit line stdout showed",
    );
  });
});

// --- 요구2: 고정 기본 경로 -- 인자/환경으로 덮어쓰기 가능, 리눅스 이식성 ---

test("요구2 (고정 기본 경로 덮어쓰기 -- 인자): --report <path>가 기본 경로를 대신한다", () => {
  withDir((inboxDir) => {
    writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
    withDir((elsewhere) => {
      const customPath = join(elsewhere, "custom-report.md");
      const res = spawnSync(
        process.execPath,
        [CLI_PATH, inboxDir, "--report", customPath],
        { encoding: "utf8" },
      );
      assert.equal(res.status, 0);
      assert.equal(existsSync(customPath), true);
      assert.equal(
        existsSync(join(inboxDir, DEFAULT_REPORT_BASENAME)),
        false,
        "default path must NOT also be written when --report overrides it",
      );
    });
  });
});

test(`요구2 (고정 기본 경로 덮어쓰기 -- 환경변수): ${REPORT_PATH_ENV_VAR}가 플래그 없이도 기본 경로를 대신한다`, () => {
  withDir((inboxDir) => {
    writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
    withDir((elsewhere) => {
      const envPath = join(elsewhere, "env-report.md");
      const res = spawnSync(process.execPath, [CLI_PATH, inboxDir], {
        encoding: "utf8",
        env: { ...process.env, [REPORT_PATH_ENV_VAR]: envPath },
      });
      assert.equal(res.status, 0);
      assert.equal(existsSync(envPath), true);
    });
  });
});

test("요구2 (리눅스 이식성): 기본 경로는 dir 인자로부터만 유도되고 D-드라이브(또는 어떤 하드코딩된 절대경로도) 참조하지 않는다 -- mkdtemp 임시 디렉터리 하나로 전부 재현됨", () => {
  withDir((inboxDir) => {
    // dir 자체가 이미 mkdtemp 산출물이다 -- 이 시험이 통과한다는 사실 자체가
    // "기본 경로 결정에 저장소 밖 절대경로가 필요 없다"는 것의 증거다.
    const now = new Date();
    writeFileSync(
      join(inboxDir, "0303-sample.txt"),
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );
    const res = spawnSync(process.execPath, [CLI_PATH, inboxDir], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.equal(existsSync(join(inboxDir, DEFAULT_REPORT_BASENAME)), true);
  });
});

// --- 요구3: --no-report 로만 끄기, 암묵적 끄기 금지 ---

test("★요구3 (--no-report 실제 동작): 플래그를 주면 리포트 파일이 생기지 않는다 -- 실제 CLI 출력 원문 확인", () => {
  withDir((inboxDir) => {
    writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, inboxDir, "--no-report"],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stdout, /durable report appended/);
    assert.equal(
      existsSync(join(inboxDir, DEFAULT_REPORT_BASENAME)),
      false,
      "explicitly disabled -> no default file appears",
    );
  });
});

// --- 요구4: 기존 --report <path> 하위호환 ---

test("요구4 (하위호환): 기존 --report <path> 사용법이 여전히 그대로 동작한다(2R/3R과 동일 동작)", () => {
  withDir((inboxDir) => {
    const now = new Date();
    writeFileSync(
      join(inboxDir, "0104-sample.txt"),
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );
    withDir((reportDir) => {
      const reportPath = join(reportDir, "explicit-report.md");
      const res = spawnSync(
        process.execPath,
        [CLI_PATH, inboxDir, "--report", reportPath],
        { encoding: "utf8" },
      );
      assert.equal(res.status, 0);
      assert.equal(existsSync(reportPath), true);
      const content = readFileSync(reportPath, "utf8");
      assert.match(content, /0104-sample\.txt/);
    });
  });
});

// --- 요구5: (B) 성격 불변 -- exit 0, 3가지 경우(정상/MISMATCH-UNDECIDABLE/리포트 쓰기 실패) ---

test("★요구5 ((B) 성격 불변): 정상 판정 케이스 -> exit 0", () => {
  withDir((inboxDir) => {
    const now = new Date();
    writeFileSync(
      join(inboxDir, "0303-sample.txt"),
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );
    const res = spawnSync(process.execPath, [CLI_PATH, inboxDir], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, "NORMAL 판정도 exit 0");
  });
});

test("★요구5 ((B) 성격 불변): MISMATCH/UNDECIDABLE이 섞여도 -> exit 0", () => {
  withDir((inboxDir) => {
    const now = new Date();
    const claimed = new Date(now.getTime() - 55 * 60 * 1000);
    writeFileSync(
      join(inboxDir, "0104-sample.txt"),
      headerFor(now, claimed.getHours(), claimed.getMinutes()),
      "utf8",
    );
    writeFileSync(join(inboxDir, "nohints.txt"), "no time info\n", "utf8");
    const res = spawnSync(process.execPath, [CLI_PATH, inboxDir], {
      encoding: "utf8",
    });
    assert.equal(
      res.status,
      0,
      "MISMATCH/UNDECIDABLE이 있어도 exit 0 -- (B)는 절대 차단하지 않는다",
    );
    assert.match(res.stdout, /MISMATCH/);
    assert.match(res.stdout, /UNDECIDABLE/);
  });
});

test("★요구5 ((B) 성격 불변): 리포트 쓰기 실패(쓸 수 없는 경로) -> 여전히 exit 0, stderr에만 사유", () => {
  withDir((inboxDir) => {
    writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
    // 존재하지 않는 상위 디렉터리를 가리키는 경로 -- appendFileSync가 ENOENT로 실패한다.
    const unwritablePath = join(inboxDir, "no-such-parent-dir", "report.md");
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, inboxDir, "--report", unwritablePath],
      { encoding: "utf8" },
    );
    assert.equal(
      res.status,
      0,
      "리포트 쓰기가 실패해도 이 CLI의 exit은 여전히 0 -- (B)는 이 실패조차 차단으로 바꾸지 않는다",
    );
    assert.match(res.stderr, /could not append durable report/);
  });
});

test("요구5 (append-only 유지): 기본 경로로 두 번 실행해도 덮어쓰지 않고 누적된다", () => {
  withDir((inboxDir) => {
    const now = new Date();
    writeFileSync(
      join(inboxDir, "0303-sample.txt"),
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );
    spawnSync(process.execPath, [CLI_PATH, inboxDir], { encoding: "utf8" });
    spawnSync(process.execPath, [CLI_PATH, inboxDir], { encoding: "utf8" });
    const content = readFileSync(
      join(inboxDir, DEFAULT_REPORT_BASENAME),
      "utf8",
    );
    const runCount = (content.match(/## Audit run/g) || []).length;
    assert.equal(
      runCount,
      2,
      "두 번 실행하면 배치 2개가 모두 남아야 한다(덮어쓰기 금지)",
    );
  });
});

// ---------------------------------------------------------------------------
// ★RED 변조 3건 (필수, §2) -- 전부 사본(mkdtemp)에만 변조, 원본 미변경.
// ---------------------------------------------------------------------------
function stageMutant(mutatedSrc) {
  const mutDir = mkdtempSync(join(tmpdir(), "inbox-audit-4r-mut-"));
  const scriptsCheckDir = join(mutDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  const mutantPath = join(scriptsCheckDir, "inbox-time-audit.mjs");
  writeFileSync(mutantPath, mutatedSrc, "utf8");
  writeFileSync(
    join(scriptsCheckDir, "inbox-time-audit-core.mjs"),
    readFileSync(join(_dirname(CLI_PATH), "inbox-time-audit-core.mjs"), "utf8"),
    "utf8",
  );
  return { mutDir, mutantPath };
}

test("mutation 1 (필수): 기본 활성화 제거(reportPath 계산을 명시 --report 필요로 되돌림) -> 플래그 없이 돌리면 리포트가 안 생김 -> RED", () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target =
    "  const reportPath = resolveReportPath({ dir, noReport, explicitReportPath });\n";
  assertExactlyOneMatch(src, target, "reportPath resolution call site");
  const mutated = src.replace(
    target,
    "  const reportPath = explicitReportPath;\n",
  );

  const { mutDir, mutantPath } = stageMutant(mutated);
  try {
    withDir((inboxDir) => {
      writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
      const res = spawnSync(process.execPath, [mutantPath, inboxDir], {
        encoding: "utf8",
      });
      assert.equal(res.status, 0);
      assert.doesNotMatch(
        res.stdout,
        /durable report appended/,
        "RED: with default-activation reverted, running with no flags produces no durable report again",
      );
    });
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
  }
});

test("mutation 2 (필수): --no-report 무시하도록 변조 -> 끄라고 했는데 여전히 씀 -> RED", () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target = "  if (noReport) return null;\n";
  assertExactlyOneMatch(
    src,
    target,
    "noReport short-circuit in resolveReportPath",
  );
  const mutated = src.replace(target, "");

  const { mutDir, mutantPath } = stageMutant(mutated);
  try {
    withDir((inboxDir) => {
      writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
      const res = spawnSync(
        process.execPath,
        [mutantPath, inboxDir, "--no-report"],
        { encoding: "utf8" },
      );
      assert.equal(res.status, 0);
      assert.match(
        res.stdout,
        /durable report appended/,
        "RED: with the --no-report short-circuit removed, the flag is silently ignored and a report is written anyway",
      );
    });
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
  }
});

test("mutation 3 (필수): 고정 기본 경로 결정 로직 제거 -> 기본 경로가 안 정해짐(플래그 없이 돌리면 리포트 없음) -> RED", () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target = "  return join(dir, DEFAULT_REPORT_BASENAME);\n";
  assertExactlyOneMatch(src, target, "default report path fallback line");
  const mutated = src.replace(target, "  return undefined;\n");

  const { mutDir, mutantPath } = stageMutant(mutated);
  try {
    withDir((inboxDir) => {
      writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
      const res = spawnSync(process.execPath, [mutantPath, inboxDir], {
        encoding: "utf8",
      });
      assert.equal(res.status, 0);
      assert.doesNotMatch(
        res.stdout,
        /durable report appended/,
        "RED: with the fixed-default fallback removed, no default path is ever resolved and no report is written even without --no-report",
      );
    });
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-186 5R §2 -- self-audit contamination bug (4R 신규 결함, 독립 검토
// 실측): the durable report lives inside inboxDir (3R/4R deliberate, 타당
// 판정 유지) -- from the SECOND run onward it existed as an ordinary file
// and got audited as one, its own "## Audit run <ISO>" batch header
// misread as a claimed time, producing a false MISMATCH written into the
// very report meant to be trustworthy.
// ---------------------------------------------------------------------------

test("★재현 (수리 전 실사고와 동일 모양): 같은 inbox에 플래그 없이 두 번 실행해도 2회차에 자기 리포트에 대한 허위 MISMATCH가 나타나지 않는다", () => {
  withDir((inboxDir) => {
    writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
    const first = spawnSync(process.execPath, [CLI_PATH, inboxDir], {
      encoding: "utf8",
    });
    assert.equal(first.status, 0);
    assert.doesNotMatch(
      first.stdout,
      /MISMATCH .*\.inbox-time-audit-report\.md/,
      "1회차는 리포트가 아직 없으므로 애초에 자기감사가 일어날 수 없다 -- 대조군",
    );

    const second = spawnSync(process.execPath, [CLI_PATH, inboxDir], {
      encoding: "utf8",
    });
    assert.equal(second.status, 0);
    assert.doesNotMatch(
      second.stdout,
      /MISMATCH .*\.inbox-time-audit-report\.md/,
      "수리 전 실사고: 2회차부터 자기 리포트가 inbox 항목으로 오인되어 허위 MISMATCH가 발생했다 -- 이제는 발생하지 않아야 한다",
    );
    // 진짜 감사 대상(plain.txt)은 계속 정상적으로 판정된다 -- 자기제외가
    // 과도해서 진짜 항목까지 사라지지 않았음을 함께 확인.
    assert.match(second.stdout, /plain\.txt/);
    const reportContent = readFileSync(
      join(inboxDir, DEFAULT_REPORT_BASENAME),
      "utf8",
    );
    assert.doesNotMatch(
      reportContent,
      /MISMATCH .*\.inbox-time-audit-report\.md/,
      "durable 파일 자체에도 허위 MISMATCH가 남으면 안 된다 -- stdout만이 아니라 기록 자체가 오염되지 않아야 한다",
    );
  });
});

test("제외 규칙 경계1: --report <path>가 마침 inboxDir 안이면 그 경로도 제외된다(경로 일치가 기준, 파일명 패턴이 아님)", () => {
  withDir((inboxDir) => {
    writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
    const customInsidePath = join(inboxDir, "custom-name-report.txt");
    // 1회차: 리포트 생성.
    spawnSync(
      process.execPath,
      [CLI_PATH, inboxDir, "--report", customInsidePath],
      { encoding: "utf8" },
    );
    // 2회차: 같은 --report 경로로 다시 실행 -- custom-name-report.txt가
    // 자기 자신을 감사하면 안 된다(파일명이 기본 리포트 이름 패턴과
    // 전혀 다른데도 경로가 일치하므로 제외되어야 한다는 것이 핵심).
    const second = spawnSync(
      process.execPath,
      [CLI_PATH, inboxDir, "--report", customInsidePath],
      { encoding: "utf8" },
    );
    assert.equal(second.status, 0);
    assert.doesNotMatch(
      second.stdout,
      /MISMATCH .*custom-name-report\.txt/,
      "파일명이 기본 리포트 이름과 무관해도, 이번 실행이 쓸 정확한 경로와 일치하면 제외되어야 한다",
    );
  });
});

test("제외 규칙 경계2: 환경변수로 준 경로가 inboxDir 안이면 그 경로도 제외된다", () => {
  withDir((inboxDir) => {
    writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
    const envInsidePath = join(inboxDir, "env-report.md");
    const env = { ...process.env, [REPORT_PATH_ENV_VAR]: envInsidePath };
    spawnSync(process.execPath, [CLI_PATH, inboxDir], {
      encoding: "utf8",
      env,
    });
    const second = spawnSync(process.execPath, [CLI_PATH, inboxDir], {
      encoding: "utf8",
      env,
    });
    assert.equal(second.status, 0);
    assert.doesNotMatch(second.stdout, /MISMATCH .*env-report\.md/);
  });
});

test("제외 규칙 경계3 (★중요): --no-report인 실행은 이전 실행이 남긴 리포트 파일을 평범한 파일로 그대로 감사한다 -- 조용히 숨기지 않는다", () => {
  withDir((inboxDir) => {
    writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
    // 1회차: 기본 활성화로 리포트를 실제로 만들어 둔다.
    spawnSync(process.execPath, [CLI_PATH, inboxDir], { encoding: "utf8" });
    assert.equal(existsSync(join(inboxDir, DEFAULT_REPORT_BASENAME)), true);
    // 2회차: --no-report -- 이 실행은 아무 파일도 쓰지 않으므로 excludePath가
    // 없다. 남아 있는 .inbox-time-audit-report.md는 "이번 실행이 쓸 파일"이
    // 아니라 그냥 존재하는 파일이므로 평범하게 감사되어야 한다(그 배치
    // 헤더의 ISO 시각을 오인해 MISMATCH가 나는 것 자체는 이 시험의
    // 관심사가 아니다 -- 핵심은 "조용히 빠지지 않는다", 즉 감사 대상
    // 목록에는 반드시 나타난다는 것).
    const second = spawnSync(
      process.execPath,
      [CLI_PATH, inboxDir, "--no-report"],
      { encoding: "utf8" },
    );
    assert.equal(second.status, 0);
    assert.match(
      second.stdout,
      new RegExp(DEFAULT_REPORT_BASENAME.replace(/\./g, "\\.")),
      "--no-report 실행에서는 남아있는 리포트 파일도 감사 목록에 나타나야 한다 -- 조용히 제외되면 '실제로 있는 파일을 감사에서 빼는' 별개의 문제가 된다",
    );
  });
});

test("가시성(§2-3): 제외된 사실이 stdout과 durable 리포트 양쪽에 사람이 읽는 문장으로 남는다", () => {
  withDir((inboxDir) => {
    writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
    spawnSync(process.execPath, [CLI_PATH, inboxDir], { encoding: "utf8" });
    const second = spawnSync(process.execPath, [CLI_PATH, inboxDir], {
      encoding: "utf8",
    });
    assert.match(
      second.stdout,
      /자기 리포트 1건 감사 대상에서 제외/,
      "stdout에 제외 사실이 사람이 읽는 문장으로 보여야 한다",
    );
    const reportContent = readFileSync(
      join(inboxDir, DEFAULT_REPORT_BASENAME),
      "utf8",
    );
    assert.match(
      reportContent,
      /자기 리포트 1건 감사 대상에서 제외/,
      "durable 파일에도 남아야 한다 -- stdout에만 있으면 그 자체가 '로그에만 남는 것' 문제를 반복하는 것",
    );
  });
});

test("auditDirectory (단위): excludePath와 정확히 일치하는 파일만 빠진다, 다른 파일은 영향 없음", () => {
  withDir((dir) => {
    const now = new Date();
    writeFileSync(
      join(dir, "0303-real.txt"),
      headerFor(now, now.getHours(), now.getMinutes()),
      "utf8",
    );
    writeFileSync(join(dir, "self-report.md"), "## Audit run fake\n", "utf8");
    const { entries, excluded } = auditDirectory({
      dir,
      excludePath: join(dir, "self-report.md"),
    });
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0], "self-report.md");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].basename, "0303-real.txt");
  });
});

test("auditDirectory (단위): excludePath가 undefined면 아무것도 제외하지 않는다(기존 동작 100% 보존)", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "plain.txt"), "no hints\n", "utf8");
    const { entries, excluded } = auditDirectory({ dir });
    assert.equal(excluded.length, 0);
    assert.equal(entries.length, 1);
  });
});

// ---------------------------------------------------------------------------
// ★RED 변조 2건 (필수, §2) -- 사본(mkdtemp)에만 변조, 원본 미변경.
// ---------------------------------------------------------------------------

test("mutation 4 (필수): 제외 로직 제거 -> 2회차에 자기 리포트 허위 MISMATCH가 다시 나타남 -> RED", () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target =
    "    if (excludeNorm !== null && normalizeForCompare(filePath) === excludeNorm) {\n      excluded.push(basename);\n      continue;\n    }\n";
  assertExactlyOneMatch(
    src,
    target,
    "excludePath skip branch in auditDirectory",
  );
  const mutated = src.replace(target, "");

  const { mutDir, mutantPath } = stageMutant(mutated);
  try {
    withDir((inboxDir) => {
      writeFileSync(join(inboxDir, "plain.txt"), "no hints\n", "utf8");
      spawnSync(process.execPath, [mutantPath, inboxDir], { encoding: "utf8" });
      const second = spawnSync(process.execPath, [mutantPath, inboxDir], {
        encoding: "utf8",
      });
      assert.equal(second.status, 0);
      assert.match(
        second.stdout,
        /MISMATCH .*\.inbox-time-audit-report\.md/,
        "RED: with the exclusion branch removed, the exact pre-fix bug reproduces -- the self-report is audited and flagged as a false MISMATCH again",
      );
    });
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
  }
});

test("mutation 5 (필수, ★반대 방향): 제외 범위를 과도하게 넓힘(모든 .md 제외) -> 진짜 감사 대상(.md 파일)이 사라짐 -> RED", () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target =
    "    if (excludeNorm !== null && normalizeForCompare(filePath) === excludeNorm) {\n";
  assertExactlyOneMatch(src, target, "excludePath comparison condition");
  const mutated = src.replace(target, '    if (basename.endsWith(".md")) {\n');

  const { mutDir, mutantPath } = stageMutant(mutated);
  try {
    withDir((inboxDir) => {
      // 진짜 감사 대상: 우연히 .md 확장자를 가진 실제 받는함 파일.
      const now = new Date();
      writeFileSync(
        join(inboxDir, "0303-real-inbox-item.md"),
        headerFor(now, now.getHours(), now.getMinutes()),
        "utf8",
      );
      const res = spawnSync(process.execPath, [mutantPath, inboxDir], {
        encoding: "utf8",
      });
      assert.equal(res.status, 0);
      // The mutant's own exclusion-notice line legitimately mentions the
      // filename (visibility is preserved) -- the RED signal is that the
      // file never gets a real verdict line (NORMAL/MISMATCH/UNDECIDABLE)
      // at all, i.e. it was never actually audited.
      assert.doesNotMatch(
        res.stdout,
        /^(NORMAL|MISMATCH|UNDECIDABLE) 0303-real-inbox-item\.md/m,
        "RED: with the exclusion widened to 'every .md file', a genuine inbox item sharing the extension never receives an audit verdict at all -- this is the opposite-direction failure a single removal-only mutation (mutation 4) cannot catch",
      );
    });
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
  }
});
