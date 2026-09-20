import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

type Row = {
  id: number;
  sender_type: string;
  sender_name: string;
  kind: string;
  to_name: string | null;
  in_reply_to: number | null;
  body: string;
  created_at: number;
};

const args = process.argv.slice(2);
const follow = args.includes("--follow");
const listIdx = args.indexOf("--list");
const vIdx = args.indexOf("--variant");
const variant = (vIdx >= 0 ? args[vIdx + 1] : "A").toUpperCase();

const glyph: Record<string, string> = {
  status: "●",
  question: "?",
  answer: "✓",
  blocker: "!",
  finding: "★",
  handoff: "→",
  system: "·",
};

const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

const rel = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};

const wrap = (text: string, width: number, indent: string) => {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l) => indent + l).join("\n");
};

const cut = (text: string, n: number) => (text.length > n ? text.slice(0, n - 1) + "…" : text);

const open = (db: Database) =>
  db
    .query<Row, []>(`SELECT * FROM messages ORDER BY id`)
    .all()
    .filter((m) => m.kind === "question")
    .filter((q) => !db.query<Row, [number]>(`SELECT * FROM messages WHERE kind = 'answer' AND in_reply_to = ?1`).all(q.id).length);

const roster = (msgs: Row[]) => {
  const live = new Set<string>(["main"]);
  for (const m of msgs) {
    if (m.kind !== "system") continue;
    if (m.body.endsWith(" joined")) live.add(m.body.replace(" joined", ""));
    if (m.body.includes(" left")) live.delete(m.body.split(" ")[0]);
  }
  return [...live];
};

const list = (dir: string) => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sqlite") || f.endsWith(".db"));
  console.log(`chats in ${dir}\n`);
  for (const f of files) {
    const db = new Database(join(dir, f), { readonly: true });
    const n = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM messages`).get()!.n;
    const last = db.query<{ t: number | null }, []>(`SELECT MAX(created_at) AS t FROM messages`).get()!.t;
    const q = open(db).length;
    console.log(`  ${basename(f).padEnd(26)} ${String(n).padStart(4)} messages   last ${last ? rel(last) + " ago" : "-"}   open questions ${q}`);
    db.close();
  }
};

const renderA = (name: string, msgs: Row[]) => {
  const lines: string[] = [];
  lines.push(`chat ${name}  ·  ${msgs.length} messages  ·  live: ${roster(msgs).join(", ")}`);
  lines.push("-".repeat(78));
  for (const m of msgs) {
    const to = m.to_name ? `→ ${m.to_name} ` : "";
    if (m.kind === "system") {
      lines.push(`${clock(m.created_at)}  ·  ${m.body}`);
      continue;
    }
    lines.push(`${clock(m.created_at)}  ${m.sender_name.padEnd(9)} ${m.kind.padEnd(8)} ${to}${cut(m.body, 78 - 30 - m.sender_name.length)}`);
  }
  lines.push("-".repeat(78));
  for (const q of open(db)) lines.push(`open  [${q.id}] ${q.sender_name} → ${q.to_name ?? "everyone"}: ${cut(q.body, 60)}`);
  console.log(lines.join("\n"));
};

const renderB = (name: string, msgs: Row[]) => {
  const lines: string[] = [];
  lines.push(`CHAT ${name} — live: ${roster(msgs).join(", ")}`);
  const qs = open(db);
  if (qs.length) {
    lines.push("");
    lines.push("OPEN QUESTIONS");
    for (const q of qs) lines.push(wrap(`[${q.id}] ${q.sender_name} asks ${q.to_name ?? "everyone"}: ${q.body}`, 74, "  "));
  }
  lines.push("");
  lines.push("TRANSCRIPT");
  let current = "";
  for (const m of msgs) {
    if (m.kind === "system") {
      lines.push("");
      lines.push(`  — ${m.body} (${clock(m.created_at)}) —`);
      current = "";
      continue;
    }
    if (m.sender_name !== current) {
      current = m.sender_name;
      lines.push("");
      lines.push(`── ${m.sender_name} ──`);
    }
    const head = `[${m.id}] ${clock(m.created_at)} ${m.kind}${m.to_name ? " → " + m.to_name : ""}`;
    lines.push(`  ${head}`);
    lines.push(wrap(m.body, 72, "      "));
  }
  console.log(lines.join("\n"));
};

const chunks = (text: string, width: number) => {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > width) {
      out.push(line);
      line = w;
    } else {
      line = line ? line + " " + w : w;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
};

const sysIdx = args.indexOf("--sys");
const sysStyle = sysIdx >= 0 ? args[sysIdx + 1] : "arrow";
const sysGlyph = (body: string) => {
  const join = body.endsWith(" joined");
  switch (sysStyle) {
    case "plus":
      return join ? "+" : "-";
    case "circled":
      return join ? "⊕" : "⊖";
    case "arrow":
      return join ? "→" : "←";
    case "info":
      return "i";
    default:
      return "·";
  }
};

const renderC = (name: string, msgs: Row[]) => {
  const lines: string[] = [];
  lines.push(`chat ${name} · ${roster(msgs).join(", ")} · ${open(db).length} open`);
  const idWidth = String(msgs[msgs.length - 1]?.id ?? 0).length;
  for (const m of msgs) {
    const head = `${clock(m.created_at)} [${String(m.id).padStart(idWidth)}]`;
    const prefix =
      m.kind === "system"
        ? `${head} ${sysGlyph(m.body)}`
        : `${head} ${glyph[m.kind] ?? "?"} ${m.sender_name}${m.to_name ? " → " + m.to_name : ""}`;
    const body = chunks(m.body, Math.max(40, 100 - prefix.length - 1));
    lines.push(`${prefix} ${body[0]}`);
    for (const extra of body.slice(1)) lines.push(" ".repeat(prefix.length + 1) + extra);
  }
  console.log(lines.join("\n"));
};

if (listIdx >= 0) {
  const dir = args[listIdx + 1] ?? process.env.HOME + "/.local/share/opencode/chats";
  list(dir);
  process.exit(0);
}

const dbPath = args.find((a) => !a.startsWith("--") && a !== variant);
if (!dbPath) {
  console.error("usage: bun prototype/minimal-viewer.ts <db> [--variant A|B|C] [--follow] | --list [dir]");
  process.exit(1);
}

const db = new Database(dbPath);
const name = basename(dbPath).replace(/\.(sqlite|db)$/, "");
const all = () => db.query<Row, []>(`SELECT * FROM messages ORDER BY id`).all();

if (variant === "A") renderA(name, all());
else if (variant === "B") renderB(name, all());
else renderC(name, all());

if (follow) {
  console.log("\n──── live ────");
  let max = db.query<{ m: number }, []>(`SELECT COALESCE(MAX(id), 0) AS m FROM messages`).get()!.m;
  setInterval(() => {
    for (const m of db.query<Row, [number]>(`SELECT * FROM messages WHERE id > ?1 ORDER BY id`).all(max)) {
      max = m.id;
      const to = m.to_name ? `→ ${m.to_name} ` : "";
      if (m.kind === "system") console.log(`${clock(m.created_at)}  ·  ${m.body}`);
      else console.log(`${clock(m.created_at)}  ${m.sender_name.padEnd(9)} ${m.kind.padEnd(8)} ${to}${cut(m.body, 60)}`);
    }
  }, 500);
}
