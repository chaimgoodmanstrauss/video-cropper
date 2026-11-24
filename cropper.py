#!/usr/bin/env python3
"""Tiny local video cropper: browser UI + native macOS dialogs + ffmpeg.
Run:  python3 cropper.py   (opens the UI in your browser)"""
import atexit, urllib.parse, json, os, shutil, subprocess, tempfile, threading, webbrowser, random
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(HERE, "state.json")
WORK = tempfile.mkdtemp(prefix="video_cropper_")
atexit.register(shutil.rmtree, WORK, True)
FRAME = os.path.join(WORK, "frame.jpg")
cur = {"src": None, "name": None, "open_dir": None, "rot": 0, "progress": None,
       "proc": None, "cancel": False}   # rot = quarter turns clockwise (0-3)
ROT_VF = {0: "", 1: "transpose=1", 2: "transpose=1,transpose=1", 3: "transpose=2"}


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(**kw):
    s = load_state(); s.update(kw)
    with open(STATE_FILE, "w") as f:
        json.dump(s, f, indent=1)


def osa_q(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def applescript(script):
    """Run AppleScript; return stdout stripped, or None if cancelled."""
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def loc_clause(d):
    return f" default location (POSIX file {osa_q(d)})" if d and os.path.isdir(d) else ""


def choose_save(default_name):
    """macOS save dialog, starting in the folder used last time."""
    # default: folder of the video just opened, else last save folder, else Desktop
    d = cur["open_dir"] or load_state().get("save_dir") or os.path.expanduser("~/Desktop")
    return applescript('activate\nPOSIX path of (choose file name with prompt "Save cropped video as"'
                       f" default name {osa_q(default_name)}" + loc_clause(d) + ")")


def locate(name, size, mtime):
    """Find the original of a browser-picked file (name + size + mtime) via Spotlight,
    so we can read it in place and know its folder. None if not found / ambiguous."""
    try:
        r = subprocess.run(["mdfind", "-name", name], capture_output=True, text=True, timeout=5)
    except Exception:
        return None
    hits = []
    for p in r.stdout.splitlines():
        try:
            if (os.path.basename(p) == name and os.path.getsize(p) == size
                    and abs(os.path.getmtime(p) - mtime) < 2):
                hits.append(p)
        except OSError:
            pass
    return hits[0] if len(hits) == 1 else None


def in_work(p):
    return bool(p) and os.path.abspath(p).startswith(WORK + os.sep)


def duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def grab_frame(path, rot=0):
    t = min(1.0, duration(path) / 2)
    vf = ["-vf", ROT_VF[rot]] if rot else []
    r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", path, *vf,
                        "-frames:v", "1", "-q:v", "2", FRAME], capture_output=True, text=True)
    return r.returncode == 0, r.stderr


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/?"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                return self.send(200, f.read(), "text/html; charset=utf-8")
        if self.path.startswith("/status"):
            return self.send(200, {"progress": cur["progress"]})
        if self.path.startswith("/frame.jpg"):
            if os.path.exists(FRAME):
                with open(FRAME, "rb") as f:
                    return self.send(200, f.read(), "image/jpeg")
        return self.send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if self.path == "/locate":
            d = json.loads(self.rfile.read(n) or b"{}")
            p = locate(d.get("name", ""), int(d.get("size", -1)), float(d.get("mtime", 0)) / 1000)
            if not p:
                return self.send(200, {"found": False})
            ok, err = grab_frame(p)
            if not ok:
                return self.send(200, {"error": "ffmpeg could not read frame:\n" + err})
            if in_work(cur["src"]):
                os.remove(cur["src"])
            cur.update(src=p, name=os.path.basename(p), open_dir=os.path.dirname(p), rot=0)
            save_state(open_dir=cur["open_dir"])
            return self.send(200, {"found": True, "src": p})
        if self.path == "/cancel":
            cur["cancel"] = True
            if cur["proc"] and cur["proc"].poll() is None:
                cur["proc"].terminate()
            return self.send(200, {"ok": True})
        if self.path == "/upload":
            # video chosen with the browser's own file picker, streamed to a temp copy
            name = os.path.basename(urllib.parse.unquote(self.headers.get("X-Name", "video.mp4")))
            ext = os.path.splitext(name)[1].lower() or ".mp4"
            if in_work(cur["src"]) and os.path.exists(cur["src"]):
                os.remove(cur["src"])   # only ever delete our own temp copy
            path = os.path.join(WORK, "source" + ext)
            with open(path, "wb") as f:
                left = n
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    f.write(chunk); left -= len(chunk)
            ok, err = grab_frame(path)
            if not ok:
                return self.send(200, {"error": "ffmpeg could not read frame:\n" + err})
            cur.update(src=path, name=name, open_dir=None, rot=0)
            return self.send(200, {"src": name})
        data = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/rotate":
            if not cur["src"]:
                return self.send(200, {"error": "No video loaded"})
            rot = (cur["rot"] + int(data["turn"])) % 4
            ok, err = grab_frame(cur["src"], rot)
            if not ok:
                return self.send(200, {"error": err})
            cur["rot"] = rot
            return self.send(200, {"rot": rot})
        if self.path == "/save":
            if not cur["src"]:
                return self.send(200, {"error": "No video loaded"})
            # H.264 needs even dimensions
            w, h = int(data["w"]) // 2 * 2, int(data["h"]) // 2 * 2
            x, y = int(data["x"]), int(data["y"])
            base, ext = os.path.splitext(cur["name"])
            out = choose_save(f"{base}_crop{ext.lower() or '.mp4'}")
            if not out:
                return self.send(200, {"cancelled": True})
            if os.path.abspath(out) == os.path.abspath(cur["src"]):
                return self.send(200, {"error": "Refusing to overwrite the source file"})
            save_state(save_dir=os.path.dirname(out))
            ow, oh = int(data.get("ow") or w) // 2 * 2, int(data.get("oh") or h) // 2 * 2
            sc = f"scale={ow}:{oh}:flags=lanczos" if (ow, oh) != (w, h) and ow > 0 and oh > 0 else ""
            vf = ",".join(filter(None, [ROT_VF[cur["rot"]], f"crop={w}:{h}:{x}:{y}", sc]))
            cmd = ["ffmpeg", "-y", "-v", "error", "-nostats", "-progress", "pipe:1",
                   "-i", cur["src"], "-vf", vf,
                   "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
                   *(["-an"] if data.get("mute") else ["-c:a", "aac", "-b:a", "192k"]),
                   "-movflags", "+faststart", out]
            dur = duration(cur["src"]) or 1
            cur["progress"] = 0.0
            cur["cancel"] = False
            errf = tempfile.TemporaryFile(mode="w+")
            proc = cur["proc"] = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errf, text=True)
            for line in proc.stdout:
                if line.startswith("out_time_us="):
                    try:
                        cur["progress"] = min(0.99, int(line.split("=")[1]) / 1e6 / dur)
                    except ValueError:
                        pass
            proc.wait()
            cur["progress"] = None
            cur["proc"] = None
            if cur["cancel"]:
                if os.path.exists(out):
                    os.remove(out)   # partial render
                return self.send(200, {"cancelled": True, "aborted": True})
            if proc.returncode != 0:
                errf.seek(0)
                return self.send(200, {"error": errf.read()[-2000:]})
            return self.send(200, {"out": out, "filter": vf + (", no audio" if data.get("mute") else "")})
        return self.send(404, {"error": "not found"})


if __name__ == "__main__":
    port = random.randint(20000, 59999)
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    url = f"http://127.0.0.1:{port}/"
    print("Video cropper at", url, "(Ctrl-C to quit)", flush=True)
    def launch():
        # Chrome incognito (fresh cache each run); fall back to default browser
        if subprocess.run(["open", "-na", "Google Chrome", "--args", "--incognito", url]).returncode:
            webbrowser.open(url)
    threading.Timer(0.5, launch).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
