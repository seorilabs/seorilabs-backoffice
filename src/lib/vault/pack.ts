// float32 벡터 ↔ Uint8Array(BLOB) 패킹. MySQL 에 ANN 인덱스가 없으므로
// 임베딩을 little-endian float32 로 저장하고 앱에서 풀어 cosine 계산.
// Prisma Bytes 는 Uint8Array(plain ArrayBuffer) 를 기대 → DataView 로 직접 패킹.

export function packFloat32(vec: number[]): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(vec.length * 4);
  const dv = new DataView(ab);
  for (let i = 0; i < vec.length; i++) dv.setFloat32(i * 4, vec[i], true);
  return new Uint8Array(ab);
}

export function unpackFloat32(buf: Uint8Array): Float32Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = Math.floor(buf.byteLength / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

// 사전 정규화하지 않으므로 일반 cosine. (질의/문서 각 1회 계산이라 비용 무시 가능)
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
