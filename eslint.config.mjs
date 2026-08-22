import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.tsbuild/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}", "packages/contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "@insight/server",
                "@insight/server/*",
                "@insight/database",
                "@insight/database/*",
                "@insight/db",
                "@insight/db/*",
                "**/apps/server/**",
                "**/database/**",
                "**/db/**",
                "pg",
                "postgres",
              ],
              message: "Browser-safe code cannot import server, database, or Node-only modules.",
            },
          ],
        },
      ],
    },
  },
);
