#!/usr/bin/env python3
"""Small macOS-friendly PDF coordinate picker for paris_map.pdf.

It renders the first page of the PDF, shows the cursor position in PDF/page
coordinates, and copies the current ``x,y`` to the clipboard on left click.
The coordinate system matches ``stations.x`` / ``stations.y``: top-left origin.
"""

from __future__ import annotations

import argparse
import sys
import tkinter as tk
from dataclasses import dataclass
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

try:
    import pypdfium2 as pdfium
except ImportError:  # pragma: no cover - user-facing startup guard
    pdfium = None

try:
    from PIL import ImageTk
except ImportError:  # pragma: no cover - user-facing startup guard
    ImageTk = None


ROOT = Path(__file__).resolve().parent
DEFAULT_PDF_PATH = ROOT / "resources" / "paris_map.pdf"
FALLBACK_PDF_PATH = Path("/Users/xyu/Desktop/paris_map.pdf")


@dataclass(frozen=True)
class PdfPoint:
    x: float
    y: float

    def text(self) -> str:
        return f"{self.x:.2f},{self.y:.2f}"


class CoordinatePicker(tk.Tk):
    def __init__(self, pdf_path: Path, page_index: int = 0) -> None:
        super().__init__()
        self.title("Paris Map Coordinate Picker")
        self.geometry("1280x860")
        self.minsize(760, 520)

        self.pdf_path = pdf_path
        self.page_index = page_index
        self.document = pdfium.PdfDocument(str(pdf_path))
        self.page = self.document[page_index]
        self.pdf_width, self.pdf_height = self.page.get_size()

        self.zoom = 0.42
        self.photo: ImageTk.PhotoImage | None = None
        self.image_id: int | None = None
        self.crosshair_ids: tuple[int, int] | None = None
        self.last_point = PdfPoint(0.0, 0.0)
        self.drag_start: tuple[int, int] | None = None
        self.drag_moved = False

        self.status_var = tk.StringVar(value="移动鼠标查看坐标，左键拖动地图，单击复制 x,y")
        self.coord_var = tk.StringVar(value="x=0.00  y=0.00")
        self.zoom_var = tk.StringVar(value="")

        self._build_ui()
        self._bind_events()
        self.render_page()

    def _build_ui(self) -> None:
        toolbar = ttk.Frame(self, padding=(8, 6))
        toolbar.pack(side=tk.TOP, fill=tk.X)

        ttk.Button(toolbar, text="打开 PDF", command=self.open_pdf).pack(side=tk.LEFT)
        ttk.Separator(toolbar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=8)
        ttk.Button(toolbar, text="−", width=3, command=lambda: self.change_zoom(0.8)).pack(side=tk.LEFT)
        ttk.Button(toolbar, text="+", width=3, command=lambda: self.change_zoom(1.25)).pack(side=tk.LEFT, padx=(4, 0))
        ttk.Button(toolbar, text="100%", command=lambda: self.set_zoom(1.0)).pack(side=tk.LEFT, padx=(4, 0))
        ttk.Label(toolbar, textvariable=self.zoom_var, width=9, anchor=tk.CENTER).pack(side=tk.LEFT, padx=(8, 12))
        ttk.Button(toolbar, text="复制当前坐标", command=self.copy_current).pack(side=tk.LEFT)
        ttk.Label(toolbar, text=f"PDF: {self.pdf_path}", anchor=tk.W).pack(side=tk.LEFT, padx=(12, 0), fill=tk.X, expand=True)

        frame = ttk.Frame(self)
        frame.pack(side=tk.TOP, fill=tk.BOTH, expand=True)

        self.canvas = tk.Canvas(frame, background="#1f2933", highlightthickness=0)
        x_scroll = ttk.Scrollbar(frame, orient=tk.HORIZONTAL, command=self.canvas.xview)
        y_scroll = ttk.Scrollbar(frame, orient=tk.VERTICAL, command=self.canvas.yview)
        self.canvas.configure(xscrollcommand=x_scroll.set, yscrollcommand=y_scroll.set)

        self.canvas.grid(row=0, column=0, sticky="nsew")
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll.grid(row=1, column=0, sticky="ew")
        frame.columnconfigure(0, weight=1)
        frame.rowconfigure(0, weight=1)

        status = ttk.Frame(self, padding=(8, 5))
        status.pack(side=tk.BOTTOM, fill=tk.X)
        ttk.Label(status, textvariable=self.coord_var, width=24, font=("Menlo", 13)).pack(side=tk.LEFT)
        ttk.Label(status, textvariable=self.status_var, anchor=tk.W).pack(side=tk.LEFT, fill=tk.X, expand=True)

    def _bind_events(self) -> None:
        self.canvas.bind("<Motion>", self.on_motion)
        self.canvas.bind("<ButtonPress-1>", self.on_left_press)
        self.canvas.bind("<B1-Motion>", self.on_left_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_left_release)
        self.canvas.bind("<Leave>", lambda _event: self.clear_crosshair())
        self.bind("<Command-plus>", lambda _event: self.change_zoom(1.25))
        self.bind("<Command-equal>", lambda _event: self.change_zoom(1.25))
        self.bind("<Command-minus>", lambda _event: self.change_zoom(0.8))
        self.bind("<Command-0>", lambda _event: self.set_zoom(1.0))
        self.bind("<Command-c>", lambda _event: self.copy_current())
        self.bind("<Escape>", lambda _event: self.destroy())

        # Mouse wheel / trackpad pinch-like scroll zooms around the cursor.
        self.canvas.bind("<MouseWheel>", self.on_mousewheel)

    def render_page(self) -> None:
        bitmap = self.page.render(scale=self.zoom, rotation=0)
        image = bitmap.to_pil()
        self.photo = ImageTk.PhotoImage(image)

        if self.image_id is None:
            self.image_id = self.canvas.create_image(0, 0, image=self.photo, anchor=tk.NW)
        else:
            self.canvas.itemconfigure(self.image_id, image=self.photo)

        width = self.pdf_width * self.zoom
        height = self.pdf_height * self.zoom
        self.canvas.configure(scrollregion=(0, 0, width, height))
        self.zoom_var.set(f"{self.zoom * 100:.0f}%")
        self.clear_crosshair()

    def open_pdf(self) -> None:
        path = filedialog.askopenfilename(
            title="选择 Paris map PDF",
            filetypes=(("PDF files", "*.pdf"), ("All files", "*.*")),
            initialdir=str(self.pdf_path.parent),
        )
        if not path:
            return
        self.destroy()
        CoordinatePicker(Path(path), self.page_index).mainloop()

    def change_zoom(self, factor: float) -> None:
        self.set_zoom(self.zoom * factor)

    def set_zoom(self, value: float, center: tuple[float, float] | None = None) -> None:
        previous = self.zoom
        self.zoom = min(3.0, max(0.12, value))
        if abs(previous - self.zoom) < 0.001:
            return
        center_pdf = None
        if center is not None:
            canvas_x = self.canvas.canvasx(center[0])
            canvas_y = self.canvas.canvasy(center[1])
            center_pdf = (canvas_x / previous, canvas_y / previous)
        self.render_page()
        if center_pdf is not None:
            self.scroll_to_canvas_point(center_pdf[0] * self.zoom, center_pdf[1] * self.zoom, center)

    def on_mousewheel(self, event: tk.Event) -> None:
        if event.state & 0x0001:
            self.canvas.xview_scroll(int(-event.delta / 120), "units")
            return
        factor = 1.12 if event.delta > 0 else 1 / 1.12
        self.set_zoom(self.zoom * factor, center=(event.x, event.y))

    def scroll_to_canvas_point(self, canvas_x: float, canvas_y: float, window_point: tuple[float, float]) -> None:
        scroll_width = max(self.pdf_width * self.zoom, 1.0)
        scroll_height = max(self.pdf_height * self.zoom, 1.0)
        left = min(max((canvas_x - window_point[0]) / scroll_width, 0.0), 1.0)
        top = min(max((canvas_y - window_point[1]) / scroll_height, 0.0), 1.0)
        self.canvas.xview_moveto(left)
        self.canvas.yview_moveto(top)

    def point_from_event(self, event: tk.Event) -> PdfPoint:
        canvas_x = self.canvas.canvasx(event.x)
        canvas_y = self.canvas.canvasy(event.y)
        x = min(max(canvas_x / self.zoom, 0.0), self.pdf_width)
        y = min(max(canvas_y / self.zoom, 0.0), self.pdf_height)
        return PdfPoint(x=x, y=y)

    def on_motion(self, event: tk.Event) -> None:
        point = self.point_from_event(event)
        self.last_point = point
        self.coord_var.set(f"x={point.x:8.2f}  y={point.y:8.2f}")
        self.status_var.set("左键拖动地图；单击复制坐标；滚轮缩放；Shift+滚轮横向滚动")
        self.draw_crosshair(event)

    def on_left_press(self, event: tk.Event) -> None:
        self.drag_start = (event.x, event.y)
        self.drag_moved = False
        self.last_point = self.point_from_event(event)
        self.canvas.scan_mark(event.x, event.y)
        self.canvas.configure(cursor="fleur")

    def on_left_drag(self, event: tk.Event) -> None:
        if self.drag_start is None:
            return
        dx = event.x - self.drag_start[0]
        dy = event.y - self.drag_start[1]
        if dx * dx + dy * dy > 16:
            self.drag_moved = True
        self.canvas.scan_dragto(event.x, event.y, gain=1)
        self.last_point = self.point_from_event(event)
        self.coord_var.set(f"x={self.last_point.x:8.2f}  y={self.last_point.y:8.2f}")
        self.status_var.set("松开鼠标结束拖动；单击不拖动时复制坐标")
        self.draw_crosshair(event)

    def on_left_release(self, event: tk.Event) -> None:
        self.last_point = self.point_from_event(event)
        self.canvas.configure(cursor="")
        self.drag_start = None
        if self.drag_moved:
            self.drag_moved = False
            self.status_var.set("拖动完成；单击可复制坐标")
            return
        self.copy_current()

    def copy_current(self) -> None:
        text = self.last_point.text()
        self.clipboard_clear()
        self.clipboard_append(text)
        self.update_idletasks()
        self.status_var.set(f"已复制: {text}")

    def draw_crosshair(self, event: tk.Event) -> None:
        canvas_x = self.canvas.canvasx(event.x)
        canvas_y = self.canvas.canvasy(event.y)
        view = (
            self.canvas.canvasx(0),
            self.canvas.canvasy(0),
            self.canvas.canvasx(self.canvas.winfo_width()),
            self.canvas.canvasy(self.canvas.winfo_height()),
        )
        if self.crosshair_ids is None:
            h_id = self.canvas.create_line(view[0], canvas_y, view[2], canvas_y, fill="#0f172a", dash=(4, 4))
            v_id = self.canvas.create_line(canvas_x, view[1], canvas_x, view[3], fill="#0f172a", dash=(4, 4))
            self.crosshair_ids = (h_id, v_id)
        else:
            h_id, v_id = self.crosshair_ids
            self.canvas.coords(h_id, view[0], canvas_y, view[2], canvas_y)
            self.canvas.coords(v_id, canvas_x, view[1], canvas_x, view[3])

    def clear_crosshair(self) -> None:
        if self.crosshair_ids:
            for item_id in self.crosshair_ids:
                self.canvas.delete(item_id)
        self.crosshair_ids = None


def resolve_default_pdf() -> Path:
    if DEFAULT_PDF_PATH.exists():
        return DEFAULT_PDF_PATH
    return FALLBACK_PDF_PATH


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="显示 paris_map.pdf 并复制鼠标点击处的 PDF 坐标。")
    parser.add_argument(
        "pdf",
        nargs="?",
        type=Path,
        default=resolve_default_pdf(),
        help="PDF 路径，默认使用 resources/paris_map.pdf；不存在时使用桌面 paris_map.pdf",
    )
    parser.add_argument("--page", type=int, default=1, help="页码，从 1 开始，默认 1")
    parser.add_argument(
        "--render-check",
        action="store_true",
        help="只检查 PDF 是否能渲染，不启动窗口",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    if pdfium is None or ImageTk is None:
        print("缺少依赖：需要 pypdfium2、Pillow 和 tkinter。", file=sys.stderr)
        return 1

    args = parse_args(argv or sys.argv[1:])
    pdf_path = args.pdf.expanduser().resolve()
    if not pdf_path.exists():
        print(f"找不到 PDF: {pdf_path}", file=sys.stderr)
        return 1

    document = pdfium.PdfDocument(str(pdf_path))
    page_count = len(document)
    document.close()
    if args.page < 1 or args.page > page_count:
        print(f"页码超出范围：{args.page}，PDF 共 {page_count} 页。", file=sys.stderr)
        return 1

    if args.render_check:
        document = pdfium.PdfDocument(str(pdf_path))
        page = document[args.page - 1]
        width, height = page.get_size()
        bitmap = page.render(scale=0.2)
        image = bitmap.to_pil()
        print(f"OK {pdf_path} page={args.page} pdf_size={width:.2f}x{height:.2f} image_size={image.size[0]}x{image.size[1]}")
        document.close()
        return 0

    app = CoordinatePicker(pdf_path=pdf_path, page_index=args.page - 1)
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
