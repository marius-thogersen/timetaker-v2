import keyboard
import threading
import queue
import select
import socket
from datetime import datetime
from zoneinfo import ZoneInfo
import time
import sys
import os
import json
import tkinter as tk
from tkinter import messagebox

# All scan timestamps sent to TimeTaker are tagged with this timezone (with a
# UTC offset, e.g. +02:00/+01:00 depending on daylight saving), so the server
# can always interpret them unambiguously regardless of what timezone the
# reader PC's clock/locale is set to. Change this if the reader runs outside
# Denmark.
LOCAL_TZ = ZoneInfo("Europe/Copenhagen")

def get_app_dir():
    if getattr(sys, 'frozen', False):
        # If the app is run from a bundle (PyInstaller)
        return os.path.dirname(sys.executable)
    else:
        # If the app is run from a script
        return os.path.dirname(os.path.abspath(__file__))

APP_LOG_FILE = os.path.join(get_app_dir(), "app.log")
SPOOL_FILE   = os.path.join(get_app_dir(), "pending_scans.json")

def log_ts() -> str:
    """Timestamp prefix for console/app.log lines, in the same local
    timezone used for scan timestamps (unambiguous regardless of what the
    reader PC's own clock/locale is set to)."""
    return datetime.now(LOCAL_TZ).strftime("%Y-%m-%d %H:%M:%S %z")

def log_console(message):
    """Prints a single timestamped line to stdout (the console, or app.log
    when running as a frozen exe with no console — see the stdout/stderr
    redirect above)."""
    print(f"[{log_ts()}] {message}")

# Loopback link to the TimeTaker desktop app. Must match SCAN_PORT in scan_server.rs.
TIMETAKER_HOST = "127.0.0.1"
TIMETAKER_PORT = 45677
CONNECT_TIMEOUT_S = 2
ACK_TIMEOUT_S = 5
RECONNECT_DELAY_S = 2

# Redirect stdout/stderr to a log file when running as a frozen exe (no console)
if getattr(sys, 'frozen', False):
    _log_stream = open(APP_LOG_FILE, 'a', buffering=1, encoding='utf-8')
    sys.stdout = _log_stream
    sys.stderr = _log_stream

current_input = []
start_time = 0
SUBMISSION_LIMITER_MS = 1000

# ── Palette ──────────────────────────────────────────────────────────────────
C_BG       = "#0b0b12"
C_PANEL    = "#13131f"
C_BORDER   = "#1e1e35"
C_ACCENT   = "#00d4ff"
C_SUCCESS  = "#00ff99"
C_ERROR    = "#ff3d6b"
C_WARN     = "#ffb300"
C_MUTED    = "#44445a"
C_TEXT     = "#dcdcf0"
C_DIM      = "#7777a0"

# Global UI references
event_log_widget = None
submission_log_widget = None
status_canvas = None
status_label  = None

# Every log line crosses a thread boundary (keyboard hook, sender), so the UI is
# only ever touched from the tkinter main loop via this queue.
ui_queue = queue.Queue()
sender = None

def _classify(message: str):
    m = message.lower()
    if any(k in m for k in ("forbundet", "success", "ok", "sendt")):
        return "success"
    if any(k in m for k in ("error", "failed", "fail", "warn", "fejl", "mistet")):
        return "error"
    if any(k in m for k in ("submitting", "sender", "started", "registering")):
        return "accent"
    return "dim"

def _tag_color(tag: str) -> str:
    return {
        "success": C_SUCCESS,
        "error":   C_ERROR,
        "accent":  C_ACCENT,
        "dim":     C_DIM,
    }.get(tag, C_TEXT)

def update_ui_log(widget, message, tag=None):
    if not widget:
        return
    widget.config(state='normal')
    ts   = datetime.now().strftime('%H:%M:%S')
    tag  = tag or _classify(message)
    color = _tag_color(tag)

    ts_tag  = f"ts_{id(message)}_{ts}"
    msg_tag = f"msg_{id(message)}_{ts}"
    widget.tag_configure(ts_tag,  foreground=C_MUTED)
    widget.tag_configure(msg_tag, foreground=color)

    widget.insert(tk.END, f"[{ts}] ", ts_tag)
    widget.insert(tk.END, f"{message}\n", msg_tag)
    widget.see(tk.END)
    widget.config(state='disabled')

def log_event(message):
    log_console(message)
    ui_queue.put(("event", message, None))

def log_submission(message):
    log_console(f"SUBMITTED: {message}")
    ui_queue.put(("submission", message, "success"))

def drain_ui_queue(root):
    while True:
        try:
            target, message, tag = ui_queue.get_nowait()
        except queue.Empty:
            break

        widget = event_log_widget if target == "event" else submission_log_widget
        update_ui_log(widget, message, tag)

    root.after(100, drain_ui_queue, root)

def refresh_status(root):
    if sender and status_canvas and status_label:
        pending = sender.pending_count()
        if sender.connected:
            color = C_SUCCESS
            text = "TimeTaker forbundet" if pending == 0 else f"Sender ({pending})"
        else:
            color = C_WARN if pending else C_ERROR
            text = f"Venter på TimeTaker ({pending} i kø)" if pending else "TimeTaker ikke åben"

        status_canvas.itemconfig("dot", fill=color, outline=color)
        status_label.config(text=text, fg=color)

    root.after(500, refresh_status, root)


class ScanSender(threading.Thread):
    """Delivers scans to the desktop app over a loopback socket.

    Scans are only removed from the queue once the app acknowledges them, and
    the queue survives a restart, so a closed desktop app never loses a lap.
    """

    def __init__(self):
        super().__init__(daemon=True)
        self._lock = threading.Lock()
        self._pending = self._load_spool()
        self._socket = None
        self._reader = None
        self.connected = False

    def pending_count(self):
        with self._lock:
            return len(self._pending)

    def submit(self, payload):
        with self._lock:
            self._pending.append(payload)
            self._save_spool()

    def run(self):
        if self._pending:
            log_event(f"{len(self._pending)} scan(s) fra sidste session i kø")

        while True:
            # Connect even while idle, so the operator sees a green light before the race.
            if not self._ensure_connection():
                time.sleep(RECONNECT_DELAY_S)
                continue

            with self._lock:
                payload = self._pending[0] if self._pending else None

            if payload is None:
                self._wait_idle()
                continue

            outcome = self._deliver(payload)
            if outcome == "ok":
                log_submission(f"Code: {payload['code']}")
                self._pop()
            elif outcome == "rejected":
                log_event(f"Scan afvist af TimeTaker: {payload['code']}")
                self._pop()
            else:
                self._drop_connection()

    def _wait_idle(self):
        """Sleep, but wake early if TimeTaker closes the connection."""
        try:
            readable, _, _ = select.select([self._socket], [], [], 0.15)
        except OSError:
            readable = True

        if readable:
            self._drop_connection()

    def _ensure_connection(self):
        if self._socket is not None:
            return True

        try:
            self._socket = socket.create_connection(
                (TIMETAKER_HOST, TIMETAKER_PORT), timeout=CONNECT_TIMEOUT_S
            )
            self._socket.settimeout(ACK_TIMEOUT_S)
            self._reader = self._socket.makefile("r", encoding="utf-8")
            self.connected = True
            log_event(f"Forbundet til TimeTaker på port {TIMETAKER_PORT}")
            return True
        except OSError:
            self._drop_connection(quiet=True)
            return False

    def _deliver(self, payload):
        try:
            self._socket.sendall((json.dumps(payload) + "\n").encode("utf-8"))
            line = self._reader.readline()
            if not line:
                return "retry"

            response = json.loads(line)
            if response.get("status") == "ok":
                return "ok"

            return "rejected"
        except (OSError, ValueError):
            return "retry"

    def _drop_connection(self, quiet=False):
        was_connected = self.connected
        self.connected = False

        for closable in (self._reader, self._socket):
            try:
                if closable:
                    closable.close()
            except OSError:
                pass

        self._reader = None
        self._socket = None

        if was_connected and not quiet:
            log_event("Forbindelse til TimeTaker mistet - forsøger igen")

    def _pop(self):
        with self._lock:
            if self._pending:
                self._pending.pop(0)
            self._save_spool()

    def _load_spool(self):
        try:
            if not os.path.exists(SPOOL_FILE):
                return []
            with open(SPOOL_FILE, "r", encoding="utf-8") as handle:
                data = json.load(handle)
                return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def _save_spool(self):
        try:
            with open(SPOOL_FILE, "w", encoding="utf-8") as handle:
                json.dump(self._pending, handle)
        except OSError as error:
            log_console(f"Could not persist queue: {error}")


def log_key(key):
    global start_time, SUBMISSION_LIMITER_MS
    if ((time.time() * 1000) - start_time) > float(SUBMISSION_LIMITER_MS):
        if len(current_input) > 0:
            log_event(f"Invalid time. resetting numbers")
        current_input.clear()

    number = parse_number(key.name)
    if len(current_input) == 0 and number != 0:
        return
    if len(current_input) == 0 and number == 0:
        start_time = time.time() * 1000
        current_input.append(key.name)
        log_event(f"Started code capture: 0")
        return

    if 0 <= number <= 9:
        current_input.append(key.name)
        return
    elif key.name == 'enter':
        if is_code_complete(current_input):
            now = time.time() * 1000
            msg = f"Submitting code. Registration took {int(now - start_time)} ms"
            log_event(msg)
            submit_input(current_input)
        else:
            log_event(f"Incomplete code: {''.join(current_input)}")
    current_input.clear()


def _glow_frame(parent, **kw):
    """A dark panel with a subtle neon border."""
    outer = tk.Frame(parent, bg=C_ACCENT, padx=1, pady=1)
    inner = tk.Frame(outer, bg=C_PANEL, **kw)
    inner.pack(fill='both', expand=True)
    return outer, inner

def _label(parent, text, size=9, bold=False, color=C_DIM):
    f = ("Segoe UI", size, "bold" if bold else "normal")
    return tk.Label(parent, text=text, font=f, bg=C_PANEL, fg=color)

def _log_widget(parent, height):
    txt = tk.Text(
        parent, height=height, state='disabled',
        bg=C_BG, fg=C_TEXT, insertbackground=C_ACCENT,
        relief='flat', bd=0,
        font=("Consolas", 9),
        selectbackground=C_BORDER, selectforeground=C_TEXT,
    )
    sb = tk.Scrollbar(parent, command=txt.yview, bg=C_BORDER,
                      troughcolor=C_BG, relief='flat', bd=0)
    txt.configure(yscrollcommand=sb.set)
    return txt, sb

def main():
    global event_log_widget, submission_log_widget, status_canvas, status_label, saved_limiter_ms, sender

    root = tk.Tk()
    root.title("RFID Reader")
    root.geometry("500x620")
    root.configure(bg=C_BG)
    root.resizable(True, True)

    # ── Header ────────────────────────────────────────────────────────────────
    hdr = tk.Frame(root, bg=C_BG)
    hdr.pack(fill='x', padx=14, pady=(14, 6))
    tk.Label(hdr, text="RFID READER", font=("Segoe UI", 16, "bold"),
             bg=C_BG, fg=C_ACCENT).pack(side='left')

    # Connection dot + label
    conn_frame = tk.Frame(hdr, bg=C_BG)
    conn_frame.pack(side='right', anchor='center')
    status_canvas = tk.Canvas(conn_frame, width=12, height=12,
                              bg=C_BG, highlightthickness=0)
    status_canvas.create_oval(2, 2, 10, 10, fill=C_MUTED, outline=C_MUTED, tags="dot")
    status_canvas.pack(side='left', padx=(0, 4))
    status_label = tk.Label(conn_frame, text="Checking…", font=("Segoe UI", 9),
                            bg=C_BG, fg=C_DIM)
    status_label.pack(side='left')

    # ── Limiter ───────────────────────────────────────────────────────────────
    lim_outer, lim_inner = _glow_frame(root, padx=10, pady=8)
    lim_outer.pack(fill='x', padx=14, pady=6)

    _label(lim_inner, "SUBMISSION LIMITER", bold=True, color=C_DIM).pack(anchor='w')

    lim_row = tk.Frame(lim_inner, bg=C_PANEL)
    lim_row.pack(fill='x', pady=(4, 0))

    saved_limiter_ms = SUBMISSION_LIMITER_MS
    limiter_var = tk.StringVar(value=str(saved_limiter_ms))

    limiter_entry = tk.Entry(
        lim_row, textvariable=limiter_var, width=8,
        bg=C_BG, fg=C_TEXT, insertbackground=C_ACCENT,
        relief='flat', bd=4, font=("Consolas", 11),
        selectbackground=C_BORDER,
    )
    limiter_entry.pack(side='left')

    tk.Label(lim_row, text="ms", font=("Segoe UI", 9), bg=C_PANEL, fg=C_DIM).pack(side='left', padx=(4, 12))

    saved_label = tk.Label(lim_row, text=f"saved: {saved_limiter_ms} ms",
                           font=("Segoe UI", 9), bg=C_PANEL, fg=C_MUTED)
    saved_label.pack(side='left', padx=(0, 10))

    save_btn = tk.Button(
        lim_row, text="SAVE", state='disabled',
        bg=C_MUTED, fg=C_BG, activebackground=C_SUCCESS, activeforeground=C_BG,
        relief='flat', bd=0, padx=10, pady=3,
        font=("Segoe UI", 9, "bold"), cursor="hand2",
    )
    save_btn.pack(side='left')

    def on_save_limiter():
        global SUBMISSION_LIMITER_MS, saved_limiter_ms
        try:
            val = int(limiter_var.get())
            if val <= 0:
                return
            SUBMISSION_LIMITER_MS = val
            saved_limiter_ms = val
            saved_label.config(text=f"saved: {val} ms", fg=C_MUTED)
            limiter_entry.config(bg=C_BG)
            save_btn.config(state='disabled', bg=C_MUTED)
            log_event(f"Submission limiter updated to {val} ms")
        except ValueError:
            pass

    save_btn.config(command=on_save_limiter)

    def on_limiter_change(*args):
        try:
            val = int(limiter_var.get())
            changed = val != saved_limiter_ms and val > 0
            limiter_entry.config(bg="#2a2a10" if changed else C_BG)
            save_btn.config(
                state='normal' if changed else 'disabled',
                bg=C_SUCCESS if changed else C_MUTED,
                fg=C_BG,
            )
        except ValueError:
            limiter_entry.config(bg="#2a0a10")
            save_btn.config(state='disabled', bg=C_MUTED)

    limiter_var.trace_add("write", on_limiter_change)

    # ── Event Log ─────────────────────────────────────────────────────────────
    ev_outer, ev_inner = _glow_frame(root, padx=10, pady=8)
    ev_outer.pack(fill='x', padx=14, pady=6)
    _label(ev_inner, "EVENTS", bold=True, color=C_DIM).pack(anchor='w', pady=(0, 4))

    ev_row = tk.Frame(ev_inner, bg=C_BG)
    ev_row.pack(fill='x')
    event_log_widget, ev_sb = _log_widget(ev_row, height=5)
    event_log_widget.pack(side='left', fill='both', expand=True)
    ev_sb.pack(side='right', fill='y')

    # ── Submission History ────────────────────────────────────────────────────
    sub_outer, sub_inner = _glow_frame(root, padx=10, pady=8)
    sub_outer.pack(fill='both', expand=True, padx=14, pady=6)
    _label(sub_inner, "SUBMISSION HISTORY", bold=True, color=C_DIM).pack(anchor='w', pady=(0, 4))

    sub_row = tk.Frame(sub_inner, bg=C_BG)
    sub_row.pack(fill='both', expand=True)
    submission_log_widget, sub_sb = _log_widget(sub_row, height=10)
    submission_log_widget.pack(side='left', fill='both', expand=True)
    sub_sb.pack(side='right', fill='y')

    # ── Stop Button ───────────────────────────────────────────────────────────
    def on_stop():
        if messagebox.askokcancel("Quit", "Stop RFID Reader?"):
            clean_exit(root)

    tk.Button(
        root, text="■  STOP", command=on_stop,
        bg=C_ERROR, fg="white", activebackground="#cc2244", activeforeground="white",
        relief='flat', bd=0, padx=20, pady=8,
        font=("Segoe UI", 10, "bold"), cursor="hand2",
    ).pack(pady=(0, 14))

    keyboard.on_press(log_key)
    root.protocol("WM_DELETE_WINDOW", on_stop)

    sender = ScanSender()
    sender.start()

    drain_ui_queue(root)
    refresh_status(root)
    log_event(f"Sender scans til {TIMETAKER_HOST}:{TIMETAKER_PORT}")

    try:
        root.mainloop()
    except KeyboardInterrupt:
        log_console("Program terminated by user.")
        clean_exit(root)


def clean_exit(root):
    keyboard.unhook_all()
    root.destroy()
    sys.exit(0)


def parse_number(number_input):
    try:
        return int(number_input)
    except ValueError:
        return -1


def is_code_complete(code_arr):
    return len(code_arr) == 10 and code_arr[0] == '0'

def submit_input(code_arr):
    code_str = "".join(code_arr)
    log_event(f"Registering code: {code_str}")
    payload = {"time": datetime.now(LOCAL_TZ).isoformat(timespec="milliseconds"), "code": code_str}

    if sender:
        sender.submit(payload)

    current_input.clear()


if __name__ == "__main__":
    main()
