#!/usr/bin/env python3
"""Capture pixel-exact screens from the real board for docs and videos.

    .voice-venv/bin/python host/capture_screens.py OUT_DIR [--name NAME] [bridge args...]

Runs the companion against the board (stop any other companion first), then
walks the board through a lookup: idle, listening, searching, and each
result as the side button steps through them. The lookup is typed through
@TEST QUERY so room noise can't spoil it; the result screens are the same
ones a spoken lookup produces. Every screen is pulled
with the firmware's @TEST SNAPSHOT hook, so the PNGs are exactly what the
panel shows.
"""
import base64
import json
import sys
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pokemon_bridge as bridge  # noqa: E402

out_dir = Path(sys.argv[1])
rest = sys.argv[2:]
name = "Venusaur"
if "--name" in rest:
    i = rest.index("--name")
    name = rest[i + 1]
    del rest[i:i + 2]
steps = 9  # results to capture (all of them for Venusaur)
out_dir.mkdir(parents=True, exist_ok=True)

lines: list[str] = []
lock = threading.Lock()
device = []


class TeeSerial(bridge.serial.Serial):
    _pending = b""
    _write_lock = threading.Lock()

    def write(self, data):
        with self._write_lock:
            return super().write(data)

    def open(self):
        super().open()
        device[:] = [self]

    def read(self, size=1):
        data = super().read(size)
        if data:
            self._pending += data
            *complete, self._pending = self._pending.split(b"\n")
            with lock:
                lines.extend(c.decode(errors="replace").strip() for c in complete)
        return data


bridge.serial.Serial = TeeSerial


def mark():
    with lock:
        return len(lines)


def wait_for(needle, since, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with lock:
            for line in lines[since:]:
                if needle in line:
                    return line
        time.sleep(0.02)
    raise TimeoutError(needle)


def inject(command):
    device[0].write(f"@TEST {command}\n".encode())


def snapshot(label):
    since = mark()
    inject("SNAPSHOT")
    header = wait_for("@SNAP ", since, 10)
    wait_for("@SNAPEND", since, 20)
    w, h, stride = map(int, header.split()[1:])
    with lock:
        block = lines[since:]
    start = next(i for i, l in enumerate(block) if l.startswith("@SNAP "))
    data = bytearray()
    for l in block[start + 1:]:
        if l == "@SNAPEND":
            break
        if l.startswith("@SNAPDATA "):
            data.extend(base64.b64decode(l[10:]))
    px = np.frombuffer(bytes(data), dtype="<u2").reshape(h, stride // 2)[:, :w].astype(np.uint32)
    rgb = np.dstack([((px >> 11) & 31) * 255 // 31, ((px >> 5) & 63) * 255 // 63, (px & 31) * 255 // 31]).astype(np.uint8)
    path = out_dir / f"{label}.png"
    Image.fromarray(rgb).save(path)
    print(f"captured {path.name} ({w}x{h})", flush=True)


# Hold the reply a moment so the searching screen can be captured.
real_lookup = bridge.lookup_and_reply
hold_reply = threading.Event()


holding = threading.Event()  # set only around the typed lookup


def slow_lookup(*a, **k):
    if not holding.is_set():
        return real_lookup(*a, **k)
    # Reply from another thread: blocking here would stall the serial reader.
    def later():
        hold_reply.wait(15)
        real_lookup(*a, **k)
    threading.Thread(target=later, daemon=True).start()


bridge.lookup_and_reply = slow_lookup

# Keep exactly what the board was sent, so the video's numbers match its screen.
real_send = bridge.send_lookup_result


def recording_send(board, transcript, matches):
    if matches:
        (out_dir / "results.json").write_text(json.dumps({"transcript": transcript, "matches": matches}, indent=1))
    return real_send(board, transcript, matches)


bridge.send_lookup_result = recording_send

args = bridge.build_parser().parse_args(["--no-prewarm-images", *rest])
threading.Thread(target=bridge.run, args=(args.port, args, args.website), daemon=True).start()
wait_for("companion ready", 0, 60)
time.sleep(1.0)

snapshot("01-idle")
since = mark()
inject("HOLD 900")  # listening screen only; the lookup itself is typed below
time.sleep(0.3)
snapshot("02-listening")
wait_for("Recording stopped", since, 10)
time.sleep(2.5)
since = mark()
holding.set()
inject(f"QUERY {name}")  # same result screens as a spoken lookup, without room noise
time.sleep(0.4)
for k in range(4):  # the Poké Ball spins while the Mac works
    snapshot(f"03-searching-{k}")
since = mark()
hold_reply.set()
try:
    first = wait_for("card on screen:", since, 30).split("card on screen:")[1].strip()
except TimeoutError:
    with lock:
        print("\n".join(l[:120] for l in lines[since:] if not l.startswith("@SNAPDATA")))
    raise
time.sleep(0.3)
snapshot("04-result-1")
for k in range(2, steps + 1):
    since = mark()
    inject("NAV 1")
    card = wait_for("card on screen:", since, 30).split("card on screen:")[1].strip()
    time.sleep(0.3)
    snapshot(f"04-result-{k}")
    print("  ", card, flush=True)
print("first card:", first)
