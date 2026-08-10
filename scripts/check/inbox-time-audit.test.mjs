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
