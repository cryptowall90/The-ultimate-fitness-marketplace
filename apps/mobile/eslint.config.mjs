import base from "@fitmarket/config/eslint";

export default [
  ...base,
  {
    ignores: [".expo/**", "expo-env.d.ts"],
  },
];
