import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `dialfire/` holds Dialfire voice-platform agent scripts, not backend source. They run in the
    // Dialfire runtime with its own globals (`temp`, `LOG`, `XTDate`, …) and must not be linted by
    // the backend's TypeScript-oriented config.
    ignores: ["dist/**", "coverage/**", "dialfire/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
      parserOptions: {
        // tsconfig.check.json is the only project covering src, tests, and scripts.
        project: "./tsconfig.check.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettier,
);
