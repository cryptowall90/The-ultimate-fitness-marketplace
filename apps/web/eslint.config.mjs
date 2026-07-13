import base from "@fitmarket/config/eslint";

export default [
  ...base,
  {
    ignores: [".next/**", "next-env.d.ts", "playwright-report/**"],
  },
];
