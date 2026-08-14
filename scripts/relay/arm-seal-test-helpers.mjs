import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// HYK-162 coder-8: 테스트 전용 addendum/fixture 빌더. `*.test.mjs`가 아니므로
// `node --test scripts/relay/*.test.mjs`가 이 파일 자체를 독립 실행하지 않는다 --
// arm-seal.test.mjs와 orca-spike-live-authz.test.mjs 양쪽이 import해서 재사용한다.

export function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function buildAddendumText(f) {
  return [
    "# Addendum",
    "",
    "```text",
    `addendum_id: ${f.addendum_id}`,
    "supplements: PKT-TEST",
    "purpose: test",
    "scope_change: none",
    "작성: 2026-07-19 KST",
    `승인: ${f.signedApproval}`,
    "```",
    "",
    "## A",
    "```text",
    `packet_id: ${f.packet_id}`,
    `packet_path: ${f.packet_path}`,
    `packet_sha256: ${f.packet_sha256}`,
    `packet_human_approval_ref: ${f.packet_human_approval_ref}`,
    "review_rejected_tip: 325df95",
    "```",
    "",
    "## B",
    "```text",
    `arm_id: ${f.arm_id}`,
    `cycle_id: ${f.cycle_id}`,
    `allowed_task_id: ${f.allowed_task_id}`,
    `allowed_lane: ${f.allowed_lane}`,
    `max_starts_total: ${f.max_starts_total}`,
    `max_starts_per_lane: ${f.max_starts_per_lane}`,
    `max_rejections: ${f.max_rejections}`,
    `publish_allowed: ${f.publish_allowed}`,
    `question_policy: ${f.question_policy}`,
    `error_policy: ${f.error_policy}`,
    "issued_at_rule: signed time",
    "expires_at_rule: +30m",
    `retry_allowed: ${f.retry_allowed}`,
    "```",
    "",
    "## C",
    "```text",
    `task_file_resolved_path: ${f.task_file_resolved_path}`,
    `task_id_from_header: ${f.task_id_from_header}`,
    `task_sha256: ${f.task_sha256}`,
    `task_dropped_at: ${f.task_dropped_at}`,
    `result_file_resolved_path: ${f.result_file_resolved_path}`,
    "```",
    "",
    "## D",
    "```text",
    `target_terminal_handle: ${f.target_terminal_handle}`,
    `target_snapshot_captured_at: ${f.target_snapshot_captured_at}`,
    `target_snapshot_sha256: ${f.target_snapshot_sha256}`,
    `target_repo_or_cwd: ${f.target_repo_or_cwd}`,
    `target_worktree_identity: ${f.target_worktree_identity}`,
    `target_role_evidence: ${f.target_role_evidence}`,
    `target_session_identity: ${f.target_session_identity}`,
    `coordinator_terminal_handle: ${f.coordinator_terminal_handle}`,
    `coordinator_snapshot_sha256: ${f.coordinator_snapshot_sha256}`,
    "```",
    "",
    "## E",
    "```text",
    `receipt_output_root_resolved_path: ${f.receipt_output_root_resolved_path}`,
    `receipt_write_mode: ${f.receipt_write_mode}`,
    `timeout_ms: ${f.timeout_ms}`,
    "```",
    "",
  ].join("\n");
}

export function makeFixtureDir(prefix = "arm-seal-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const harnessDir = join(dir, ".harness");
  mkdirSync(harnessDir, { recursive: true });

  const packetContent =
    "packet_id: PKT-TEST-1\n승인: OK 한용 2026-07-19 00:30\n";
  const packetPath = join(dir, "packet.md");
  writeFileSync(packetPath, packetContent, "utf8");

  const taskContent =
    "task_id: SPIKE-LIVE-1\ndropped_at: 2026-07-19 11:00 KST\n\ngo SPIKE-LIVE-1 content.\n";
  // HYK-244 ci-repair-1 §1 묶음A 수리: 이 픽스처가 만드는 라이브 task/
  // result 파일명은 대문자였다("CODER-task.md"/"CODER.md"), 하지만
  // resolveLiveRoundFilePaths(2R-ci-1)가 이제 role을 파일 경로 조립
  // 시점에만 소문자화한다(관제실 dispatch-worker.ps1의 실제 관례,
  // $Role.ToLower()) -- 이 워크트리의 실제 .harness/*.md도 전부 소문자.
  // Windows는 대소문자를 구별하지 않아 대문자 픽스처도 그대로 통과했지만
  // Linux(CI)는 정확히 이 불일치로 "task file not found"를 낸다(ORCH
  // 실측, not ok 2670 원문). 시험 전제(픽스처의 파일명)가 생산 관례와
  // 어긋난 쪽이므로 시험을 고친다(ⓐ) -- allowed_lane 등 role "값" 자체는
  // 여전히 대문자("CODER")로 둔다(그건 결속 표기이지 파일 경로가 아니다).
  const taskPath = join(harnessDir, "coder-task.md");
  writeFileSync(taskPath, taskContent, "utf8");

  const resultPath = join(harnessDir, "coder.md");

  const fields = {
    addendum_id: "ADD-PKT-TEST-HYK162-ARM-1",
    packet_id: "PKT-TEST-1",
    packet_path: packetPath,
    packet_sha256: sha256(packetContent).toUpperCase(),
    packet_human_approval_ref: "한용 2026-07-19 00:30",
    arm_id: "arm-test-1",
    cycle_id: "cycle-test-1",
    allowed_task_id: "SPIKE-LIVE-1",
    allowed_lane: "CODER",
    max_starts_total: "1",
    max_starts_per_lane: "1",
    max_rejections: "0",
    publish_allowed: "false",
    question_policy: "pause",
    error_policy: "pause",
    retry_allowed: "false",
    task_file_resolved_path: taskPath,
    task_id_from_header: "SPIKE-LIVE-1",
    task_sha256: sha256(taskContent),
    task_dropped_at: "2026-07-19 11:00 KST",
    result_file_resolved_path: resultPath,
    target_terminal_handle: "coder-terminal-live",
    target_snapshot_captured_at: "2026-07-19 11:00 KST",
    target_snapshot_sha256: sha256("snapshot-content-v1"),
    target_repo_or_cwd:
      "C:\\Users\\Administrator\\Documents\\HARNESSENGINEERING",
    target_worktree_identity: "main",
    target_role_evidence: "CODER prompt observed in terminal",
    target_session_identity: "미제공",
    coordinator_terminal_handle: "coordinator-terminal-live",
    coordinator_snapshot_sha256: sha256("coordinator-snapshot-v1"),
    receipt_output_root_resolved_path: dir,
    receipt_write_mode: "create-new-only",
    timeout_ms: "60000",
    signedApproval: "OK 한용 2026-07-19 11:05",
  };

  return {
    dir,
    harnessDir,
    packetPath,
    packetContent,
    taskPath,
    taskContent,
    resultPath,
    fields,
  };
}

export function writeAddendum(dir, fields) {
  const addendumPath = join(dir, "addendum.md");
  writeFileSync(addendumPath, buildAddendumText(fields), "utf8");
  return addendumPath;
}

export const SEAL_NOW = "2026-07-19T02:06:00.000Z"; // 11:06 KST, within 30min of 11:05 signature
export const CONFIRM_PHRASE = "ARM HYK-162 SPIKE-LIVE-1";

export function goodDeps(overrides = {}) {
  return {
    nowFn: () => SEAL_NOW,
    readlineFn: async () => CONFIRM_PHRASE,
    ...overrides,
  };
}
