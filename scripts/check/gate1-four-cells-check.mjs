// HYK-241 §2 조각3 -- CLI shell around gate1-four-cells-core.mjs.
//
// ⚠️정직 한계(coder-task §3-2 셋째 항목, 결과 파일에 그대로 반복): 이
// CLI는 «만들어졌지만 아직 아무도 부르지 않는다» -- 게이트 1 상신 문서는
// 이 저장소 밖에 쓰이므로, 배달 경로/커밋 게이트 어디에도 결선되어 있지
// 않다. 사람이 직접 `node scripts/check/gate1-four-cells-check.mjs
// <상신파일>`을 실행해야 값을 낸다. §3-3 표의 요건 3이 요구하는 «도달
// 경로»는 아직 없다 -- 결과 파일에 «무엇이 있어야 진짜 결선인가»를 적는다.
import { readFileSync, existsSync } from "node:fs";
import { checkGate1FourCells } from "./gate1-four-cells-core.mjs";

export function runGate1FourCellsCheck(argv) {
  const filePath = argv[0];
  if (!filePath) {
    return {
      ok: false,
      lines: [
        "gate1-four-cells-check: usage: node gate1-four-cells-check.mjs <gate1-proposal-file>",
      ],
    };
  }
  if (!existsSync(filePath)) {
    return {
      ok: false,
      lines: [`gate1-four-cells-check: file not found: ${filePath}`],
    };
  }
  const docText = readFileSync(filePath, "utf8");
  const result = checkGate1FourCells(docText);
  const lines = [...result.reasons];
  lines.push(
    result.ok
      ? `gate1-four-cells-check: PASS -- 후보 ${result.candidates.length}건 모두 4칸 충족`
      : "gate1-four-cells-check: RED -- 위 후보(들)에 누락/무효 칸이 있음",
  );
  return { ok: result.ok, lines };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/gate1-four-cells-check.mjs");
if (invokedDirectly) {
  const { ok, lines } = runGate1FourCellsCheck(process.argv.slice(2));
  for (const line of lines) {
    if (ok) console.log(line);
    else console.error(line);
  }
  process.exit(ok ? 0 : 1);
}
