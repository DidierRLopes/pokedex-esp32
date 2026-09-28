#!/usr/bin/env python3
"""Loopback test: act as the ESP32 against host/pokemon_bridge.py over a pty.

    .voice-venv/bin/python host/test_bridge.py "Charizard" [extra bridge args...]

Covers the handshake, a voice lookup (with an upload line split across a
pause, which used to corrupt audio), a typed lookup, and id-tagged image
transfers.
"""
import base64
import json
import os
import pty
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMG_BYTES = 194 * 272 * 2

query = sys.argv[1] if len(sys.argv) > 1 else "Charizard"
bridge_args = sys.argv[2:]

master_fd, slave_fd = pty.openpty()
slave_name = os.ttyname(slave_fd)
proc = subprocess.Popen(
    [str(ROOT / ".voice-venv/bin/python"), str(ROOT / "host/pokemon_bridge.py"),
     "--port", slave_name, "--no-prewarm-images", *bridge_args],
    cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
)
buffer = b""
failures = []


def check(condition, label):
    print(f"[test] {'PASS' if condition else 'FAIL'}: {label}")
    if not condition:
        failures.append(label)


def read_line(timeout):
    global buffer
    deadline = time.time() + timeout
    while time.time() < deadline:
        if b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            return line.decode(errors="replace").strip()
        try:
            chunk = os.read(master_fd, 65536)
        except BlockingIOError:
            time.sleep(0.01)
            continue
        except OSError:
            break
        if not chunk:
            break
        buffer += chunk
    return None


def send(line: bytes):
    os.write(master_fd, line + b"\n")


def wait_for(prefix, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = read_line(deadline - time.time())
        if line is None:
            return None
        if line.startswith(prefix):
            return line
    return None


def lookup_reply(timeout=120):
    transcript = None
    while True:
        line = read_line(timeout)
        if line is None:
            return transcript, None
        if line.startswith("@TEXT "):
            transcript = base64.b64decode(line[6:]).decode()
        elif line.startswith("@RESULT "):
            return transcript, json.loads(base64.b64decode(line[8:]))
        elif line.startswith("@ERROR "):
            print(f"[test] bridge error: {base64.b64decode(line[7:]).decode()}")
            return transcript, None


def fetch_image(card_id):
    send(f"@GETIMG {card_id}".encode())
    start = time.time()
    header = wait_for("@IMG ", 60)
    if header is None or header.split()[1:] != [card_id, "194", "272"]:
        return None, header
    data = bytearray()
    while True:
        line = read_line(30)
        if line is None:
            return None, "timeout"
        if line.startswith("@DATA "):
            data.extend(base64.b64decode(line[6:]))
        elif line == f"@IMGEND {card_id}":
            return bytes(data), time.time() - start


try:
    # 1. handshake: bridge greets on connect, and answers a (re)booting board
    check(wait_for("@READY 2", 30) is not None, "bridge sends @READY 2 on connect")
    send(b"@HELLO 2")
    check(wait_for("@READY 2", 5) is not None, "bridge answers @HELLO with @READY")

    # 2. voice lookup, with one @DATA line split by a pause longer than the
    #    bridge's serial timeout
    speech = Path(tempfile.gettempdir()) / "pokedex_test.wav"
    subprocess.run(["say", "-v", "Samantha", "--data-format=LEI16@16000", "-o", str(speech), query],
                   check=True, capture_output=True)
    with wave.open(str(speech), "rb") as wav:
        pcm = wav.readframes(wav.getnframes())
    send(f"@VOICE {len(pcm)}".encode())
    for index, offset in enumerate(range(0, len(pcm), 3072)):
        line = b"@DATA " + base64.b64encode(pcm[offset:offset + 3072]) + b"\n"
        if index == 1:
            os.write(master_fd, line[:500])
            time.sleep(0.6)
            os.write(master_fd, line[500:])
        else:
            os.write(master_fd, line)
    start = time.time()
    send(b"@END")
    transcript, result = lookup_reply()
    print(f"[test] heard {transcript!r} in {time.time() - start:.2f}s")
    check(result is not None and len(result["matches"]) > 0, f"voice lookup for {query!r} returns matches")
    if result:
        print("[test] top:", [(m["id"], m["name"], m["price"], m["owned"]) for m in result["matches"][:3]])

    # 3. typed lookup with a typo
    send(b"@QUERY " + base64.b64encode(b"charzard base"))
    start = time.time()
    _, typed = lookup_reply(30)
    check(typed is not None and typed["matches"] and typed["matches"][0]["name"] == "Charizard",
          f"typed 'charzard base' finds Charizard ({time.time() - start:.2f}s)")

    # 4. id-tagged image transfers, back to back
    matches = (result or typed or {"matches": []})["matches"]
    for match in matches[:2]:
        data, elapsed = fetch_image(match["id"])
        check(data is not None and len(data) == IMG_BYTES,
              f"image {match['id']} arrives complete and tagged ({elapsed})")
finally:
    proc.terminate()
    output = proc.communicate(timeout=10)[0]
    print("---- bridge log ----")
    print(output.strip())

print(f"[test] {'ALL PASS' if not failures else 'FAILED: ' + ', '.join(failures)}")
sys.exit(1 if failures else 0)
