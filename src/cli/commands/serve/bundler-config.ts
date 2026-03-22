import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../../..");

// js-sha256 conditionally requires 'crypto' and 'buffer' at runtime for Node.js
// but never uses them in Temporal's V8 sandbox. Safe to ignore.
export const WORKFLOW_BUNDLER_IGNORE_MODULES = ["crypto", "buffer"];

/**
 * Webpack config hook for Temporal's workflow bundler.
 * Adds the same path aliases that tsconfig.json defines so that
 * workflow-sandbox code (workflows.ts, task-config.ts) can resolve
 * `@/…` and `@podpiper/dagraph` imports.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function webpackConfigHook(config: any): any {
  const resolve = config.resolve ?? {};
  const existing = resolve.alias ?? {};
  return {
    ...config,
    resolve: {
      ...resolve,
      alias: {
        ...existing,
        "@": path.join(ROOT, "src"),
        "@podpiper/dagraph": path.join(ROOT, "packages/dagraph/src/index.ts"),
      },
    },
  };
}
