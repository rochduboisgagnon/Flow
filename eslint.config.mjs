import js from "@eslint/js";
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
);
