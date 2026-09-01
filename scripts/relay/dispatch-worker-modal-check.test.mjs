// HYK-271-wire-1 (coder-task.md §2⑵) -- proof for the sidecar checker
// dispatch-worker-modal-check.mjs. This file does NOT re-derive the axis or
// re-author samples (design doc docs/control-room-patches/HYK-271-preflight-preview-marker.md
// already did that, PR #237) -- it drives the new CLI entry point
// (runModalCheck) against the SAME synthetic samples
// hyk271-axis-preview-marker-synthetic.test.mjs already measured, plus the
// file-I/O paths that module never had to cover.
//
// Isolation (coder-task.md §0 "⛔라이브 .harness/ 아래에 스크래치 금지"): every
// terminal-show fixture this file writes lives under its own mkdtempSync
// directory, created and removed per test (auth-grant-gate.test.mjs
// withTempDir precedent, same pattern).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runModalCheck,
  MODAL_MARKERS,
  VERDICT,
  CHECK_REASON,
} from "./dispatch-worker-modal-check.mjs";
import { SAMPLES } from "./hyk271-axis-preview-marker-synthetic.test.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-worker-modal-check-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// terminal-show 파일의 실측 shape을 그대로 만든다(parseSeatPreview가 읽는
// 자리 -- response.result.terminal.preview, orca-adapter.mjs 참조).
function writeTerminalShow(dir, name, preview) {
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({ ok: true, result: { terminal: { preview } } }),
  );
  return path;
}

// ---------------------------------------------------------------------------
// ⓐⓑⓔ -- 기존 축 시험이 측정한 합성 표본 9개를 그대로 재사용해 CLI 진입점을
// 구동한다(재사용, 재구현/재창작 아님). "modal-truncated..." 라벨의 샘플은
// expectModal:false(§0 참조, 그 파일이 이미 위음성으로 고정한 값)이므로 이
// 루프가 자동으로 ⓔ(재그림 절단 표본은 놓친다)도 함께 고정한다.
// ---------------------------------------------------------------------------
test("runModalCheck: every SAMPLES entry from the axis proof classifies the same way through the new sidecar (zero regressions, zero new false positives)", () => {
  withTempDir((dir) => {
    const mismatches = [];
    SAMPLES.forEach((s, i) => {
      const path = writeTerminalShow(dir, `sample-${i}.json`, s.preview);
      const result = runModalCheck(["--terminal-show", path]);
      const gotModal = result.verdict === VERDICT.MODAL;
      if (gotModal !== s.expectModal) {
        mismatches.push({
          label: s.label,
          gotModal,
          expectModal: s.expectModal,
        });
      }
    });
    assert.deepEqual(
      mismatches,
      [],
      `dispatch-worker-modal-check disagreed with the axis proof's expectation on: ${JSON.stringify(mismatches)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// ⓐ -- 모달 표본은 exit 2로 거부되고, 매치된 마커가 stderr 대신 result.detail
// 로 넘어온다(포맷팅은 별도 formatModalCheckResult가 담당 -- 여기선 판정
// 자체만 본다).
// ---------------------------------------------------------------------------
test("runModalCheck: a full-text modal sample is rejected with exit 2 and the matched marker is reported", () => {
  withTempDir((dir) => {
    const modalSample = SAMPLES.find(
      (s) => s.label === "modal-codex-approval-full",
    );
    const path = writeTerminalShow(dir, "modal.json", modalSample.preview);
    const result = runModalCheck(["--terminal-show", path]);
    assert.equal(result.exitCode, 2);
    assert.equal(result.verdict, VERDICT.MODAL);
    assert.equal(result.reasonCode, CHECK_REASON.MARKER_MATCH);
    assert.equal(result.detail, "Allow command?");
  });
});

// ---------------------------------------------------------------------------
// ⓑ -- 위양성 0 대조군: idle/busy/적대적 대화문 등 "모달 아님" 표본 전원이
// exit 0이어야 한다(SAMPLES 루프가 이미 확인하지만, §2⑵ⓑ가 별도 항목으로
// 요구하므로 대조군만 분리해 명시적으로 카운트를 남긴다).
// ---------------------------------------------------------------------------
test("runModalCheck: false-positive control group -- every non-modal SAMPLES entry (idle/busy/adversarial-text/truncated-miss) passes with exit 0", () => {
  withTempDir((dir) => {
    const nonModal = SAMPLES.filter((s) => !s.expectModal);
    assert.ok(nonModal.length > 0, "control group must be non-empty");
    for (const [i, s] of nonModal.entries()) {
      const path = writeTerminalShow(dir, `nonmodal-${i}.json`, s.preview);
      const result = runModalCheck(["--terminal-show", path]);
      assert.equal(result.exitCode, 0, `expected exit 0 for "${s.label}"`);
      assert.equal(result.verdict, VERDICT.NON_MODAL);
    }
  });
});

// ---------------------------------------------------------------------------
// ⓒ -- 파일 부재/파손은 fail-closed(exit 2). 세 가지 형태(부재/빈 파일=JSON
// 파싱 실패/모양이 안 맞음)가 전부 같은 결과로 접히는지 확인한다(새 분기를
// 만들지 않는다는 계약, coder-task.md §2⑴).
// ---------------------------------------------------------------------------
test("runModalCheck: a missing terminal-show file fails closed with exit 2", () => {
  withTempDir((dir) => {
    const missingPath = join(dir, "does-not-exist.json");
    const result = runModalCheck(["--terminal-show", missingPath]);
    assert.equal(result.exitCode, 2);
    assert.equal(result.verdict, VERDICT.MODAL);
    assert.equal(result.reasonCode, CHECK_REASON.FILE_UNREADABLE);
  });
});

test("runModalCheck: a corrupt (non-JSON) terminal-show file fails closed with exit 2, same reasonCode as a missing file", () => {
  withTempDir((dir) => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{ this is not valid json");
    const result = runModalCheck(["--terminal-show", path]);
    assert.equal(result.exitCode, 2);
    assert.equal(result.verdict, VERDICT.MODAL);
    assert.equal(result.reasonCode, CHECK_REASON.FILE_UNREADABLE);
  });
});

test("runModalCheck: a well-formed JSON file whose shape parseSeatPreview cannot recognize (no result.terminal.preview) also fails closed with exit 2", () => {
  withTempDir((dir) => {
    const path = join(dir, "wrong-shape.json");
    writeFileSync(
      path,
      JSON.stringify({ ok: true, result: { nothing: true } }),
    );
    const result = runModalCheck(["--terminal-show", path]);
    assert.equal(result.exitCode, 2);
    assert.equal(result.verdict, VERDICT.MODAL);
    assert.equal(result.reasonCode, CHECK_REASON.FILE_UNREADABLE);
  });
});

// ---------------------------------------------------------------------------
// ⓓ -- 되돌림 변이: 마커 검사를 끊으면(opts.markers를 빈 배열로 -- 프로덕션
// 호출부는 이 옵션을 절대 넘기지 않는 테스트 전용 시임, 파일 상단 주석 참조)
// ⓐ가 통과해 버리는지 확인한다. 이게 통과하지 않으면 ⓐ의 "거부"가 실제로
// 마커 매치 때문인지 우연인지 이 스위트만으로는 증명할 수 없다.
// ---------------------------------------------------------------------------
test("mutation (되돌림 변이): neutralizing the marker catalog (opts.markers=[]) lets the SAME modal sample that ⓐ rejects pass with exit 0 -- proves ⓐ's rejection is actually caused by marker matching", () => {
  withTempDir((dir) => {
    const modalSample = SAMPLES.find(
      (s) => s.label === "modal-codex-approval-full",
    );
    const path = writeTerminalShow(dir, "modal.json", modalSample.preview);

    const withCatalog = runModalCheck(["--terminal-show", path]);
    assert.equal(
      withCatalog.exitCode,
      2,
      "sanity: unmutated check still rejects this sample",
    );

    const neutralized = runModalCheck(["--terminal-show", path], {
      markers: [],
    });
    assert.equal(
      neutralized.exitCode,
      0,
      "neutralized marker catalog must let the modal sample through",
    );
    assert.equal(neutralized.verdict, VERDICT.NON_MODAL);
  });
});

// ---------------------------------------------------------------------------
// ⓔ (★고정) -- 재그림 절단으로 마커가 중간에서 끊긴 표본은 이 결선도 놓친다.
// 이건 결함이 아니라 design doc §1/§3이 이미 인정한 한계다 -- 별도 시험으로
// 분리해, 나중에 누가 "이제는 잡힌다"고 착각해 이 assertion을 조용히
// 지우지 못하게 고정한다.
// ---------------------------------------------------------------------------
test("KNOWN MISS (accepted limitation, not a defect): a mid-word redraw-truncated modal marker is NOT caught -- exit 0, same as a genuinely non-modal preview", () => {
  withTempDir((dir) => {
    const truncated = SAMPLES.find((s) =>
      s.label.startsWith("modal-truncated-marker-split-mid-word"),
    );
    assert.ok(
      truncated,
      "expected the axis proof's truncated-marker sample to exist",
    );
    const path = writeTerminalShow(dir, "truncated.json", truncated.preview);
    const result = runModalCheck(["--terminal-show", path]);
    assert.equal(
      result.exitCode,
      0,
      "this IS the known miss -- a redraw-truncated marker is not caught by substring matching, and that is an accepted limit of axis-orca-query-preview (design doc §1/§3), not something this round fixes",
    );
    assert.equal(result.verdict, VERDICT.NON_MODAL);
  });
});

// ---------------------------------------------------------------------------
// 인자/계약 시험 -- CLI 자신의 실패 경로(코더-task.md §2⑴이 "새 exit
// 코드·새 분기를 만들지 마라"고 못 박았으므로, 인자 오류도 같은 exit 2로
// 접히는지 확인).
// ---------------------------------------------------------------------------
test("runModalCheck: missing --terminal-show argument fails closed with exit 2 (no new exit code)", () => {
  const result = runModalCheck([]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, VERDICT.MODAL);
  assert.equal(result.reasonCode, CHECK_REASON.ARGS_MISSING);
});

// HYK-271-marker-catalog-1 (2R): deliberately widened from the 1R list (4
// command-approval markers only) to add "Enter to select" -- the 1R catalog
// measurably let both real incident samples (founding + today, see
// hyk271-marker-catalog-real-corpus.test.mjs) through as NON_MODAL because
// neither is a command-approval modal, both are numbered selection menus.
// This pin is updated intentionally, not silently -- see that file for the
// false-positive measurement against 14 real live-seat previews that backs
// the new entry.
test("MODAL_MARKERS: the sidecar's catalog is bit-for-bit the same list this round measured (single source, no drift)", () => {
  const fromAxisSamples = SAMPLES.filter((s) => s.expectModal).length;
  assert.ok(fromAxisSamples > 0, "sanity: axis proof must have modal samples");
  assert.deepEqual(MODAL_MARKERS, [
    "Do you want to proceed?",
    "Yes, and don't ask again",
    "No, and tell Claude what to do differently",
    "Allow command?",
    "Enter to select",
  ]);
});
