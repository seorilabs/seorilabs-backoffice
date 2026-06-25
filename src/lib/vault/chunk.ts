// 마크다운 → 검색 청크. 헤딩 경계로 섹션을 나누고, 큰 섹션은 문단 단위로
// ~1200자 윈도(약간 overlap)로 분할. frontmatter 제거, 헤딩 breadcrumb 보존.

export interface Chunk {
  ord: number;
  heading: string | null;
  text: string;
}

const TARGET = 1200; // 목표 청크 크기(문자)
const OVERLAP = 150; // 윈도 간 겹침(맥락 보존)
const MIN_CHARS = 12; // 너무 짧은 청크 버림

function stripFrontmatter(src: string): string {
  if (src.startsWith("---\n")) {
    const end = src.indexOf("\n---", 4);
    if (end !== -1) return src.slice(end + 4).replace(/^\s*\n/, "");
  }
  return src;
}

// 헤딩(#~######) 기준 섹션 분리. 각 섹션에 누적 breadcrumb 부여.
interface Section {
  heading: string | null;
  body: string;
}

function splitSections(src: string): Section[] {
  const lines = src.split("\n");
  const sections: Section[] = [];
  const crumb: string[] = []; // [level1, level2, ...]
  let buf: string[] = [];
  let curHeading: string | null = null;

  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) sections.push({ heading: curHeading, body });
    buf = [];
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      const title = m[2].trim();
      crumb.length = level - 1;
      crumb[level - 1] = title;
      curHeading = crumb.filter(Boolean).join(" › ");
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function windowText(text: string): string[] {
  if (text.length <= TARGET) return [text];
  const parts: string[] = [];
  // 문단 우선 분할 후 윈도로 묶음.
  const paras = text.split(/\n{2,}/);
  let cur = "";
  for (const p of paras) {
    if (cur && (cur.length + p.length + 2 > TARGET)) {
      parts.push(cur.trim());
      cur = cur.slice(Math.max(0, cur.length - OVERLAP));
    }
    cur += (cur ? "\n\n" : "") + p;
    // 단일 문단이 TARGET 초과면 강제 슬라이스.
    while (cur.length > TARGET * 1.5) {
      parts.push(cur.slice(0, TARGET).trim());
      cur = cur.slice(TARGET - OVERLAP);
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function chunkMarkdown(raw: string): Chunk[] {
  const src = stripFrontmatter(raw);
  const chunks: Chunk[] = [];
  let ord = 0;
  for (const sec of splitSections(src)) {
    for (const w of windowText(sec.body)) {
      const text = w.trim();
      if (text.length < MIN_CHARS) continue;
      // 헤딩 경로를 본문 앞에 붙여 검색 신호 강화.
      const withCrumb = sec.heading ? `# ${sec.heading}\n${text}` : text;
      chunks.push({ ord: ord++, heading: sec.heading, text: withCrumb });
    }
  }
  return chunks;
}
