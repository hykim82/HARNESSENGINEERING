// HYK-292 I3 -- CLI shell around stale-pointer-core.mjs.
//
// ⛔저장소 코드에 관제실 절대경로를 하드코딩하지 않는다 -- 검사 대상
// 파일 목록은 --files(쉼표 구분)로 주입받는다.
//
// 출력 계약(PM 사람이 칠 명령과 동일 관측 단위): 실패한 각 히트를
// `<path>:<line>: <label> -- <line text>`로 먼저 나열하고, 마지막 1줄에
// `stale_pointer_hits=<n>`, 종료코드 0(0건)/1(1건 이상)/2(대상 파일 자체를
// 못 읽음 -- fail-closed).
import { readFileSync, existsSync } from "node:fs";
import { checkStalePointers } from "./stale-pointer-core.mjs";

function parseArgs(argv) {
  let filesArg = process.env.HARNESS_STALE_POINTER_FILES;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--files") filesArg = argv[++i];
  }
  return { filesArg };
}

export function runStalePointerCheck(argv) {
  const { filesArg } = parseArgs(argv);
  if (!filesArg) {
    return {
      ok: false,
      exitCode: 2,
      lines: [
        "stale-pointer-check: usage: node stale-pointer-check.mjs --files <path1,path2,...>",
      ],
    };
  }

  const paths = filesArg
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paths.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      lines: [
        "stale-pointer-check: --files resolved to an empty list -- refusing to vacuously pass",
      ],
    };
  }

  const files = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      return {
        ok: false,
        exitCode: 2,
        lines: [`stale-pointer-check: file not found: ${path}`],
      };
    }
    files.push({ path, content: readFileSync(path, "utf8") });
  }

  const result = checkStalePointers({ files });
  const lines = result.hits.map(
    (h) => `${h.path}:${h.lineNumber}: ${h.label} -- ${h.line.trim()}`,
  );
  lines.push(`stale_pointer_hits=${result.staleHits}`);
  return { ok: result.ok, exitCode: result.ok ? 0 : 1, lines };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/stale-pointer-check.mjs");
if (invokedDirectly) {
  const { ok, exitCode, lines } = runStalePointerCheck(process.argv.slice(2));
  for (const line of lines) {
    if (ok) console.log(line);
    else console.error(line);
  }
  process.exit(exitCode);
}
