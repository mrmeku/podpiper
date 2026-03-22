import tseslint from "typescript-eslint";

const FS_MODULES = ["node:fs", "node:fs/promises", "fs", "fs/promises"];

export default tseslint.config(
  { ignores: ["node_modules/", "output/", "packages/*/node_modules/"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["src/**/*.ts", "packages/*/src/**/*.ts"],
    ignores: ["src/ports/**", "**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: FS_MODULES.map((name) => ({
            name,
            message: "Use the FileSystem port instead of direct fs imports.",
          })),
        },
      ],
    },
  },
);
