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
