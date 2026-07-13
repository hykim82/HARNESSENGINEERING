import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  runInventory,
  resolvePlaceholderPath,
  discoverCheckTestFiles,
  sha256Hex,
} from "./selfcheck-inventory.mjs";
import { runSmokeSuite } from "./selfcheck-smoke.mjs";
import { buildReport, writeReport } from "./selfcheck-report.mjs";

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

function repoHead(root) {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "(unresolvable -- unborn repo or git error)";
  }
}

export function buildManifestById(manifest) {
  const byId = {};
  for (const entry of manifest.checks) byId[entry.id] = entry;
  return byId;
}

// Loads every claude-settings file a manifest's install_targets reference,
// keyed by location -- absent/unreadable files are simply left out of the
// map (judgeEntry already treats a missing key as UNJUDGABLE, not a crash).
export function loadSettingsByLocation(manifest, roots) {
  const settingsByLocation = {};
  for (const entry of manifest.checks) {
    for (const target of entry.install_targets ?? []) {
      if (target.kind !== "claude-settings" || settingsByLocation[target.location] !== undefined) continue;
      const resolved = resolvePlaceholderPath(target.path, roots);
      if (resolved && existsSync(resolved)) {
        try {
          settingsByLocation[target.location] = JSON.parse(readFileSync(resolved, "utf8"));
        } catch {
          settingsByLocation[target.location] = null;
        }
      }
    }
  }
  return settingsByLocation;
}

// Builds the "한계·판정불가" bullet list this report is required to carry
// (S4/G10): every structural limitation that applies regardless of what
// this particular run observed, plus the run's own UNJUDGABLE entries named
// individually so nothing is silently swept into "some checks are unclear."
export function buildLimitations({ inventoryResults, smokeCases }) {
  const limitations = [
    "Claude 전용 훅(role-guard·pm-guard·status-fresh·clear-safe-check·linear-sync·controlroom-fresh·context-inject·worker-status-onstart)은 canary 영수증 없이는 ALIVE로 판정하지 않는다(G9) -- 정적 배선만으로 '실제 Claude 런타임이 이 훅을 발화시켰다'를 증명할 수 없기 때문.",
    "이 러너 자체가 Claude Stop/PreToolUse/UserPromptSubmit 이벤트를 실제로 발생시키지 않는다 -- canary 영수증은 별도의 격리 Claude 세션이 생성해야 하며(ORCH 후속 몫), 이 실행은 그 영수증이 있으면 읽고 없으면 UNJUDGABLE로 정직하게 남긴다.",
    "review-gate·linear-sync 스모크는 실제 CLI 서브프로세스가 아니라 각 모듈이 내보내는 순수함수(checkReviewGate/diffSync)를 직접 호출한다 -- review-gate.mjs의 CLI가 fixture 경로를 오버라이드할 방법이 없고, linear-sync.mjs의 CLI는 실제 Linear 네트워크 호출을 요구하기 때문(테스트 스코프에서 fetch mock 없이 의도적으로 제외).",
    "이 러너는 루프가 스스로 돌지 않는다(부트스트랩 한계) -- 사람의 주간 트리거(HYK-123과 같은 일요일 경계) 또는 ORCH의 8일 초과 부팅 경고로만 재실행이 보장된다.",
    "로컬 훅 제거·설정 변조(Stop hook wiring 삭제, HARNESS_ROLE unset, 스크립트 직접 수정)는 이 러너 스스로 막지 못한다 -- 매 실행이 다시 확인할 뿐, 이전 실행 이후의 변조를 감지하는 상시 감시가 아니다.",
  ];
  for (const r of inventoryResults) {
    if (r.status === "UNJUDGABLE") limitations.push(`UNJUDGABLE: ${r.id} -- ${r.evidence.join("; ")}`);
  }
  const failedSmoke = smokeCases.filter((c) => !c.pass);
  for (const c of failedSmoke) limitations.push(`스모크 실패: ${c.id}:${c.variant} -- 기대와 실측 불일치`);
  return limitations;
}

export function buildReceipts({ manifestPath, manifestText, smokeZeroDiff, canaryDir }) {
  const receipts = [`static manifest: ${manifestPath} (sha256=${sha256Hex(manifestText).slice(0, 16)}...)`];
  receipts.push(`fixture smoke: OS temp only, 원본 repo diff-0=${smokeZeroDiff} (실행 전후 'git status --short' 대조)`);
  receipts.push(
    canaryDir
      ? `Claude canary receipt dir: ${canaryDir}`
      : `Claude canary receipt dir: (제공되지 않음 -- 이번 실행은 canary 없이 UNJUDGABLE로 남는 Claude 전용 항목이 있음)`,
  );
  return receipts;
}

export function runSelfcheck({
  repoRoot: root,
  manifestPath,
  controlRoomPath = "D:/문서관리/하네스-관제실",
  userHome = process.env.USERPROFILE || process.env.HOME,
  canaryDir,
  taskId = "adhoc",
  runId = `selfcheck-${taskId}`,
  now = Date.now(),
}) {
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  const manifestById = buildManifestById(manifest);

  const roots = { REPO: root, CONTROL_ROOM: controlRoomPath, USER_HOME: userHome };
  const settingsByLocation = loadSettingsByLocation(manifest, roots);
  const testFiles = discoverCheckTestFiles(join(root, "scripts", "check"));

  const { results: inventoryResults, summary } = runInventory({
    manifest,
    repoRoot: root,
    roots,
    settingsByLocation,
    canaryDir,
    now,
    testFiles,
  });

  const { cases: smokeCases, zeroDiff: smokeZeroDiff } = runSmokeSuite({ repoRoot: root });

  const limitations = buildLimitations({ inventoryResults, smokeCases });
  const receipts = buildReceipts({ manifestPath, manifestText, smokeZeroDiff, canaryDir });

  const capturedAtIso = new Date(now).toISOString();
  const nextDueMs = now + 8 * 24 * 60 * 60 * 1000;
  const text = buildReport({
    runId,
    taskId,
    capturedAt: capturedAtIso,
    repoHead: repoHead(root),
    runtimeVersions: `node ${process.version}`,
    nextDue: new Date(nextDueMs).toISOString(),
    manifestById,
    inventoryResults,
    smokeCases,
    limitations,
    receipts,
  });

  return { summary, inventoryResults, smokeCases, smokeZeroDiff, text };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/selfcheck.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let manifestPathArg;
  let canaryDir = process.env.HARNESS_CANARY_DIR;
  let controlRoomPath = process.env.HARNESS_CONTROL_ROOM_PATH || "D:/문서관리/하네스-관제실";
  let outputPath;
  let taskId = "adhoc";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest") manifestPathArg = args[++i];
    else if (args[i] === "--canary-dir") canaryDir = args[++i];
    else if (args[i] === "--control-room") controlRoomPath = args[++i];
    else if (args[i] === "--output") outputPath = args[++i];
    else if (args[i] === "--task-id") taskId = args[++i];
  }
  const root = repoRoot();
  const manifestPath = manifestPathArg || join(root, "scripts", "check", "enforcement-inventory.json");
  outputPath = outputPath || join(root, ".harness", "selfcheck-report.md");

  let result;
  try {
    result = runSelfcheck({ repoRoot: root, manifestPath, controlRoomPath, canaryDir, taskId });
  } catch (err) {
    console.error(`selfcheck: internal error (${err.message})`);
    process.exit(1);
  }

  try {
    writeReport(outputPath, result.text);
  } catch (err) {
    console.error(`selfcheck: could not write report to '${outputPath}' (${err.message})`);
    process.exit(1);
  }

  console.log(`selfcheck: report written to ${outputPath}`);
  console.log(`selfcheck: inventory summary = ${JSON.stringify(result.summary)}`);
  console.log(
    `selfcheck: smoke = ${result.smokeCases.length} case(s), ${result.smokeCases.filter((c) => !c.pass).length} failed, repo diff-0=${result.smokeZeroDiff}`,
  );
  process.exit(0);
}
