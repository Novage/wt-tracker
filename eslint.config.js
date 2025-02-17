// @ts-check

import globals from "globals";
import eslint from "@eslint/js";
import tsEslint from "typescript-eslint";

export default tsEslint.config(
  /** @type {(typeof tsEslint.configs.eslintRecommended)[]} */ ([
    eslint.configs.recommended,
    tsEslint.configs.eslintRecommended,
    ...tsEslint.configs.strictTypeChecked,
    ...tsEslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        globals: {
          ...globals.node,
        },

        ecmaVersion: 2022,
        sourceType: "module",

        parserOptions: {
          project: ["tsconfig.json"], // TODO: change to tsconfig.ling.json after fixing linter issues
        },
      },

      rules: {
        "@typescript-eslint/consistent-type-definitions": "off",
        "@typescript-eslint/no-unused-vars": [
          "warn",
          { argsIgnorePattern: "^_" },
        ],
        "@typescript-eslint/restrict-template-expressions": [
          "error",
          { allowNumber: true },
        ],
        "@typescript-eslint/no-confusing-void-expression": [
          "error",
          { ignoreArrowShorthand: true },
        ],
        "@typescript-eslint/no-unnecessary-condition": [
          "error",
          { allowConstantLoopConditions: true },
        ],

        "no-var": "error",
        "no-alert": "warn",
        "prefer-const": "error",
        "prefer-spread": "error",
        "no-multi-assign": "error",
        "prefer-template": "error",
        "object-shorthand": "error",
        "no-nested-ternary": "error",
        "no-array-constructor": "error",
        "prefer-object-spread": "error",
        "prefer-arrow-callback": "error",
        "prefer-destructuring": ["error", { object: true, array: false }],
        "no-console": "warn",
        curly: ["warn", "multi-line", "consistent"],
        "no-debugger": "warn",
        "spaced-comment": ["warn", "always", { markers: ["/"] }],
      },
    },
  ]),
);
