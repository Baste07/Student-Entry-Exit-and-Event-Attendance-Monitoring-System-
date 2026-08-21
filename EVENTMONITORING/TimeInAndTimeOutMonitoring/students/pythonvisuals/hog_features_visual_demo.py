"""
hog_features_visual_demo.py

Simple, focused visualization of HOG (Histogram of Oriented Gradients)
feature extraction ONLY -- the "Step 1-2: Building the HOG Descriptor"
part of the pipeline. No SVM, no bounding box math, just:

    face crop -> per-pixel gradients -> 8x8 cell grid -> orientation arrows

Uses the paper's face region: bbox=[x:220, y:220, w:204, h:208]

Controls: SPACE = camera/synthetic toggle, s = save, q/ESC = quit
Install:  pip install opencv-python numpy
Run:      python hog_features_visual_demo.py
"""

import os
import time
import math
import cv2
import numpy as np

CAMERA_INDEX = int(os.getenv("CAMERA_INDEX", "0"))
SAVE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hog_visuals")
FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_BOLD = cv2.FONT_HERSHEY_DUPLEX

# Paper example face region
PAPER_BBOX = {"x": 220, "y": 220, "w": 204, "h": 208}

CELL_SIZE = 16      # pixels per cell (kept large so arrows stay readable)
BIN_COUNT = 9        # gradient orientation bins spanning 0-180 degrees


def compute_gradients(gray):
    """Sobel gradients -> magnitude (edge strength) + angle (edge direction)."""
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.sqrt(gx ** 2 + gy ** 2)
    ang = np.arctan2(gy, gx) * 180 / math.pi
    ang[ang < 0] += 180  # unsigned gradients: fold into 0-180 range
    return mag, ang


def gradient_color_map(mag, ang, size):
    """Hue = orientation, Brightness (V) = magnitude -- matches the legend
    used in the write-up."""
    mag_norm = np.clip(mag / (mag.max() + 1e-6) * 255, 0, 255).astype(np.uint8)
    ang_norm = (ang / 180.0 * 179).astype(np.uint8)  # OpenCV hue range is 0-179
    hsv = np.zeros((*mag.shape, 3), dtype=np.uint8)
    hsv[:, :, 0] = ang_norm
    hsv[:, :, 1] = 255
    hsv[:, :, 2] = mag_norm
    bgr = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
    return cv2.resize(bgr, size, interpolation=cv2.INTER_NEAREST)


def cell_histogram(cell_ang, cell_mag):
    hist = np.zeros(BIN_COUNT)
    for i in range(BIN_COUNT):
        lo, hi = i * 20, (i + 1) * 20
        mask = (cell_ang >= lo) & (cell_ang < hi)
        hist[i] = cell_mag[mask].sum()
    total = hist.sum() + 1e-6
    return hist / total


def draw_cell_arrows(panel, x0, y0, cw, ch, hist, color=(0, 255, 255)):
    cx, cy = x0 + cw // 2, y0 + ch // 2
    peak = hist.max() + 1e-6
    for i, val in enumerate(hist):
        if val < 0.08:
            continue
        angle = i * 20 + 10  # bin center
        rad = math.radians(angle)
        length = int(min(cw, ch) * 0.42 * (val / peak))
        dx, dy = int(length * math.cos(rad)), int(length * math.sin(rad))
        brightness = 0.35 + 0.65 * (val / peak)
        line_color = tuple(int(c * brightness) for c in color)
        cv2.line(panel, (cx - dx, cy + dy), (cx + dx, cy - dy), line_color, 1, cv2.LINE_AA)
    return panel


def build_hog_cell_grid(gray_crop, cell_size=CELL_SIZE, display_size=520):
    """8x8-style cell grid with per-cell dominant-gradient arrows overlaid
    on a shaded background (brighter cell = stronger dominant edge)."""
    mag, ang = compute_gradients(gray_crop)
    h, w = gray_crop.shape
    rows, cols = h // cell_size, w // cell_size

    panel = np.full((display_size, display_size, 3), 30, dtype=np.uint8)
    dcw, dch = display_size // cols, display_size // rows

    for r in range(rows):
        for c in range(cols):
            y0, y1 = r * cell_size, (r + 1) * cell_size
            x0, x1 = c * cell_size, (c + 1) * cell_size
            hist = cell_histogram(ang[y0:y1, x0:x1], mag[y0:y1, x0:x1])

            dx0, dy0 = c * dcw, r * dch
            dx1, dy1 = dx0 + dcw, dy0 + dch
            shade = int(40 + 70 * hist.max())
            cv2.rectangle(panel, (dx0, dy0), (dx1, dy1), (shade, shade, shade + 15), -1)
            cv2.rectangle(panel, (dx0, dy0), (dx1, dy1), (75, 75, 75), 1)
            draw_cell_arrows(panel, dx0, dy0, dcw, dch, hist)

    return panel, rows, cols


def get_face_crop(frame, bbox):
    h, w = frame.shape[:2]
    x, y = max(0, bbox["x"]), max(0, bbox["y"])
    bw = min(bbox["w"], w - x)
    bh = min(bbox["h"], h - y)
    if bw <= 0 or bh <= 0:
        return None
    return frame[y:y + bh, x:x + bw]


def generate_demo_frame():
    """Synthetic face-like frame, used only if no camera is available."""
    frame = np.full((480, 640, 3), (45, 42, 55), dtype=np.uint8)
    for yy in range(480):
        frame[yy, :] = (42 + yy // 20, 40 + yy // 24, 54 + yy // 15)
    cx, cy = 320, 240
    cv2.ellipse(frame, (cx, cy), (102, 122), 0, 0, 360, (182, 158, 138), -1)
    cv2.circle(frame, (cx - 34, cy - 18), 11, (28, 28, 28), -1)
    cv2.circle(frame, (cx + 34, cy - 18), 11, (28, 28, 28), -1)
    cv2.ellipse(frame, (cx, cy + 14), (8, 15), 0, 0, 360, (140, 118, 98), -1)
    cv2.ellipse(frame, (cx, cy + 52), (28, 12), 0, 0, 180, (100, 58, 58), 2)
    return frame


def build_composite(frame, bbox=PAPER_BBOX):
    face_crop = get_face_crop(frame, bbox)
    if face_crop is None:
        face_crop = frame  # fallback, shouldn't happen with paper bbox on a 640x480 frame
    gray = cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)
    gray_small = cv2.resize(gray, (208, 208))

    mag, ang = compute_gradients(gray_small)
    grad_vis = gradient_color_map(mag, ang, size=(520, 520))
    cell_vis, rows, cols = build_hog_cell_grid(gray_small, cell_size=CELL_SIZE, display_size=520)

    panel_h = 640
    gap = 30
    total_w = 520 * 2 + gap
    canvas = np.full((panel_h, total_w, 3), 18, dtype=np.uint8)

    # Title
    title = "HOG Feature Extraction (Step 1-2: Gradients -> Cell Histograms)"
    ts = cv2.getTextSize(title, FONT_BOLD, 0.72, 2)[0]
    cv2.putText(canvas, title, ((total_w - ts[0]) // 2, 34), FONT_BOLD, 0.72, (230, 230, 230), 2, cv2.LINE_AA)

    y0 = 55
    canvas[y0:y0 + 520, 0:520] = grad_vis
    canvas[y0:y0 + 520, 520 + gap:520 + gap + 520] = cell_vis

    # Panel labels
    cv2.rectangle(canvas, (0, y0 - 1), (520, y0 + 520), (90, 90, 90), 1)
    cv2.rectangle(canvas, (520 + gap, y0 - 1), (520 + gap + 520, y0 + 520), (90, 90, 90), 1)
    cv2.putText(canvas, "Per-Pixel Gradients", (12, y0 + 22), FONT_BOLD, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.putText(canvas, f"HOG Cells ({cols}x{rows} grid, {CELL_SIZE}x{CELL_SIZE}px each)",
                (520 + gap + 12, y0 + 22), FONT_BOLD, 0.55, (255, 255, 255), 1, cv2.LINE_AA)

    # Legend under left panel
    legend_y = y0 + 520 + 30
    cv2.putText(canvas, "Hue = orientation", (12, legend_y), FONT, 0.5, (200, 200, 255), 1, cv2.LINE_AA)
    cv2.putText(canvas, "Brightness = magnitude", (12, legend_y + 26), FONT, 0.5, (200, 200, 255), 1, cv2.LINE_AA)

    # Legend under right panel
    cv2.putText(canvas, "9-bin orientation histogram per cell", (520 + gap + 12, legend_y), FONT, 0.5, (0, 255, 200), 1, cv2.LINE_AA)
    cv2.putText(canvas, "arrow length = bin strength (dominant edge)", (520 + gap + 12, legend_y + 26), FONT, 0.5, (0, 255, 200), 1, cv2.LINE_AA)

    # bbox reference line at the very bottom
    bbox_txt = f"face region: bbox=[x:{bbox['x']}, y:{bbox['y']}, w:{bbox['w']}, h:{bbox['h']}]"
    cv2.putText(canvas, bbox_txt, (12, panel_h - 15), FONT, 0.45, (150, 150, 150), 1, cv2.LINE_AA)

    return canvas


def main():
    os.makedirs(SAVE_DIR, exist_ok=True)
    cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW) if os.name == "nt" else cv2.VideoCapture(CAMERA_INDEX)
    camera_available = cap.isOpened()
    use_camera = camera_available
    if camera_available:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    else:
        print(f"Could not open camera index {CAMERA_INDEX}; using synthetic demo frame only")

    print("HOG Feature Extraction Visual Demo")
    print("Controls: SPACE = camera/synthetic toggle, s = save, q/ESC = quit")

    while True:
        if use_camera and camera_available:
            ok, frame = cap.read()
            if not ok:
                frame = generate_demo_frame()
        else:
            frame = generate_demo_frame()
        frame = cv2.resize(frame, (640, 480))

        composite = build_composite(frame)
        cv2.imshow("HOG Feature Extraction  (SPACE=camera/synthetic, s=save, q=quit)", composite)

        key = cv2.waitKey(30) & 0xFF
        if key == ord(" "):
            if camera_available:
                use_camera = not use_camera
                print(f"Source: {'camera' if use_camera else 'synthetic'}")
        elif key == ord("s"):
            fname = os.path.join(SAVE_DIR, f"hog_features_{int(time.time())}.png")
            cv2.imwrite(fname, composite)
            print(f"Saved -> {fname}")
        elif key == ord("q") or key == 27:
            break

    if camera_available:
        cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()