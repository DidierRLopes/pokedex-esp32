#!/usr/bin/env python3
"""Hardware test: the real companion talking to the real board.

    .voice-venv/bin/python host/test_board.py [--voice] [bridge args...]

Runs pokemon_bridge's own serve loop against the board, drives the UI through
the firmware's @TEST hooks, and checks the board's logs. With --voice it also
holds the (virtual) screen while the Mac speaks a card name out loud, so the
board's real microphone, upload and Whisper are exercised end to end.
"""
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pokemon_bridge as bridge  # noqa: E402

voice = "--voice" in sys.argv
bridge_args = [a for a in sys.argv[1:] if a != "--voice"]

log_lines = []
log_lock = threading.Lock()
active_device = []


class TeeSerial(bridge.serial.Serial):
    """Serial port that also records every line the board sends. Writes are
    serialized so a test command can never land inside a companion line."""

    _pending = b""
    _write_lock = threading.Lock()

    def write(self, data):
        with self._write_lock:
            return super().write(data)

    def open(self):
        super().open()
        active_device[:] = [self]

    def read(self, size=1):
        data = super().read(size)
        if data:
            self._pending += data
            *complete, self._pending = self._pending.split(b"\n")
            with log_lock:
                log_lines.extend((time.time(), line.decode(errors="replace").strip())
                                 for line in complete)
        return data


bridge.serial.Serial = TeeSerial
failures = []


def check(condition, label):
    print(f"[test] {'PASS' if condition else 'FAIL'}: {label}", flush=True)
    if not condition:
        failures.append(label)


def mark():
    with log_lock:
        return len(log_lines)


def wait_log(needle, since, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with log_lock:
            for stamp, line in log_lines[since:]:
                if needle in line:
                    return stamp, line
        time.sleep(0.02)
    return None, None


def inject(command):
    active_device[0].write(f"@TEST {command}\n".encode())


def state():
    since = mark()
    inject("STATE")
    _, line = wait_log("@STATE", since, 3)
    return line


args = bridge.build_parser().parse_args(["--no-prewarm-images", *bridge_args])
threading.Thread(target=bridge.run, args=(args.port, args, args.website), daemon=True).start()

# 1. handshake (opening the port resets the board: it must re-greet us)
_, line = wait_log("companion ready", 0, 30)
check(line is not None, "board and companion complete the handshake")
time.sleep(1.0)

# 2. typed lookup -> first card image shown
since = mark()
t0 = time.time()
inject("QUERY charzard base")
stamp, line = wait_log("Got ", since, 15)
check(line is not None, f"typed lookup answered ({line})")
if stamp:
    print(f"[test] result on screen {stamp - t0:.2f}s after query")
first_image, line = wait_log("card on screen: base1-4", since, 20)
check(first_image is not None, "first card image shown")
if first_image:
    print(f"[test] first image shown {first_image - t0:.2f}s after query")

# 3. neighbour prefetched -> flipping is instant
time.sleep(1.5)
inject("NAV 1")
time.sleep(0.3)
after = state()
check(after is not None and " 2/" in after and after.endswith("canvas=1"),
      f"next card shows instantly from the prefetch ({after})")
inject("NAV -1")
time.sleep(0.3)
back = state()
check(back is not None and " 1/" in back and back.endswith("canvas=1"),
      f"previous card shows instantly from the cache ({back})")

# 4. nonsense lookup keeps the current results on screen
since = mark()
inject("QUERY zzzqqq")
wait_log("no matches", since, 10)
time.sleep(0.5)
kept = state()
check(kept is not None and kept.startswith("@STATE 3 1/") and kept.endswith("canvas=1"),
      f"failed lookup keeps the results and the card image ({kept})")

# 4b. touching the screen starts a new search: the old card disappears, and
#     a failed voice search leaves the listen screen, not the old card. The
#     side button ("next") brings the old results back.
time.sleep(1.8)
since = mark()
inject("HOLD 300")  # released too soon to search
time.sleep(0.15)
listening = state()
check(listening is not None and listening.startswith("@STATE 1 ") and listening.endswith("canvas=0"),
      f"listening hides the old card ({listening})")
wait_log("Recording stopped", since, 5)
time.sleep(0.3)
empty = state()
check(empty is not None and empty.startswith("@STATE 0 ") and empty.endswith("canvas=0"),
      f"a failed voice search shows the listen screen ({empty})")
inject("NAV 1")
time.sleep(0.5)
back = state()
check(back is not None and back.startswith("@STATE 3 1/") and back.endswith("canvas=1"),
      f"the side button brings the old results back ({back})")

# 5. real microphone: hold, speak through the Mac speakers, release
if voice:
    for word in ("Blastoise", "Gengar"):  # Whisper alone hears "Gengar" as "Jungle"
        time.sleep(1.8)  # let the previous screen flash finish
        since = mark()
        inject("HOLD 3200")
        time.sleep(0.5)
        subprocess.run(["say", "-v", "Samantha", word], check=True)
        _, heard = wait_log("transcript:", since, 30)
        print(f"[test] board heard: {heard}")
        _, got = wait_log("Got ", since, 30)
        check(got is not None and word in got, f"spoken {word!r} found ({got})")

# 6. hammer the next button through every result: the card that ends up on
#    screen must be the right one, with its own artwork
time.sleep(1.8)
since = mark()
inject("QUERY charizard")
wait_log("Got 10 matches", since, 15)
time.sleep(1.0)
for _ in range(12):  # past the end on purpose: the list does not wrap
    inject("NAV 1")
    time.sleep(0.05)
_, last = wait_log("navigate to match 9", since, 10)
settled = None
deadline = time.time() + 15
while time.time() < deadline:
    settled = state()
    if settled and settled.endswith("canvas=1"):
        break
    time.sleep(0.3)
last_id = settled.split()[3] if settled else "?"
_, shown = wait_log(f"card on screen: {last_id}", since, 1)
check(settled is not None and " 10/10 " in settled and settled.endswith("canvas=1"),
      f"rapid flipping lands on the last card with its image ({settled})")
check(shown is not None, f"artwork on screen belongs to {last_id}")

# 7. companion vanishes mid-lookup: the board recovers on its own
since = mark()
bridge.lookup_and_reply = lambda *a, **k: None  # swallow the next query
inject("QUERY blastoise")
time.sleep(1.0)
waiting = state()
check(waiting is not None and waiting.startswith("@STATE 2 "), f"board waits for the reply ({waiting})")
print("[test] waiting for the 30 s lookup watchdog...", flush=True)
_, timed_out = wait_log("lookup timed out", since, 40)
recovered = state()
check(timed_out is not None and recovered is not None and recovered.startswith("@STATE 3 10/10"),
      f"board gives up after 30 s and keeps the results ({recovered})")
if recovered:
    print(f"[test] internal RAM low-water mark: {recovered.split('ram_min=')[1].split()[0]} bytes")

print(f"[test] {'ALL PASS' if not failures else 'FAILED: ' + ', '.join(failures)}", flush=True)
sys.exit(1 if failures else 0)
