#!/usr/bin/env python3
"""Lydia's Claude Code hook: relays each event to Lydia over a Unix socket.

Hard rule: never get in Claude Code's way.
* Lydia closed (no socket): exit 0 at once, print nothing.
* Only PermissionRequest waits for an answer ("allow" / "deny"). No answer in
  time, or Lydia says "terminal": print nothing, and Claude Code asks in the
  terminal exactly as if Lydia were not installed.
* Lydia's own chat (LYDIA_CHAT=1) is ignored.
* --owned: only for sessions Lydia runs headless (there is no terminal to ask
  in). Read-only tools pass; anything else waits for Lydia, and no answer means
  deny. Their other events reach Lydia through the session's own output.

Output format: https://code.claude.com/docs/en/hooks (PermissionRequest).
"""
import json
import os
import socket
import sys

SOCKET = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or "/tmp", "lydia.sock")
CONNECT_TIMEOUT = 0.3
SEND_TIMEOUT = 2.0
DECISION_TIMEOUT = 110  # the hook's own timeout in settings.json is 120
DROPPED = ("tool_response", "tool_result", "transcript_path")
# Tools that only look: they never need asking.
SAFE_TOOLS = {"Read", "Glob", "Grep", "LS", "TodoWrite", "WebSearch", "NotebookRead", "ToolSearch", "BashOutput"}
OWNED = "--owned" in sys.argv
MAX_FIELD = 2000


def trim(value):
    if isinstance(value, str):
        return value[:MAX_FIELD]
    if isinstance(value, dict):
        return {k: trim(v) for k, v in value.items()}
    if isinstance(value, list):
        return [trim(v) for v in value[:50]]
    return value


def main():
    if os.environ.get("LYDIA_CHAT"):
        return
    if os.environ.get("LYDIA_SESSION") and not OWNED:
        return  # the user's global hooks firing inside one of Lydia's sessions
    try:
        event = json.loads(sys.stdin.buffer.read().decode("utf-8-sig") or "{}")
    except (ValueError, OSError):
        return
    if not isinstance(event, dict):
        return
    for key in DROPPED:
        event.pop(key, None)
    event = trim(event)
    name = event.get("hook_event_name") or ""
    if OWNED:
        if name != "PreToolUse" or event.get("tool_name") in SAFE_TOOLS:
            return
        name = "OwnedToolUse"  # Lydia shows it like a permission request
    event["hook_event_name"] = name

    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(CONNECT_TIMEOUT)
        sock.connect(SOCKET)
        sock.settimeout(SEND_TIMEOUT)
        sock.sendall((json.dumps(event) + "\n").encode())
    except OSError:
        if OWNED:
            print_owned("deny", "A Lydia não está rodando para aprovar.")
        return  # Lydia is not running

    if name not in ("PermissionRequest", "OwnedToolUse"):
        sock.close()
        return

    sock.settimeout(DECISION_TIMEOUT)
    answer = b""
    try:
        while not answer.endswith(b"\n"):
            chunk = sock.recv(64)
            if not chunk:
                break
            answer += chunk
    except OSError:
        if OWNED:
            print_owned("deny", "Sem resposta na Lydia.")
        return
    finally:
        sock.close()

    decision = answer.decode(errors="ignore").strip()
    if OWNED:
        print_owned("allow" if decision == "allow" else "deny", "Negado pela Lydia." if decision == "deny" else "Sem resposta na Lydia.")
        return
    if decision == "allow":
        behavior = {"behavior": "allow"}
    elif decision == "deny":
        behavior = {"behavior": "deny", "message": "Negado pela Lydia."}
    else:
        return  # anything else: let the terminal ask
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": behavior}}))


def print_owned(decision, reason):
    out = {"hookEventName": "PreToolUse", "permissionDecision": decision}
    if decision == "deny":
        out["permissionDecisionReason"] = reason
    print(json.dumps({"hookSpecificOutput": out}))


if __name__ == "__main__":
    main()
