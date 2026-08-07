// HYK-193 1R (coder-task.md §4 요건1) -- concurrency-cap-check.mjs 계약
// 시험. 이 스크립트는 "사람이 한 줄로 값 파일 경로와 현재 값을 확인하는
// 명령"이다 -- §4 요건2가 요구하는 두 가지를 직접 확인한다: (1) 어느
// 파일에서·어떤 값을 읽었는지가 보이는가, (2) 빈 출력이 아닌가(성공·
// 실패 어느 쪽에서도).
//
// 이 계약이 보장하지 않는 것:
// - 이 값이 실제로 어떤 실행 중인 supervisor에 쓰이고 있는지는
//   증명하지 않는다(live=false, coder-task.md §8-3 참조).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatConcurrencyCapCheck,
  DEFAULT_CAP_PATH,
  EXIT_CODE,
} from "./concurrency-cap-check.mjs";
import { CONCURRENCY_CAP_SCHEMA_VERSION } from "./concurrency-cap-adapter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function withTempCapFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "nc-concurrency-cap-check-"));
  const filePath = join(dir, "concurrency-cap.json");
  try {
    if (content !== undefined) writeFileSync(filePath, content, "utf8");
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// §4 요건2 -- 성공 경로: 파일 경로 + 값 둘 다 보인다, 출력은 비어있지 않다.
// ---------------------------------------------------------------------------
test("formatConcurrencyCapCheck: success -> output names the file path and the value, non-empty, exitCode OK", () => {
  withTempCapFile(
    JSON.stringify({
      schema_version: CONCURRENCY_CAP_SCHEMA_VERSION,
      global_hard_cap: 2,
    }),
    (capPath) => {
      const { output, exitCode } = formatConcurrencyCapCheck({ capPath });
      assert.equal(exitCode, EXIT_CODE.OK);
      assert.ok(output.length > 0, "output must not be empty");
      assert.ok(
        output.includes(capPath),
        "output must name the file path that was read",
      );
      assert.ok(
        output.includes("2"),
        "output must show the value that was read",
      );
    },
  );
});

test("formatConcurrencyCapCheck reacts to the file's actual content (S-5 behavioral proof, adapter->CLI layer)", () => {
  withTempCapFile(
    JSON.stringify({
      schema_version: CONCURRENCY_CAP_SCHEMA_VERSION,
      global_hard_cap: 2,
    }),
    (capPath) => {
      const before = formatConcurrencyCapCheck({ capPath });
      assert.ok(before.output.includes("global_hard_cap=2"));

      writeFileSync(
        capPath,
        JSON.stringify({
          schema_version: CONCURRENCY_CAP_SCHEMA_VERSION,
          global_hard_cap: 9,
        }),
        "utf8",
      );
      const after = formatConcurrencyCapCheck({ capPath });
      assert.ok(
        after.output.includes("global_hard_cap=9"),
        "the printed value must follow the file's new content",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §4 요건2 -- 실패 경로: "안 돈 것"과 "값이 없는 것"을 구별할 수 있게
// 빈 출력이 아니라 사유가 찍힌다.
// ---------------------------------------------------------------------------
test("formatConcurrencyCapCheck: missing file -> non-empty FAILED output naming the reason, exitCode FAILED", () => {
  withTempCapFile(undefined, (capPath) => {
    const { output, exitCode } = formatConcurrencyCapCheck({ capPath });
    assert.equal(exitCode, EXIT_CODE.FAILED);
    assert.ok(output.length > 0, "output must not be empty on failure either");
    assert.ok(output.includes("FAILED"));
    assert.ok(output.includes(capPath));
    assert.ok(output.includes("FILE_UNREADABLE"));
  });
});

test("formatConcurrencyCapCheck: malformed JSON -> non-empty FAILED output, exitCode FAILED", () => {
  withTempCapFile("{ not json", (capPath) => {
    const { output, exitCode } = formatConcurrencyCapCheck({ capPath });
    assert.equal(exitCode, EXIT_CODE.FAILED);
    assert.ok(output.length > 0);
    assert.ok(output.includes("MALFORMED_JSON"));
  });
});

test("formatConcurrencyCapCheck: schema mismatch -> non-empty FAILED output, exitCode FAILED", () => {
  withTempCapFile(JSON.stringify({ schema_version: "other/v1" }), (capPath) => {
    const { output, exitCode } = formatConcurrencyCapCheck({ capPath });
    assert.equal(exitCode, EXIT_CODE.FAILED);
    assert.ok(output.includes("SCHEMA_MISMATCH"));
  });
});

// ---------------------------------------------------------------------------
// 기본 경로 -- 인자를 안 주면 실제 커밋된 값 파일을 가리킨다(§4 요건1의
// "한 줄"이 실제로 이 저장소의 값 파일을 본다는 확인).
// ---------------------------------------------------------------------------
test("DEFAULT_CAP_PATH points at the committed scripts/supervisor/concurrency-cap.json next to this script", () => {
  assert.equal(DEFAULT_CAP_PATH, join(__dirname, "concurrency-cap.json"));
});

test("formatConcurrencyCapCheck with no args reads the real committed value file -> non-empty, ok output", () => {
  const { output, exitCode } = formatConcurrencyCapCheck();
  assert.equal(exitCode, EXIT_CODE.OK);
  assert.ok(output.length > 0);
  assert.ok(output.includes(DEFAULT_CAP_PATH));
});

// ---------------------------------------------------------------------------
// §4 요건1 -- 실제로 사람이 칠 수 있는 CLI 한 줄이 동작하고 빈 출력이
// 아니다(자식 프로세스로 실제 실행, injected 경로가 아니라 정문 경로).
// ---------------------------------------------------------------------------
test("CLI: `node concurrency-cap-check.mjs` prints a non-empty single line and exits 0", () => {
  const scriptPath = join(__dirname, "concurrency-cap-check.mjs");
  const stdout = execFileSync(process.execPath, [scriptPath], {
    encoding: "utf8",
  });
  const trimmed = stdout.trim();
  assert.ok(trimmed.length > 0, "CLI output must not be empty");
  assert.ok(trimmed.startsWith("concurrency-cap-check: file="));
  assert.ok(trimmed.includes("global_hard_cap="));
});
