module.exports = {
  env: {
    es2020: true,
    node: true,
  },
  parserOptions: {
    project: "tsconfig.lint.json",
    sourceType: "module",
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended-type-checked",
  ],
  rules: {
    "no-console": "warn",
    "@typescript-eslint/prefer-nullish-coalescing": "error",
    "spaced-comment": ["warn", "always", { markers: ["/"] }],
    curly: ["warn", "multi-line", "consistent"],
    "object-shorthand": ["error", "always"],
  },
};
