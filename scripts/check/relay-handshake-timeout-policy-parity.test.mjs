// HYK-430 1R -- relay-handshake.mjs는 격리 픽스처 제약(§2⑶ 주석,
// SHADOW_CLI_TIMEOUT_MS 위) 때문에 child-probe-timeout-policy.mjs를
// 정적 import하지 않고 같은 공식을 복제한다(loadMultiplierLocal). 이
// 시험은 그 복제가 원본과 넓은 입력 범위에서 정확히 같은 값을 내는지
// 대조해 드리프트를 기계로 잡는다 -- 한쪽만 고치면 즉시 빨개진다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMultiplierLocal } from "./relay-handshake.mjs";
import { loadMultiplier } from "./child-probe-timeout-policy.mjs";

const SAMPLE_FREE_MEM_BYTES = [
  1,
  1024,
  512 * 1024 * 1024,
  1 * 1024 * 1024 * 1024,
  2 * 1024 * 1024 * 1024,
  4 * 1024 * 1024 * 1024,
  4 * 1024 * 1024 * 1024 + 1,
  8 * 1024 * 1024 * 1024,
  400 * 1024 * 1024 * 1024,
  0,
  -1,
  NaN,
];

test("loadMultiplierLocal(relay-handshake.mjs)와 loadMultiplier(child-probe-timeout-policy.mjs)는 표본 전 구간에서 정확히 같은 값을 낸다", () => {
  for (const freeMemBytes of SAMPLE_FREE_MEM_BYTES) {
    const canonical = loadMultiplier({ freeMemBytes });
    const local = loadMultiplierLocal(freeMemBytes);
    assert.equal(
      local,
      canonical,
      `freeMemBytes=${freeMemBytes}: local=${local} canonical=${canonical} -- 두 구현이 갈렸다(드리프트)`,
    );
  }
});
