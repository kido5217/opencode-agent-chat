import { describe, expect, test } from "bun:test";
import { Membership } from "../src/core/membership.ts";

function setup() {
  const rows: Array<{ root: string; body: string }> = [];
  let now = 1;
  const membership = new Membership({
    now: () => now,
    appendSystemMessage: (root, body) => {
      rows.push({ root, body });
    },
  });
  return {
    membership,
    rows,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("root lifecycle", () => {
  test("joins as main, records the join, is busy, and leaves", () => {
    const { membership, rows, setNow } = setup();
    membership.sessionCreated({ id: "root", agentType: "build" });
    expect(membership.rootFor("root")).toBe("root");
    expect(membership.nameFor("root")).toBeNull();
    expect(membership.isLive("root")).toBe(false);

    setNow(10);
    membership.executionStarted("root");
    expect(rows).toEqual([{ root: "root", body: "main joined" }]);
    expect(membership.nameFor("root")).toBe("main");
    expect(membership.isLive("root")).toBe(true);
    expect(membership.roster("root")).toEqual([
      { sessionID: "root", name: "main", agentType: "build", busy: true, joinedAt: 10 },
    ]);

    setNow(20);
    membership.executionEnded("root", "completed");
    expect(rows).toEqual([
      { root: "root", body: "main joined" },
      { root: "root", body: "main left (completed)" },
    ]);
    expect(membership.isLive("root")).toBe(false);
    expect(membership.roster("root")).toEqual([]);
  });

  test("leave rows carry the failed and interrupted outcomes", () => {
    for (const outcome of ["failed", "interrupted"] as const) {
      const { membership, rows } = setup();
      membership.sessionCreated({ id: "root" });
      membership.executionStarted("root");
      membership.executionEnded("root", outcome);
      expect(rows[1]).toEqual({ root: "root", body: `main left (${outcome})` });
    }
  });

  test("end without a start, a double end, and unknown sessions are silent", () => {
    const { membership, rows } = setup();
    membership.executionEnded("ghost", "completed");
    membership.sessionCreated({ id: "root" });
    membership.executionEnded("root", "completed");
    membership.executionStarted("root");
    membership.executionEnded("root", "completed");
    membership.executionEnded("root", "failed");
    membership.executionStarted("ghost");
    expect(rows).toEqual([
      { root: "root", body: "main joined" },
      { root: "root", body: "main left (completed)" },
    ]);
    expect(membership.nameFor("ghost")).toBeNull();
    expect(membership.isLive("ghost")).toBe(false);
  });
});

describe("repeated starts and reconcile", () => {
  test("a repeated start while live does not duplicate the join row", () => {
    const { membership, rows, setNow } = setup();
    membership.sessionCreated({ id: "root" });
    membership.executionStarted("root");
    setNow(5);
    membership.executionStarted("root");
    expect(rows).toEqual([{ root: "root", body: "main joined" }]);
    membership.executionEnded("root", "completed");
    setNow(9);
    membership.executionStarted("root");
    expect(rows.map((r) => r.body)).toEqual(["main joined", "main left (completed)", "main joined"]);
  });

  test("a start whose root is unknown is not live", () => {
    const { membership } = setup();
    membership.sessionCreated({ id: "child", parentID: "missing", agentType: "explore" });
    membership.executionStarted("child");
    expect(membership.isLive("child")).toBe(false);
    expect(membership.roster("missing")).toEqual([]);
  });

  test("reconcile demotes members absent from the list", () => {
    const { membership, rows, setNow } = setup();
    membership.sessionCreated({ id: "root" });
    membership.executionStarted("root");
    setNow(3);
    membership.sessionCreated({ id: "kid", parentID: "root", agentType: "explore" });
    membership.executionStarted("kid");
    membership.reconcile([{ id: "root", agentType: "build", live: true }]);
    expect(membership.isLive("kid")).toBe(false);
    expect(membership.roster("root").map((p) => p.name)).toEqual(["main"]);
    expect(rows.map((r) => r.body)).toEqual(["main joined", "explore joined"]);
  });
});

describe("child naming", () => {
  test("suffixes only on live collisions and never renames", () => {
    const { membership, rows, setNow } = setup();
    membership.sessionCreated({ id: "root", agentType: "build" });
    membership.sessionCreated({ id: "c1", parentID: "root", agentType: "explore" });
    membership.sessionCreated({ id: "c2", parentID: "root", agentType: "explore" });
    membership.sessionCreated({ id: "c3", parentID: "root", agentType: "explore" });

    setNow(1);
    membership.executionStarted("root");
    setNow(2);
    membership.executionStarted("c1");
    setNow(3);
    membership.executionStarted("c2");
    setNow(4);
    membership.executionStarted("c3");

    expect(membership.nameFor("c1")).toBe("explore");
    expect(membership.nameFor("c2")).toBe("explore-2");
    expect(membership.nameFor("c3")).toBe("explore-3");
    expect(rows).toEqual([
      { root: "root", body: "main joined" },
      { root: "root", body: "explore joined" },
      { root: "root", body: "explore-2 joined" },
      { root: "root", body: "explore-3 joined" },
    ]);
    expect(membership.roster("root").map((p) => p.name)).toEqual(["main", "explore", "explore-2", "explore-3"]);

    setNow(5);
    membership.executionEnded("c1", "completed");
    setNow(6);
    membership.executionStarted("c1");
    expect(membership.nameFor("c1")).toBe("explore");
  });

  test("a name held by a gone participant frees up", () => {
    const { membership, setNow } = setup();
    membership.sessionCreated({ id: "root" });
    membership.sessionCreated({ id: "c1", parentID: "root", agentType: "explore" });
    membership.sessionCreated({ id: "c2", parentID: "root", agentType: "explore" });
    membership.sessionCreated({ id: "c3", parentID: "root", agentType: "explore" });
    setNow(1);
    membership.executionStarted("root");
    setNow(2);
    membership.executionStarted("c1");
    setNow(3);
    membership.executionStarted("c2");
    setNow(4);
    membership.executionEnded("c1", "completed");
    setNow(5);
    membership.executionStarted("c3");
    expect(membership.nameFor("c3")).toBe("explore");
    expect(membership.roster("root").map((p) => p.name)).toEqual(["main", "explore-2", "explore"]);

    setNow(6);
    membership.executionEnded("c2", "completed");
    setNow(7);
    membership.sessionCreated({ id: "c4", parentID: "root", agentType: "explore" });
    membership.executionStarted("c4");
    expect(membership.nameFor("c4")).toBe("explore-2");
  });

  test("a rejoin keeps the frozen name and emits a second join row", () => {
    const { membership, rows, setNow } = setup();
    membership.sessionCreated({ id: "root" });
    membership.sessionCreated({ id: "c1", parentID: "root", agentType: "explore" });
    membership.sessionCreated({ id: "c2", parentID: "root", agentType: "explore" });
    setNow(1);
    membership.executionStarted("root");
    setNow(2);
    membership.executionStarted("c1");
    setNow(3);
    membership.executionEnded("c1", "completed");
    setNow(4);
    membership.executionStarted("c2");
    setNow(5);
    membership.executionStarted("c1");
    expect(membership.nameFor("c1")).toBe("explore");
    expect(membership.isLive("c1")).toBe(true);
    expect(membership.roster("root").map((p) => p.name)).toEqual(["main", "explore", "explore"]);
    expect(membership.roster("root").map((p) => p.sessionID)).toEqual(["root", "c2", "c1"]);
    expect(rows).toEqual([
      { root: "root", body: "main joined" },
      { root: "root", body: "explore joined" },
      { root: "root", body: "explore left (completed)" },
      { root: "root", body: "explore joined" },
      { root: "root", body: "explore joined" },
    ]);
  });

  test("children without an agent type fall back to subagent", () => {
    const { membership, rows } = setup();
    membership.sessionCreated({ id: "root" });
    membership.sessionCreated({ id: "c1", parentID: "root" });
    membership.executionStarted("c1");
    expect(membership.nameFor("c1")).toBe("subagent");
    expect(rows).toEqual([{ root: "root", body: "subagent joined" }]);
    expect(membership.roster("root")[0]).toEqual({
      sessionID: "c1",
      name: "subagent",
      agentType: "subagent",
      busy: true,
      joinedAt: 1,
    });
  });

  test("name collisions are scoped to the root", () => {
    const { membership } = setup();
    membership.sessionCreated({ id: "root1" });
    membership.sessionCreated({ id: "root2" });
    membership.sessionCreated({ id: "a", parentID: "root1", agentType: "explore" });
    membership.sessionCreated({ id: "b", parentID: "root2", agentType: "explore" });
    membership.executionStarted("a");
    membership.executionStarted("b");
    expect(membership.nameFor("a")).toBe("explore");
    expect(membership.nameFor("b")).toBe("explore");
  });

  test("main is reserved for the root even when a child starts first", () => {
    const { membership, rows, setNow } = setup();
    membership.sessionCreated({ id: "root", agentType: "build" });
    membership.sessionCreated({ id: "c1", parentID: "root", agentType: "main" });
    setNow(1);
    membership.executionStarted("c1");
    expect(membership.nameFor("c1")).toBe("main-2");
    setNow(2);
    membership.executionStarted("root");
    expect(membership.nameFor("root")).toBe("main");
    expect(rows).toEqual([
      { root: "root", body: "main-2 joined" },
      { root: "root", body: "main joined" },
    ]);
    expect(membership.roster("root").map((p) => p.name)).toEqual(["main-2", "main"]);
  });
});

describe("lineage", () => {
  test("a grandchild resolves through the chain to the root", () => {
    const { membership, rows } = setup();
    membership.sessionCreated({ id: "root", agentType: "build" });
    membership.sessionCreated({ id: "child", parentID: "root", agentType: "plan" });
    membership.sessionCreated({ id: "grand", parentID: "child", agentType: "explore" });
    expect(membership.rootFor("grand")).toBe("root");
    membership.executionStarted("grand");
    expect(membership.nameFor("grand")).toBe("explore");
    expect(rows).toEqual([{ root: "root", body: "explore joined" }]);
  });

  test("a parent that appears later repairs root resolution", () => {
    const { membership } = setup();
    membership.sessionCreated({ id: "child", parentID: "missing", agentType: "explore" });
    expect(membership.rootFor("child")).toBeNull();
    expect(membership.nameFor("child")).toBeNull();
    membership.sessionCreated({ id: "missing", parentID: "root", agentType: "plan" });
    membership.sessionCreated({ id: "root", agentType: "build" });
    expect(membership.rootFor("child")).toBe("root");
  });

  test("reconcile upserts lineage before resolving, whatever the order", () => {
    const { membership, rows, setNow } = setup();
    membership.sessionCreated({ id: "child", parentID: "missing", agentType: "explore" });
    setNow(50);
    membership.reconcile([
      { id: "child", parentID: "missing", agentType: "explore", live: true },
      { id: "missing", parentID: "root", agentType: "plan" },
      { id: "root", agentType: "build", live: true },
    ]);
    expect(rows).toEqual([]);
    expect(membership.rootFor("child")).toBe("root");
    expect(membership.nameFor("child")).toBe("explore");
    expect(membership.isLive("child")).toBe(true);
    expect(membership.isLive("missing")).toBe(false);
    expect(membership.roster("root").map((p) => p.name)).toEqual(["explore", "main"]);
  });
});

describe("reconcile", () => {
  test("registers live sessions busy without emitting any row", () => {
    const { membership, rows, setNow } = setup();
    setNow(7);
    membership.reconcile([
      { id: "root", agentType: "build", live: true },
      { id: "a", parentID: "root", agentType: "explore", live: true },
      { id: "b", parentID: "root", agentType: "explore", live: true },
      { id: "gone", parentID: "root", agentType: "explore", live: false },
    ]);
    expect(rows).toEqual([]);
    expect(membership.nameFor("root")).toBe("main");
    expect(membership.nameFor("a")).toBe("explore");
    expect(membership.nameFor("b")).toBe("explore-2");
    expect(membership.nameFor("gone")).toBeNull();
    expect(membership.isLive("gone")).toBe(false);
    expect(membership.roster("root")).toEqual([
      { sessionID: "root", name: "main", agentType: "build", busy: true, joinedAt: 7 },
      { sessionID: "a", name: "explore", agentType: "explore", busy: true, joinedAt: 7 },
      { sessionID: "b", name: "explore-2", agentType: "explore", busy: true, joinedAt: 7 },
    ]);

    setNow(8);
    membership.executionEnded("a", "failed");
    expect(rows).toEqual([{ root: "root", body: "explore left (failed)" }]);

    setNow(9);
    membership.sessionCreated({ id: "c", parentID: "root", agentType: "explore" });
    membership.executionStarted("c");
    expect(membership.nameFor("c")).toBe("explore");
  });

  test("a live session that is already registered keeps its name and join time", () => {
    const { membership, rows, setNow } = setup();
    membership.sessionCreated({ id: "root", agentType: "build" });
    membership.sessionCreated({ id: "a", parentID: "root", agentType: "explore" });
    setNow(3);
    membership.executionStarted("root");
    setNow(4);
    membership.executionStarted("a");
    const before = membership.roster("root");
    setNow(99);
    membership.reconcile([
      { id: "root", agentType: "build", live: true },
      { id: "a", parentID: "root", agentType: "explore", live: true },
    ]);
    expect(rows.length).toBe(2);
    expect(membership.roster("root")).toEqual(before);
  });
});

describe("roster", () => {
  test("orders live participants by joinedAt and drops the gone", () => {
    const { membership, setNow } = setup();
    membership.sessionCreated({ id: "root" });
    membership.sessionCreated({ id: "a", parentID: "root", agentType: "explore" });
    membership.sessionCreated({ id: "b", parentID: "root", agentType: "plan" });
    setNow(1);
    membership.executionStarted("root");
    setNow(2);
    membership.executionStarted("a");
    setNow(3);
    membership.executionStarted("b");
    expect(membership.roster("root").map((p) => p.name)).toEqual(["main", "explore", "plan"]);

    setNow(4);
    membership.executionEnded("a", "completed");
    setNow(5);
    membership.executionStarted("b");
    setNow(6);
    membership.executionStarted("a");
    expect(membership.roster("root").map((p) => p.name)).toEqual(["main", "plan", "explore"]);
    expect(membership.roster("other")).toEqual([]);
  });
});
