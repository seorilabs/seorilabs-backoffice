import test from "node:test";
import assert from "node:assert/strict";
import { collectionEpisodes, shouldWarnCollection } from "./collection-alerts";
const at = (minute: number) => new Date(Date.UTC(2026, 9, 11, 14, minute));
const run = (id: string, minute: number, status: string) => ({ id, startedAt: at(minute), completedAt: status === "running" ? null : at(minute), status });
test("Play 실패는 실제 첫 실패부터 60분 경계에서 한 구간으로 판정한다", () => {
  const [episode] = collectionEpisodes([run("good", 0, "observed"), run("bad", 15, "failed"), run("partial", 30, "partial"), run("unknown", 45, "running")]);
  assert.equal(episode.id, "bad");
  assert.equal(shouldWarnCollection(episode, at(74)), false);
  assert.equal(shouldWarnCollection(episode, at(75)), true);
  assert.equal(episode.recovery, null);
});
test("날짜 변경과 needs_input/partial은 새 실패 구간이 아니고 empty 완료만 회복이다", () => {
  const episodes = collectionEpisodes([run("bad", 50, "needs_input"), run("partial", 70, "partial"), run("unknown", 80, "unknown"), run("empty", 100, "empty"), run("next", 115, "failed")]);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].recovery?.id, "empty");
  assert.equal(episodes[1].id, "next");
});
test("실행 중·미확인·건강한 기록만으로 실패 지속시간을 만들지 않는다", () => {
  assert.deepEqual(collectionEpisodes([run("a", 0, "running"), run("b", 30, "unknown"), run("c", 60, "observed")]), []);
});
test("순서와 동시 시작이 뒤섞여도 완료된 healthy 관측을 이전 시각 회복으로 만들지 않는다", () => {
  const episodes = collectionEpisodes([run("healthy", 10, "observed"), run("bad", 20, "failed"), run("earlier", 0, "observed")]);
  assert.equal(episodes[0].recovery, null);
});
