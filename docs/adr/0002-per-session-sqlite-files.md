# One SQLite file per session

Each opencode session's chat lives in its own SQLite file under the opencode data directory (`~/.local/share/opencode/chats/<session-id>.db`), in WAL mode, holding that chat's messages, cursors, and schema version. Agent-bus prior art favors one shared database with scoping keys; we chose per-session files because a chat's lifetime is exactly its session's, isolation comes free, and concurrent sessions never contend for a writer. Rows therefore carry no `session_id`; the file is the scope.
