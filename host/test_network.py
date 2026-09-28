#!/usr/bin/env python3
"""Loopback test for the Wi-Fi path: act as the board over a WebSocket.

    .voice-venv/bin/python host/test_network.py "Gengar" [extra bridge args...]

Starts the companion with --listen (network only), then checks that a wrong
token is refused, and that the handshake, a spoken lookup, a typed lookup and
image transfers all work over the network exactly as they do over USB.
"""
import asyncio
import base64
import json
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

ROOT = Path(__file__).resolve().parent.parent
IMG_BYTES = 194 * 272 * 2
query = sys.argv[1] if len(sys.argv) > 1 else "Charizard"
bridge_args = sys.argv[2:]
failures = []


def check(condition, label):
    print(f"[test] {'PASS' if condition else 'FAIL'}: {label}", flush=True)
    if not condition:
        failures.append(label)


with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
token = secrets.token_urlsafe(24)
proc = subprocess.Popen(
    [str(ROOT / ".voice-venv/bin/python"), str(ROOT / "host/pokemon_bridge.py"),
     "--listen", f"127.0.0.1:{port}", "--token", token, "--no-serial", "--no-prewarm-images", *bridge_args],
    cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
)


class Link:
    """Board side of the link: whole lines out of whatever frames arrive."""

    def __init__(self, ws):
        self.ws = ws
        self.buffer = ""

    async def send(self, line: str):
        await self.ws.send(line + "\n")

    async def line(self, timeout: float):
        deadline = time.time() + timeout
        while "\n" not in self.buffer:
            left = deadline - time.time()
            if left <= 0:
                return None
            try:
                self.buffer += await asyncio.wait_for(self.ws.recv(), left)
            except (asyncio.TimeoutError, ConnectionClosed):
                return None
        line, self.buffer = self.buffer.split("\n", 1)
        return line.strip()

    async def wait_for(self, prefix: str, timeout: float = 60):
        deadline = time.time() + timeout
        while True:
            line = await self.line(deadline - time.time())
            if line is None or line.startswith(prefix):
                return line

    async def lookup_reply(self, timeout: float = 120):
        transcript = None
        while True:
            line = await self.line(timeout)
            if line is None:
                return transcript, None
            if line.startswith("@TEXT "):
                transcript = base64.b64decode(line[6:]).decode()
            elif line.startswith("@RESULT "):
                return transcript, json.loads(base64.b64decode(line[8:]))
            elif line.startswith("@ERROR "):
                print("[test] companion error:", base64.b64decode(line[7:]).decode())
                return transcript, None


async def main():
    url = f"ws://127.0.0.1:{port}/"
    for _ in range(120):  # wait for the listener (Whisper loads in the background)
        try:
            async with connect(url + "?token=wrong") as ws:
                try:
                    await asyncio.wait_for(ws.recv(), 5)
                    check(False, "a wrong token is refused")
                except ConnectionClosed as closed:
                    check(closed.rcvd is not None and closed.rcvd.code == 4001, "a wrong token is refused")
            break
        except OSError:
            await asyncio.sleep(0.5)

    async with connect(url + f"?token={token}", max_size=2 ** 22) as ws:
        link = Link(ws)
        check(await link.wait_for("@READY 2", 30) is not None, "companion greets a network board with @READY 2")
        await link.send("@HELLO 2")
        check(await link.wait_for("@READY 2", 5) is not None, "companion answers @HELLO with @READY")

        speech = Path(tempfile.gettempdir()) / "pokedex_net_test.wav"
        subprocess.run(["say", "-v", "Samantha", "--data-format=LEI16@16000", "-o", str(speech), query],
                       check=True, capture_output=True)
        with wave.open(str(speech), "rb") as w:
            pcm = w.readframes(w.getnframes())
        lines = [f"@VOICE {len(pcm)}"] + ["@DATA " + base64.b64encode(pcm[o:o + 3072]).decode()
                                          for o in range(0, len(pcm), 3072)] + ["@END"]
        # Frames split mid-line, as a cellular link would deliver them.
        blob = "\n".join(lines) + "\n"
        start = time.time()
        for o in range(0, len(blob), 1000):
            await ws.send(blob[o:o + 1000])
        transcript, result = await link.lookup_reply()
        print(f"[test] heard {transcript!r} in {time.time() - start:.2f}s")
        check(result is not None and len(result["matches"]) > 0, f"spoken {query!r} over the network returns matches")

        await link.send("@QUERY " + base64.b64encode(b"charzard base").decode())
        _, typed = await link.lookup_reply(30)
        check(typed is not None and typed["matches"] and typed["matches"][0]["name"] == "Charizard",
              "typed 'charzard base' finds Charizard over the network")

        for match in ((result or typed or {"matches": []})["matches"])[:2]:
            await link.send(f"@GETIMG {match['id']}")
            start = time.time()
            header = await link.wait_for("@IMG ", 60)
            data = bytearray()
            while header:
                line = await link.line(30)
                if line is None:
                    break
                if line.startswith("@DATA "):
                    data.extend(base64.b64decode(line[6:]))
                elif line == f"@IMGEND {match['id']}":
                    break
            check(len(data) == IMG_BYTES, f"image {match['id']} arrives complete ({time.time() - start:.2f}s)")


try:
    asyncio.run(main())
finally:
    proc.terminate()
    output = proc.communicate(timeout=10)[0]
    print("---- bridge log ----")
    print("\n".join(l for l in output.splitlines() if "Fetching" not in l).strip())

print(f"[test] {'ALL PASS' if not failures else 'FAILED: ' + ', '.join(failures)}")
sys.exit(1 if failures else 0)
