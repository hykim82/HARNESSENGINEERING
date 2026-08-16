// HYK-270 (coder-task.md §5, §9-8) -- rate-limit-stall-wire.mjs 결선 시험.
// 오늘(2026-08-16) 실제 사고 형태(한도로 멈춘 좌석이 회복돼도 아무도
// 깨우지 않음)를 fixture로 고정한다. 전부 mkdtemp 합성 경로만 쓴다 --
// 실 `~/.claude`·실 관제실을 건드리지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runRateLimitStallOnce,
  RATE_LIMIT_STALL_WIRE_STATUS,
} from "./rate-limit-stall-wire.mjs";
import { deriveClaudeProjectDirName } from "./rate-limit-stall-adapter.mjs";
import { RATE_LIMIT_STALL_VERDICT } from "./rate-limit-stall-core.mjs";

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeHitFixture(home, repoRoot, hitIso) {
  const projectDir = join(
    home,
    "projects",
    deriveClaudeProjectDirName(repoRoot),
  );
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, "session.jsonl"),
    JSON.stringify({
      type: "assistant",
      timestamp: hitIso,
      isApiErrorMessage: true,
      apiErrorStatus: 429,
    }) + "\n",
    "utf8",
  );
}

test("★HYK-270 e2e: 한도로 멈춘 좌석(회복 흔적 0) -> STALLED_ON_LIMIT + 통지 파일 1장이 notifyDir에 실제로 생긴다(§1b_reach_path 충족)", () => {
  withTempDir("rl-wire-home-", (home) => {
    withTempDir("rl-wire-watch-", (watchDir) => {
      withTempDir("rl-wire-notify-", (notifyDir) => {
        const repoRoot = "C:\\wt\\hyk270";
        const hitIso = "2026-08-16T02:00:00.000Z";
        writeHitFixture(home, repoRoot, hitIso);
        const now = Date.parse("2026-08-16T05:00:00.000Z"); // 3시간 뒤, 아직 5시간 창 안.

        const r = runRateLimitStallOnce({
          repoRoot,
          claudeHomeDir: home,
          watchDir,
          notifyDir,
          now,
        });

        assert.equal(r.status, RATE_LIMIT_STALL_WIRE_STATUS.JUDGED);
        assert.equal(r.verdict, RATE_LIMIT_STALL_VERDICT.STALLED_ON_LIMIT);
        assert.ok(r.noticePath, "통지 파일 경로가 있어야 한다");
        assert.equal(existsSync(r.noticePath), true);
        const text = readFileSync(r.noticePath, "utf8");
        assert.match(text, /한도 정지 의심/);
        assert.match(text, /추정 회복 시각/);
        assert.match(text, /자동 재개를 하지 않습니다/);
        // 회복 예정 시각 = hitAtMs + 5시간(기본 창) 실제로 기록됐는지.
        assert.equal(
          r.details.estimatedRecoveryAtMs,
          Date.parse(hitIso) + 5 * 60 * 60 * 1000,
        );
      });
    });
  });
});

test("같은 hitAtMs로 두 번째 실행하면 중복 통지하지 않는다(등재 후 반복 재통지 금지)", () => {
  withTempDir("rl-wire-home2-", (home) => {
    withTempDir("rl-wire-watch2-", (watchDir) => {
      withTempDir("rl-wire-notify2-", (notifyDir) => {
        const repoRoot = "C:\\wt\\hyk270b";
        const hitIso = "2026-08-16T02:00:00.000Z";
        writeHitFixture(home, repoRoot, hitIso);
        const now1 = Date.parse("2026-08-16T05:00:00.000Z");
        const now2 = Date.parse("2026-08-16T05:10:00.000Z");

        const r1 = runRateLimitStallOnce({
          repoRoot,
          claudeHomeDir: home,
          watchDir,
          notifyDir,
          now: now1,
        });
        assert.ok(r1.noticePath);

        const r2 = runRateLimitStallOnce({
          repoRoot,
          claudeHomeDir: home,
          watchDir,
          notifyDir,
          now: now2,
        });
        assert.equal(r2.noticePath, null);
        assert.equal(r2.alreadyNotified, true);
      });
    });
  });
});

test("회복 흔적(정상 활동)이 있으면 통지하지 않는다(이미 회복됨, 등재 대상 아님)", () => {
  withTempDir("rl-wire-home3-", (home) => {
    withTempDir("rl-wire-watch3-", (watchDir) => {
      withTempDir("rl-wire-notify3-", (notifyDir) => {
        const repoRoot = "C:\\wt\\hyk270c";
        const projectDir = join(
          home,
          "projects",
          deriveClaudeProjectDirName(repoRoot),
        );
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(
          join(projectDir, "session.jsonl"),
          [
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-08-16T02:00:00.000Z",
              isApiErrorMessage: true,
              apiErrorStatus: 429,
            }),
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-08-16T03:30:00.000Z",
              message: {
                model: "claude-fable-5",
                usage: { output_tokens: 42 },
              },
            }),
          ].join("\n") + "\n",
          "utf8",
        );
        const r = runRateLimitStallOnce({
          repoRoot,
          claudeHomeDir: home,
          watchDir,
          notifyDir,
          now: Date.parse("2026-08-16T05:00:00.000Z"),
        });
        assert.equal(r.verdict, RATE_LIMIT_STALL_VERDICT.RECOVERED);
        assert.equal(r.noticePath, null);
      });
    });
  });
});

// ★P1 수리 e2e(검토자 fixture, coder-task.md §2): 429 뒤 사용자 입력만
// 있어도 STALLED 통지가 그대로 나가야 한다(억제되지 않는다).
test("★P1 e2e: 429 뒤 type:user 입력만 있어도 STALLED_ON_LIMIT 통지가 그대로 나간다(억제되지 않는다)", () => {
  withTempDir("rl-wire-p1-home-", (home) => {
    withTempDir("rl-wire-p1-watch-", (watchDir) => {
      withTempDir("rl-wire-p1-notify-", (notifyDir) => {
        const repoRoot = "C:\\wt\\hyk270p1";
        const projectDir = join(
          home,
          "projects",
          deriveClaudeProjectDirName(repoRoot),
        );
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(
          join(projectDir, "session.jsonl"),
          [
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-08-16T02:00:00.000Z",
              isApiErrorMessage: true,
              apiErrorStatus: 429,
            }),
            JSON.stringify({
              type: "user",
              timestamp: "2026-08-16T02:05:00.000Z",
              message: { role: "user", content: "다시 시도해줘" },
            }),
          ].join("\n") + "\n",
          "utf8",
        );
        const r = runRateLimitStallOnce({
          repoRoot,
          claudeHomeDir: home,
          watchDir,
          notifyDir,
          now: Date.parse("2026-08-16T05:00:00.000Z"),
        });
        assert.equal(r.verdict, RATE_LIMIT_STALL_VERDICT.STALLED_ON_LIMIT);
        assert.ok(
          r.noticePath,
          "사용자 입력만으로 회복 처리돼 통지가 억제되면 안 된다",
        );
        assert.equal(existsSync(r.noticePath), true);
      });
    });
  });
});

test("관측 수집 자체가 실패하면(디렉터리 권한 문제 등) COLLECTION_FAILED이고 통지 파일을 쓰지 않는다(§2-3 «조용함으로 접지 않는다»)", () => {
  withTempDir("rl-wire-watch4-", (watchDir) => {
    withTempDir("rl-wire-notify4-", (notifyDir) => {
      const r = runRateLimitStallOnce({
        repoRoot: "C:\\wt\\hyk270d",
        claudeHomeDir: "C:\\nonexistent-home-root-zzz",
        watchDir,
        notifyDir,
        now: 100000,
        readdirFn: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      });
      assert.equal(r.status, RATE_LIMIT_STALL_WIRE_STATUS.COLLECTION_FAILED);
      assert.equal(r.noticePath, null);
    });
  });
});
