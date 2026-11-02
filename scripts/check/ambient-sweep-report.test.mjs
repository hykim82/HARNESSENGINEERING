// HYK-477-ambient-sweep-report-1: drives reportAmbientSweep (scripts/check/
// ambient-sweep-report.mjs) directly against synthetic markers written into
// an mkdtemp dir -- never the real enforce.yml marker path, never a real
// sweep run. One success case plus the five distinct failure reasons the
// production entry point itself distinguishes, each asserted on both rc and
// the annotation line's first word (`::notice` / `::error`). One CLI
// invocation (spawnSync) checks rc propagation through the process exit
// code, not just the exported function's return value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportAmbientSweep } from "./ambient-sweep-report.mjs";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);

function withMarkerDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ambient-sweep-report-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeMarker(dir, name, fields) {
  const markerPath = join(dir, name);
  writeFileSync(markerPath, JSON.stringify(fields), "utf8");
  return markerPath;
}

test('ambient-sweep-report 성공: 마커 있음 + 형식 맞음 + files>=1 + full_ambient_sweep=="1" + head 일치 -> rc 0, ::notice', () => {
  withMarkerDir((dir) => {
    const markerPath = writeMarker(dir, "marker.json", {
      files: 288,
      duration_ms: 12345,
      head: HEAD,
      node: "v20.18.0",
      full_ambient_sweep: "1",
    });
    const { rc, line } = reportAmbientSweep({ markerPath, head: HEAD });
    assert.equal(rc, 0);
    assert.match(line, /^::notice /);
    assert.match(line, /ran 288 files in 12\.3 s/);
  });
});

test("ambient-sweep-report 실패(마커 없음): rc 1, ::error", () => {
  withMarkerDir((dir) => {
    const markerPath = join(dir, "does-not-exist.json");
    const { rc, line } = reportAmbientSweep({ markerPath, head: HEAD });
    assert.equal(rc, 1);
    assert.match(line, /^::error /);
  });
});

test("ambient-sweep-report 실패(깨진 JSON): rc 1, ::error", () => {
  withMarkerDir((dir) => {
    const markerPath = join(dir, "broken.json");
    writeFileSync(markerPath, "{ not valid json", "utf8");
    const { rc, line } = reportAmbientSweep({ markerPath, head: HEAD });
    assert.equal(rc, 1);
    assert.match(line, /^::error /);
  });
});

test("ambient-sweep-report 실패(files 0): rc 1, ::error", () => {
  withMarkerDir((dir) => {
    const markerPath = writeMarker(dir, "zero-files.json", {
      files: 0,
      duration_ms: 1,
      head: HEAD,
      node: "v20.18.0",
      full_ambient_sweep: "1",
    });
    const { rc, line } = reportAmbientSweep({ markerPath, head: HEAD });
    assert.equal(rc, 1);
    assert.match(line, /^::error /);
  });
});

test('ambient-sweep-report 실패(env 값 다름): full_ambient_sweep !== "1" -> rc 1, ::error', () => {
  withMarkerDir((dir) => {
    const markerPath = writeMarker(dir, "env-mismatch.json", {
      files: 288,
      duration_ms: 1,
      head: HEAD,
      node: "v20.18.0",
      full_ambient_sweep: "0",
    });
    const { rc, line } = reportAmbientSweep({ markerPath, head: HEAD });
    assert.equal(rc, 1);
    assert.match(line, /^::error /);
  });
});

test("ambient-sweep-report 실패(head 불일치): rc 1, ::error", () => {
  withMarkerDir((dir) => {
    const markerPath = writeMarker(dir, "stale-head.json", {
      files: 288,
      duration_ms: 1,
      head: OTHER_HEAD,
      node: "v20.18.0",
      full_ambient_sweep: "1",
    });
    const { rc, line } = reportAmbientSweep({ markerPath, head: HEAD });
    assert.equal(rc, 1);
    assert.match(line, /^::error /);
  });
});

test("ambient-sweep-report CLI: 합성 마커 1회를 spawnSync로 구동하면 exit code가 rc를 그대로 전파한다", () => {
  withMarkerDir((dir) => {
    const actualHead = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const markerPath = writeMarker(dir, "cli-marker.json", {
      files: 1,
      duration_ms: 1,
      head: actualHead,
      node: process.version,
      full_ambient_sweep: "1",
    });
    const scriptPath = fileURLToPath(
      new URL("./ambient-sweep-report.mjs", import.meta.url),
    );
    const res = spawnSync(process.execPath, [scriptPath, markerPath], {
      encoding: "utf8",
    });
    assert.equal(
      res.status,
      0,
      `CLI exited ${res.status} -- stderr: ${res.stderr}`,
    );
    assert.match(res.stdout, /^::notice /);
  });
});
