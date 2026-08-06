import eslintJs from "@eslint/js";

export default [
  eslintJs.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        module: "readonly",
        require: "readonly",
        URL: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message: "Named exports only (HYK-148 Tier1) — no default export.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/scripts/relay/*", "../relay/*", "./relay/*"],
              message:
                "scripts/check/* must not import scripts/relay/* — real dependency direction is relay -> check only (A3 inventory, HYK-148).",
            },
          ],
        },
      ],
      complexity: ["error", 12],
      "max-lines-per-function": [
        "error",
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    // scripts/check/* is the side of the boundary the deny-map restricts (relay -> check only).
    files: ["scripts/check/**/*.mjs"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/scripts/relay/*", "../relay/*", "./relay/*"],
              message:
                "scripts/check/* must not import scripts/relay/* — real dependency direction is relay -> check only (A3 inventory, HYK-148).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["scripts/relay/**/*.mjs"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    // HYK-185 seat-wire (coder-task.md §2-1, explicit design requirement):
    // orch-stall-detect.mjs (scripts/supervisor/) must read seat liveness
    // through scripts/relay/adapters/orca-adapter.mjs's read-only
    // collectSeatLivenessObservation -- the same file G9
    // (orca-cli-boundary.mjs) already treats as the sole exec-call site.
    // This is a narrow, explicit exception for exactly these files
    // (production entry point + its wiring tests), not a reopening of
    // the general relay -> non-relay dependency direction.
    // HYK-185-seat-idle-1: seat-idle-wire.test.mjs is the same shape one
    // more time -- it exercises the same production entry point for the
    // new idle axis, through the same read-only adapter call.
    // HYK-185-startcheck-wire: dispatch-start-wire.test.mjs is the same
    // shape again for the new dispatch-start axis.
    // HYK-185-seat-multi: hyk185-seat-multi-repro.test.mjs is the same
    // shape once more -- it directly calls the read-only
    // collectSeatLivenessObservation/collectSeatObservationsForWorktree
    // ports on the real 2026-08-05 21:36 KST sample to show the
    // before/after difference (coder-task.md acceptance (a)).
    files: [
      "scripts/supervisor/orch-stall-detect.mjs",
      "scripts/supervisor/seat-liveness-wire.test.mjs",
      "scripts/supervisor/seat-idle-wire.test.mjs",
      "scripts/supervisor/dispatch-start-wire.test.mjs",
      "scripts/supervisor/hyk185-seat-multi-repro.test.mjs",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    // ESLint's own flat-config loader requires this file to be a default
    // export -- the one tool-mandated exception the Tier1 design doc calls
    // for ("도구가 default export를 요구하는 파일은 경로가 명시된 최소
    // override만 허용").
    files: ["eslint.config.mjs"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];
