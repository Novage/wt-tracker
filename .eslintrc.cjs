module.exports = {
    "env": {
        "es2017": true,
        "node": true,
    },
    "parserOptions": {
        "project": "tsconfig.lint.json",
        "sourceType": "module",
    },
    "extends": [
        "plugin:@typescript-eslint/eslint-recommended",
        "plugin:@typescript-eslint/recommended",
    ],
    "rules": {
        "no-console": "warn",
        "@typescript-eslint/prefer-nullish-coalescing": "error",
        "spaced-comment": ["warn", "always", { markers: ["/"] }],
        curly: ["warn", "multi-line", "consistent"],
    },
};
