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

test("E2E CLI: without --report, no durable file is created (opt-in, backward compatible with 2R's stdout-only usage)", () => {
  withDir((inboxDir) => {
    writeFileSync(join(inboxDir, "plain.txt"), "no time hints\n", "utf8");
    const res = spawnSync(process.execPath, [CLI_PATH, inboxDir], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stdout, /durable report appended/);
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
