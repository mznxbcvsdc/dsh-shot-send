"""dsh-shot-send · Windows 全屏框选（精简版：只框选，不标注）。

一次进程做完三件事：
    抓屏（GDI BitBlt，内存位图）
    → 原生全屏浮层：冻结帧 1:1 铺满屏幕、整屏压暗、拖拽框选
    → 松手即完成，裁剪并编码 PNG，base64 走 stdout

为什么要有这个进程：DSH 桌面端禁止渲染层使用 getDisplayMedia，而网页内的遮罩只能
覆盖应用窗口、把桌面缩进窗口里选。要做到「整个屏幕变暗、在真实像素上框选」，
必须由一个能创建置顶全屏窗口的进程来做。

与带标注的完整版相比：没有工具条、没有颜色、没有撤销——框完就走。
这让浮层只剩一件事要正确，也为插件市场留一个最小的维护面。

环境变量：
    DSH_SHOT_HIDE=0     截图前不最小化本应用窗口
    DSH_SHOT_HIDE=dry   只报告隐藏决策（诊断用）

退出码：
    0  成功，stdout = 裁剪后 PNG 的 base64
    2  用户取消（Esc / 右键）
    3  抓屏失败
    4  无可用显示
    5  运行环境不可用（缺 ctypes / tkinter）

自检：python shot-win32.py --selftest   （不开窗口，只跑纯函数断言）
"""

import base64
import ctypes
import ctypes.wintypes as wt
import os
import struct
import sys
import time
import zlib

# ---------- Win32 常量 ----------

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
BI_RGB = 0
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79
SW_MINIMIZE, SW_RESTORE = 6, 9
TH32CS_SNAPPROCESS = 0x00000002
MAX_PATH = 260

# ---------- 交互常量 ----------

MIN_SELECT = 8
DIM_LEVEL = 0.42
FONT = ("Microsoft YaHei UI", 13)
FONT_HINT = ("Microsoft YaHei UI", 14)


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
        ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wt.DWORD * 3)]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)), ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD), ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", wt.LONG), ("dwFlags", wt.DWORD),
        ("szExeFile", wt.WCHAR * MAX_PATH),
    ]


# ============================================================
# 纯函数区：几何、裁剪、PNG 编码（可被 --selftest 覆盖）
# ============================================================

def norm_rect(x1, y1, x2, y2):
    """两个角点 → 规范化矩形（宽高恒为正）。"""
    return (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))


def is_selectable(rect):
    """太小的拖拽视为误触，不当作一次框选。"""
    if rect is None:
        return False
    return (rect[2] - rect[0]) >= MIN_SELECT and (rect[3] - rect[1]) >= MIN_SELECT


def crop_bgra(raw, w, h, sel):
    """按选区裁剪 top-down BGRA 缓冲，返回可写缓冲。"""
    x1, y1, x2, y2 = sel
    x1 = max(0, min(x1, w))
    x2 = max(0, min(x2, w))
    y1 = max(0, min(y1, h))
    y2 = max(0, min(y2, h))
    cw, ch = x2 - x1, y2 - y1
    if cw <= 0 or ch <= 0:
        return bytearray(), 0, 0
    stride = w * 4
    out = bytearray(cw * ch * 4)
    for row in range(ch):
        src = (y1 + row) * stride + x1 * 4
        dst = row * cw * 4
        out[dst:dst + cw * 4] = raw[src:src + cw * 4]
    return out, cw, ch


def png_from_bgra(raw, w, h, level=6):
    """BGRA → RGB（filter 0）→ zlib → 最小 PNG（color type 2）。"""
    stride = w * 4
    rows = bytearray()
    for y in range(h):
        line = raw[y * stride:(y + 1) * stride]
        rows.append(0)
        rgb = bytearray(w * 3)
        rgb[0::3] = line[2::4]
        rgb[1::3] = line[1::4]
        rgb[2::3] = line[0::4]
        rows += rgb

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(rows), level)) + chunk(b"IEND", b""))


def dim_table(level=DIM_LEVEL):
    """压暗用的字节翻译表（C 速度，与合成器无关）。"""
    return bytes(min(255, int(i * level)) for i in range(256))


# ============================================================
# Win32
# ============================================================

def load_libraries():
    try:
        return (ctypes.WinDLL("user32", use_last_error=True),
                ctypes.WinDLL("gdi32", use_last_error=True),
                ctypes.WinDLL("kernel32", use_last_error=True))
    except OSError as error:
        sys.stderr.write(f"cannot load Win32 libraries: {error}\n")
        raise SystemExit(5)


def ancestor_pids(kernel32, start=None):
    """从当前进程向上回溯的 PID 集合（含自身）。"""
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == -1:
        return {os.getpid()}
    parents = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            while True:
                parents[entry.th32ProcessID] = entry.th32ParentProcessID
                if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                    break
    finally:
        kernel32.CloseHandle(snapshot)
    chain, pid = set(), (start if start is not None else os.getpid())
    while pid and pid not in chain:
        chain.add(pid)
        pid = parents.get(pid, 0)
    return chain


def own_foreground_window(user32, kernel32):
    """前台窗口若属于本应用祖先进程，返回 hwnd；否则 None。"""
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value or pid.value not in ancestor_pids(kernel32):
        return None
    if not user32.IsWindowVisible(hwnd):
        return None
    return hwnd


def grab(user32, gdi32, x, y, w, h):
    """BitBlt 一块屏幕区域，返回 top-down BGRA 字节。"""
    screen = user32.GetDC(0)
    if not screen:
        sys.stderr.write("GetDC(0) failed\n")
        raise SystemExit(3)
    mem = gdi32.CreateCompatibleDC(screen)
    bitmap = gdi32.CreateCompatibleBitmap(screen, w, h)
    previous = gdi32.SelectObject(mem, bitmap)
    try:
        if not gdi32.BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY):
            sys.stderr.write("BitBlt failed\n")
            raise SystemExit(3)
        info = BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.bmiHeader.biWidth = w
        info.bmiHeader.biHeight = -h
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = BI_RGB
        buffer = ctypes.create_string_buffer(w * h * 4)
        if not gdi32.GetDIBits(mem, bitmap, 0, h, buffer, ctypes.byref(info), DIB_RGB_COLORS):
            sys.stderr.write("GetDIBits failed\n")
            raise SystemExit(3)
        return buffer.raw
    finally:
        gdi32.SelectObject(mem, previous)
        gdi32.DeleteObject(bitmap)
        gdi32.DeleteDC(mem)
        user32.ReleaseDC(0, screen)


# ============================================================
# 浮层：只有框选
# ============================================================

class ShotOverlay:
    """全屏置顶浮层：压暗底图 + 选区内还原原色，松手即完成。"""

    def __init__(self, root, dim_photo, bright_photo, w, h):
        import tkinter as tk
        self.tk = tk
        self.root = root
        self.w, self.h = w, h
        self.sel = None
        self.drag_from = None
        self.done = False
        self.cancelled = False
        self._hole_photo = None

        self.canvas = tk.Canvas(root, width=w, height=h, highlightthickness=0, bd=0,
                                bg="black", cursor="crosshair")
        self.canvas.pack(fill="both", expand=True)
        # 两个图层：底图＝整屏压暗；亮块＝选区内的原色裁剪。
        self._dim_source = bright_photo
        self._dim_photo = dim_photo
        self.base = self.canvas.create_image(0, 0, anchor="nw", image=dim_photo)
        self.hole = self.canvas.create_image(0, 0, anchor="nw")

        self.sel_box = self.canvas.create_rectangle(0, 0, 0, 0, outline="#4FC3F7", width=2)
        self.size_bg = self.canvas.create_rectangle(0, 0, 0, 0, fill="#0B1017", outline="")
        self.size_label = self.canvas.create_text(0, 0, text="", anchor="se", fill="#EAF4FF", font=FONT)
        self.hint = self.canvas.create_text(w // 2, 46, text="拖拽框选，松手即完成 · Esc 取消",
                                            fill="#F2F7FF", font=FONT_HINT)

        self.canvas.bind("<Button-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_move)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<Button-3>", lambda event: self.cancel())
        root.bind("<Escape>", lambda event: self.cancel())
        root.focus_force()
        self._hide_chrome()

    # ---- 视觉 ----

    def _hide_chrome(self):
        for item in (self.sel_box, self.size_bg, self.size_label):
            self.canvas.itemconfigure(item, state="hidden")

    def reveal(self, rect):
        """选区内恢复原色：底图是压暗版，这里贴一块原图裁剪。"""
        if rect is None:
            self.canvas.itemconfigure(self.hole, image="")
            self._hole_photo = None
            return
        x1, y1, x2, y2 = rect
        x1, y1 = max(0, int(x1)), max(0, int(y1))
        x2, y2 = min(self.w, int(x2)), min(self.h, int(y2))
        if x2 - x1 < 1 or y2 - y1 < 1:
            self.canvas.itemconfigure(self.hole, image="")
            self._hole_photo = None
            return
        crop = self.tk.PhotoImage()
        crop.tk.call(crop, "copy", self._dim_source, "-from", x1, y1, x2, y2)
        self.canvas.itemconfigure(self.hole, image=crop)
        self.canvas.coords(self.hole, x1, y1)
        self._hole_photo = crop

    def draw_selection(self, rect):
        if not is_selectable(rect):
            self._hide_chrome()
            return
        x1, y1, x2, y2 = rect
        self.canvas.coords(self.sel_box, x1, y1, x2, y2)
        self.canvas.itemconfigure(self.sel_box, state="normal")
        self.canvas.coords(self.size_label, min(self.w - 8, x2 - 6), min(self.h - 8, y2 - 6))
        self.canvas.itemconfigure(self.size_label, text=f"{x2 - x1} × {y2 - y1}", state="normal")
        box = self.canvas.bbox(self.size_label)
        if box is not None:
            self.canvas.coords(self.size_bg, box[0] - 7, box[1] - 3, box[2] + 7, box[3] + 3)
            self.canvas.itemconfigure(self.size_bg, state="normal")
            self.canvas.tag_raise(self.size_label)
        self.canvas.tag_raise(self.sel_box)

    # ---- 交互 ----

    def on_press(self, event):
        self.drag_from = (event.x, event.y)
        self.sel = None
        self.reveal(None)
        self._hide_chrome()

    def on_move(self, event):
        if self.drag_from is None:
            return
        self.sel = norm_rect(self.drag_from[0], self.drag_from[1], event.x, event.y)
        self.reveal(self.sel)
        self.draw_selection(self.sel)

    def on_release(self, event):
        if self.drag_from is None:
            return
        self.drag_from = None
        if not is_selectable(self.sel):
            # 误触：清掉选区，留在框选态等下一次拖拽。
            self.sel = None
            self.reveal(None)
            self._hide_chrome()
            return
        # 松手即完成——这是「无编辑」版本的全部交互。
        self.finish()

    def finish(self):
        if not is_selectable(self.sel):
            return
        self.done = True
        self.root.destroy()

    def cancel(self):
        self.cancelled = True
        self.root.destroy()


# ============================================================
# 入口
# ============================================================

def selftest():
    """纯函数自检：不开窗口。"""
    assert norm_rect(90, 80, 10, 20) == (10, 20, 90, 80)
    assert norm_rect(10, 20, 90, 80) == (10, 20, 90, 80)
    assert is_selectable(None) is False
    assert is_selectable((0, 0, 7, 100)) is False, "宽度不足视为误触"
    assert is_selectable((0, 0, 8, 8)) is True

    w, h = 4, 3
    raw = bytearray()
    for y in range(h):
        for x in range(w):
            raw += bytes([x, y, 0, 255])
    cropped, cw, ch = crop_bgra(bytes(raw), w, h, (1, 1, 3, 3))
    assert (cw, ch) == (2, 2)
    assert cropped[0:4] == bytes([1, 1, 0, 255]), cropped[0:4]
    assert cropped[4:8] == bytes([2, 1, 0, 255]), cropped[4:8]
    _, cw2, ch2 = crop_bgra(bytes(raw), w, h, (-5, -5, 2, 2))
    assert (cw2, ch2) == (2, 2), "越界被夹住"

    table = dim_table()
    assert table[255] == int(255 * DIM_LEVEL)
    assert table[0] == 0

    png = png_from_bgra(bytes(bytearray([200, 100, 50, 255] * 4)), 2, 2)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">II", png[16:24]) == (2, 2)
    body = zlib.decompress(png[png.index(b"IDAT") + 4:png.rindex(b"IEND") - 8])
    assert len(body) == 2 * (1 + 2 * 3), len(body)
    assert body[1:4] == bytes([50, 100, 200]), body[1:4]

    print("selftest ok")


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    if "--selftest-cancel" in sys.argv:
        raise SystemExit(2)

    try:
        import tkinter  # noqa: F401
    except Exception as error:  # noqa: BLE001
        sys.stderr.write(f"tkinter unavailable: {error}\n")
        raise SystemExit(5)

    user32, gdi32, kernel32 = load_libraries()
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except (AttributeError, OSError):
        user32.SetProcessDPIAware()

    hide_mode = os.environ.get("DSH_SHOT_HIDE", "1").strip().lower()
    target = None
    if hide_mode != "0":
        target = own_foreground_window(user32, kernel32)
        if hide_mode == "dry":
            sys.stderr.write(f"hide-decision hwnd={target}\n")
            target = None

    vx = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    vy = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    vw = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
    vh = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    if vw <= 0 or vh <= 0:
        sys.stderr.write("no display available (locked session or headless)\n")
        raise SystemExit(4)

    try:
        if target:
            user32.ShowWindow(target, SW_MINIMIZE)
            time.sleep(0.22)
        raw = grab(user32, gdi32, vx, vy, vw, vh)
    finally:
        if target:
            user32.ShowWindow(target, SW_RESTORE)

    import tkinter as tk
    bright = base64.b64encode(png_from_bgra(raw, vw, vh, level=1))
    dimmed = base64.b64encode(png_from_bgra(raw.translate(dim_table()), vw, vh, level=1))
    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    gx = vx if vx >= 0 else 0
    gy = vy if vy >= 0 else 0
    root.geometry(f"{vw}x{vh}+{gx}+{gy}")
    overlay = ShotOverlay(root, tk.PhotoImage(data=dimmed), tk.PhotoImage(data=bright), vw, vh)

    if "--selftest-ui" in sys.argv:
        def scripted():
            overlay.sel = (vx + 300, vy + 200, vx + 900, vy + 600)
            overlay.reveal(overlay.sel)
            overlay.draw_selection(overlay.sel)
            overlay.finish()

        root.after(500, scripted)

    if "--selftest-shot" in sys.argv:
        out_path = sys.argv[sys.argv.index("--selftest-shot") + 1]

        def dump():
            root.update()
            time.sleep(0.25)
            shot = grab(user32, gdi32, vx, vy, vw, vh)
            with open(out_path, "wb") as handle:
                handle.write(png_from_bgra(shot, vw, vh))
            root.destroy()

        def prep():
            overlay.sel = (vx + 300, vy + 200, vx + 900, vy + 600)
            overlay.reveal(overlay.sel)
            overlay.draw_selection(overlay.sel)
            root.after(150, dump)

        root.after(400, prep)

    root.mainloop()

    if overlay.cancelled or not overlay.done or not is_selectable(overlay.sel):
        raise SystemExit(2)

    cropped, cw, ch = crop_bgra(raw, vw, vh, overlay.sel)
    if cw <= 0 or ch <= 0:
        raise SystemExit(2)
    sys.stdout.write(base64.b64encode(png_from_bgra(cropped, cw, ch)).decode("ascii"))
    sys.stdout.flush()
    sys.stderr.write(f"picked {cw}x{ch}\n")


if __name__ == "__main__":
    main()
