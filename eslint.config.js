import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "error",
    },
  },
  {
    // Type-aware rules: every TypeScript file is part of tsconfig.json.
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    // The logger is the one place allowed to write to the console.
    files: ["src/shared/logger.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Build/CI scripts run on Node and report through the console.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
    rules: { "no-console": "off" },
  }
);
