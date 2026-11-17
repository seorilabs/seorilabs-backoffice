// 테스트 전용 fake kubectl 도우미. `kubectl create --dry-run=client -o json`처럼
// 매니페스트의 각 YAML 문서를 JSON 객체 한 줄씩 출력한다. 실제 배포는 kubectl이 해석한다.
const fs = require("node:fs");
const YAML = require("yaml");

for (const file of process.argv.slice(2)) {
  for (const doc of YAML.parseAllDocuments(fs.readFileSync(file, "utf8"))) {
    if (doc.errors.length > 0) {
      process.stderr.write(`error: ${file}: ${doc.errors[0].message}\n`);
      process.exit(1);
    }
    const value = doc.toJS();
    if (value != null) process.stdout.write(`${JSON.stringify(value)}\n`);
  }
}
