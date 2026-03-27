#!/usr/bin/env python3
"""Wire Vector Search Service — persistent sentence-transformers model server.

Loads all-MiniLM-L6-v2 once on startup, serves vector search queries over HTTP.
Agents POST queries with a vault path, get back ranked cosine similarity results.

Runs alongside the Wire server on a separate port (default 9801).

Usage:
  python3 src/vector-service.py                    # port 9801
  VECTOR_PORT=9802 python3 src/vector-service.py   # custom port

API:
  POST /search
    body: { "query": "search text", "vault_path": "/path/to/.personai", "top_k": 5 }
    response: { "results": [...], "timing_ms": 42.5 }

  GET /health
    response: { "status": "ok", "model": "all-MiniLM-L6-v2", "uptime_s": 123 }
"""

import json
import os
import sqlite3
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

import numpy as np
from sentence_transformers import SentenceTransformer

MODEL_NAME = "all-MiniLM-L6-v2"
PORT = int(os.environ.get("VECTOR_PORT", "9801"))

# ---------------------------------------------------------------------------
# Model — loaded once, kept warm
# ---------------------------------------------------------------------------

print(f"[vector-service] loading model {MODEL_NAME}...", file=sys.stderr)
t0 = time.time()
model = SentenceTransformer(MODEL_NAME)
print(f"[vector-service] model loaded in {time.time() - t0:.1f}s", file=sys.stderr)

start_time = time.time()

# ---------------------------------------------------------------------------
# Vector search core
# ---------------------------------------------------------------------------

def blob_to_vector(blob):
    return np.frombuffer(blob, dtype=np.float32)


def vector_search(query, vault_path, top_k=5):
    vectors_db = os.path.join(vault_path, "vectors.db")
    journal_db = os.path.join(vault_path, "journal.db")

    if not os.path.exists(vectors_db):
        return []

    query_vec = model.encode(query, normalize_embeddings=True)

    conn = sqlite3.connect(vectors_db, timeout=5)
    results = []

    # Vault vectors
    vault_rows = conn.execute("SELECT path, embedding FROM vault_vectors").fetchall()
    for path, blob in vault_rows:
        vec = blob_to_vector(blob)
        score = float(np.dot(query_vec, vec))
        results.append({
            "source": path,
            "type": "vault",
            "score": score,
            "summary": "",
        })

    # Journal vectors
    journal_rows = conn.execute(
        "SELECT journal_id, embedding FROM journal_vectors"
    ).fetchall()
    if journal_rows:
        jids = [r[0] for r in journal_rows]
        summaries = {}
        if os.path.exists(journal_db):
            try:
                jconn = sqlite3.connect(journal_db, timeout=5)
                placeholders = ",".join("?" * len(jids))
                rows = jconn.execute(
                    f"SELECT id, summary FROM journal WHERE id IN ({placeholders})", jids
                ).fetchall()
                jconn.close()
                summaries = {r[0]: r[1] for r in rows}
            except Exception:
                pass

        for jid, blob in journal_rows:
            vec = blob_to_vector(blob)
            score = float(np.dot(query_vec, vec))
            results.append({
                "source": f"j:{jid}",
                "type": "journal",
                "score": score,
                "summary": summaries.get(jid, ""),
            })

    conn.close()
    results.sort(key=lambda x: -x["score"])
    return results[:top_k]


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class VectorHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Log to stderr in structured-ish format
        print(f"[vector-service] {args[0]}", file=sys.stderr)

    def do_GET(self):
        if self.path == "/health":
            self._json_response(200, {
                "status": "ok",
                "model": MODEL_NAME,
                "uptime_s": round(time.time() - start_time),
            })
        else:
            self._json_response(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/search":
            self._json_response(404, {"error": "not found"})
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._json_response(400, {"error": "empty body"})
            return

        try:
            body = json.loads(self.rfile.read(content_length))
        except json.JSONDecodeError as e:
            self._json_response(400, {"error": f"invalid json: {e}"})
            return

        query = body.get("query")
        vault_path = body.get("vault_path")
        top_k = body.get("top_k", 5)

        if not query:
            self._json_response(400, {"error": "missing query"})
            return
        if not vault_path:
            self._json_response(400, {"error": "missing vault_path"})
            return

        t0 = time.time()
        try:
            results = vector_search(query, vault_path, top_k=top_k)
            timing_ms = round((time.time() - t0) * 1000, 2)
            self._json_response(200, {
                "results": results,
                "timing_ms": timing_ms,
            })
        except Exception as e:
            self._json_response(500, {"error": str(e)})

    def _json_response(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    server = HTTPServer(("127.0.0.1", PORT), VectorHandler)
    print(f"[vector-service] listening on http://127.0.0.1:{PORT}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[vector-service] shutting down", file=sys.stderr)
        server.shutdown()


if __name__ == "__main__":
    main()
