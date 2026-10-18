import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextVitals,
  ...nextTypeScript,
  {
    // React Compiler는 사용하지 않는다. 이번 런타임 수정에서 기존 화면의
    // effect와 ref 설계를 바꾸지 않고 이전 lint 범위를 유지한다.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
    },
  },
  {
    ignores: ["node_modules/**", ".next/**", "scripts-dist/**", "src/generated/**"],
  },
];

export default eslintConfig;
