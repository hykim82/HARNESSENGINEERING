// HYK-226-activation-invariant-1 (coder-task.md) -- CLI shell around
// activation-dependency-core.mjs. This is the thing a delivery tool
// (관제실 dispatch-worker.ps1, patched per §3's wording file, NOT this
// repo) is meant to call before trusting that a patch's repo-relative
// script references are actually deployable: it reads the patch text,
// runs the pure core's judgment, and prints ONE verdict line + per-path
// detail, exiting 0/2/1 per the core's closed state set. Git I/O lives
// here only -- the core (§1 비타협: 판단은 저장소, 관제실은 얇은 껍데기와
// 같은 이유로, 여기서는 "판단 코어 vs CLI 배선"의 같은 분리) never touches
// child_process or fs.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import {
  judgeActivationDependency,
  ACTIVATION_DEPENDENCY_STATE,
} from "./activation-dependency-core.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--patch") out.patch = argv[++i];
    else if (argv[i] === "--patch-text") out.patchText = argv[++i];
    else if (argv[i] === "--ref") out.ref = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

// "존재"의 정의 = 커밋된 ref에 있다(coder-task.md §1-2 비타협). 두 단계로
// 나눈다(실측: `git cat-file -e <ref>:<path>`는 "ref 자체가 무효"와
// "ref는 유효하나 그 안에 path가 없다"를 exit code로 구별하지 않는다 --
// 둘 다 exit 128 "fatal: ..."로 동일하다):
//   1) ref 자체가 실재하는 커밋으로 해석되는지 먼저 확인한다. 이게
//      실패하면(오타난 ref, origin이 없는 워크트리 등) "조회 실패"로
//      그대로 throw해 core가 UNJUDGABLE로 판정하게 한다.
//   2) ref가 유효할 때만 그 ref 안에 path가 있는지를 cat-file -e로 묻는다
//      -- 이 단계의 실패는 "그 ref엔 그 경로가 없다"는 정상 응답이라
//      false로 접는다. 작업트리 존재나 인덱스(스테이징) 존재는 이 호출에
//      전혀 관여하지 않는다.
function gitCatFileExists(ref, path) {
  execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${path}`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function runActivationDependencyCheck(argv) {
  const args = parseArgs(argv);
  if (!args.patch && !args.patchText) {
    return {
      state: null,
      exitCode: 1,
      lines: [
        "activation-dependency-check: usage: node activation-dependency-check.mjs (--patch <file> | --patch-text <text>) [--ref <ref>]",
      ],
    };
  }
  let patchText;
  if (args.patchText) {
    patchText = args.patchText;
  } else {
    if (!existsSync(args.patch)) {
      return {
        state: null,
        exitCode: 1,
        lines: [
          `activation-dependency-check: --patch 파일이 없음: ${args.patch}`,
        ],
      };
    }
    patchText = readFileSync(args.patch, "utf8");
  }
  const ref = args.ref || "origin/master";

  const result = judgeActivationDependency({
    patchText,
    ref,
    checkRefPathExists: gitCatFileExists,
  });

  const lines = [
    `activation-dependency-check: ${result.state} -- ${result.reason}`,
  ];
  if (result.references.length > 0) {
    lines.push(
      `  참조 ${result.references.length}개: ${result.references.join(", ")}`,
    );
  }
  if (Array.isArray(result.missing) && result.missing.length > 0) {
    lines.push(`  누락(ref에 커밋 안 됨): ${result.missing.join(", ")}`);
  }
  return { state: result.state, exitCode: result.exitCode, lines };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/activation-dependency-check.mjs");
if (invokedDirectly) {
  const { state, exitCode, lines } = runActivationDependencyCheck(
    process.argv.slice(2),
  );
  for (const line of lines) {
    if (state === ACTIVATION_DEPENDENCY_STATE.ALLOW) console.log(line);
    else console.error(line);
  }
  process.exit(exitCode);
}
