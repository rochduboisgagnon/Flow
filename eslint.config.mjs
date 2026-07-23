import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // scripts/ are plain-CJS build utilities (icon, binary fetch), out of app scope.
  { ignores: ["dist/", "dist-build/", "node_modules/", "resources/", "scripts/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The dictation pipeline hands raw buffers around; unused vars there are bugs.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Test fixtures written as plain CommonJS (e.g. a fake sidecar server): give
    // them the Node environment and allow require(), like the scripts/ utilities.
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
