import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DELEGATION_POINTS,
  scanForOrcaExecCalls,
  scanRepoForOrcaExecCalls,
  ADAPTER_PATH,
  LEGACY_EXEMPT,
} from "./orca-cli-boundary.mjs";

// HYK-169-coder-1 (G9): 정적 스캔이 "실행 호출"만 잡고 "주석/문서 문자열"은
// 허용하는지, 그리고 스캔 자체가 헛시험(vacuous)이 아닌지(무력화하면
// RED)를 fixture로 확인한다. 마지막 테스트는 실제 scripts/ 트리를 스캔해
// 회귀를 잡는다.

// known-bad: 어댑터 밖에서 orca를 실제로 spawn하면 위반.
test("BLOCK: a spawnSync('orca', ...) call outside the adapter is flagged", () => {
  const files = [
    {
      path: "scripts/relay/some-new-file.mjs",
      content: 'spawnSync("orca", argv);',
    },
  ];
  assert.deepEqual(scanForOrcaExecCalls(files), [
    "scripts/relay/some-new-file.mjs",
  ]);
});

test("BLOCK: single-quote and backtick literal forms are both flagged, and exec()/execFile() variants too", () => {
  const files = [
    { path: "a.mjs", content: "spawn('orca', argv)" },
    { path: "b.mjs", content: "execFileSync(`orca`, argv)" },
    { path: "c.mjs", content: "execSync('orca')" },
  ];
  const violations = scanForOrcaExecCalls(files);
  assert.equal(violations.includes("a.mjs"), true);
  assert.equal(violations.includes("b.mjs"), true);
  assert.equal(violations.includes("c.mjs"), true);
});

// known-good: 어댑터 파일 자신은 항상 허용.
test("PASS: the adapter file itself is exempt even with the same exec pattern", () => {
  const files = [
    {
      path: ADAPTER_PATH,
      content: 'spawnSync("orca", argv, { shell: false });',
    },
  ];
  assert.deepEqual(scanForOrcaExecCalls(files), []);
});

// known-good: 명시된 레거시 예외 파일도 허용(정직 등재 원장 -- LEGACY_EXEMPT).
test("PASS: files explicitly listed in LEGACY_EXEMPT are allowed (documented, tracked gap)", () => {
  assert.ok(
    LEGACY_EXEMPT.length > 0,
    "expect at least the HYK-162 spike-live exemption",
  );
  const files = [
    { path: LEGACY_EXEMPT[0], content: 'spawnSync("orca", argv)' },
  ];
  assert.deepEqual(scanForOrcaExecCalls(files), []);
});

// known-good: 주석/문서 문자열에 "orca"가 등장해도(실행 호출 패턴이 아니면) 통과.
test("PASS: prose/comment mentions of 'orca' with no exec-call shape are not flagged", () => {
  const files = [
    {
      path: "scripts/relay/some-file.mjs",
      content:
        "// this module never calls orca directly -- see docs/enforcement-v1.md\nexport const NAME = 'orca-related-thing';",
    },
  ];
  assert.deepEqual(scanForOrcaExecCalls(files), []);
});

// known-good: 다른 명령어를 spawn하는 건 무관.
test("PASS: spawning an unrelated binary is never flagged", () => {
  const files = [{ path: "x.mjs", content: 'spawnSync("git", ["status"]);' }];
  assert.deepEqual(scanForOrcaExecCalls(files), []);
});

// 변이(mutation) 확인 (a): 어댑터 경로를 잘못 넘겨 스캔을 사실상 무력화하면
// (모든 파일이 "제외"로 잘못 분류) known-bad가 더 이상 안 잡혀야 한다 --
// 이 테스트 자신은 그 무력화된 호출 형태를 재현해 스캔이 실제로 그 차이를
// 구분함을 증명한다(스캔이 파라미터 무관하게 항상 빈 배열을 내는 헛시험이
// 아님을 확인).
test("mutation check (a): disabling the scan by exempting everything hides the known-bad case -- proves the default config does not", () => {
  const files = [
    {
      path: "scripts/relay/new-thing.mjs",
      content: 'spawnSync("orca", argv);',
    },
  ];
  assert.deepEqual(scanForOrcaExecCalls(files), [
    "scripts/relay/new-thing.mjs",
  ]);
  // simulate the "disabled" mutation directly: passing adapterPath as the
  // offending file's own path exempts it -- this is what a weakened/disabled
  // scan would look like, and it does make the violation disappear (as
  // expected), which is exactly why the real config above must never do this.
  assert.deepEqual(
    scanForOrcaExecCalls(files, {
      adapterPath: "scripts/relay/new-thing.mjs",
      legacyExempt: [],
    }),
    [],
  );
});

// 실 scripts/ 트리 회귀: adapter + 등재된 레거시 예외 밖에서 orca exec 호출 0건.
test("scanRepoForOrcaExecCalls: real scripts/ tree has zero orca exec calls outside the adapter + documented legacy exemptions", () => {
  const violations = scanRepoForOrcaExecCalls();
  assert.deepEqual(
    violations,
    [],
    `unexpected orca exec calls found: ${violations.join(", ")}`,
  );
});

// HYK-389-shim-core-1 (조각 1): 새 위임 지점의 «명시 예외» 등재 + 재귀 금지 고정.
// 기록 단계 · OBSERVER · 앵커 아님.
test("HYK-389: DELEGATION_POINTS 에 orca 기록 shim CLI 가 사유와 함께 등재돼 있다", () => {
  const point = DELEGATION_POINTS.find(
    (p) => p.path === "scripts/relay/orca-shim-cli.mjs",
  );
  assert.ok(point, "shim CLI 위임 지점이 등재돼야 한다");
  assert.ok(point.reason.trim().length > 0);
  assert.ok(point.reason.includes("앵커 아님"));
});

test("HYK-389: 등재된 위임 지점은 경로로만 면제된다 -- 같은 내용이 다른 경로에 있으면 여전히 위반", () => {
  const content = 'spawnSync("orca", argv);';
  assert.deepEqual(
    scanForOrcaExecCalls([
      { path: "scripts/relay/orca-shim-cli.mjs", content },
    ]),
    [],
  );
  assert.deepEqual(
    scanForOrcaExecCalls([
      { path: "scripts/relay/other-shim-cli.mjs", content },
    ]),
    ["scripts/relay/other-shim-cli.mjs"],
  );
});

test('HYK-389: shim CLI 는 리터럴 "orca" 를 spawn 하지 않는다(PATH 앞 shim 자기 재호출 = 무한 재귀 금지) -- 면제를 벗겨도 깨끗', () => {
  const content = readFileSync(
    new URL("../relay/orca-shim-cli.mjs", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    scanForOrcaExecCalls(
      [{ path: "scripts/relay/orca-shim-cli.mjs", content }],
      { delegationPoints: [] },
    ),
    [],
  );
});
