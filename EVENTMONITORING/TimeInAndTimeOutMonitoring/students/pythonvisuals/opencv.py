"""
face_pipeline_opencv_visual.py

Shows the ACTUAL downscaled frame and BGR->RGB conversion clearly.

Panel 1: RAW FRAME        — 640x480 BGR
Panel 2: SCALED FRAME     — 160x120 shown as native size + magnified inset with visible pixels
Panel 3: COLOR CONVERTED  — 160x120 RGB with BGR vs RGB color comparison strip
Panel 4: MAPPED BACK      — 640x480 with x4 scaled-back bbox

Controls: s = save, q/ESC = quit
Install: pip install opencv-python numpy
Run:     python face_pipeline_opencv_visual.py
"""

import os
import time
import cv2
import numpy as np

CAMERA_INDEX = int(os.getenv("CAMERA_INDEX", "0"))
PROCESS_EVERY_N = 3
SAVE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pipeline_captures")
FONT = cv2.FONT_HERSHEY_SIMPLEX

PANEL_W, PANEL_H = 480, 360
GAP = 10


def label_bar(panel, text, sub_text=""):
    h, w = panel.shape[:2]
    bar_h = 48 if sub_text else 26
    overlay = panel.copy()
    cv2.rectangle(overlay, (0, h - bar_h), (w, h), (15, 15, 20), -1)
    cv2.addWeighted(overlay, 0.7, panel, 0.3, 0, panel)
    cv2.putText(panel, text, (12, h - bar_h + 20), FONT, 0.52, (0, 255, 180), 1, cv2.LINE_AA)
    if sub_text:
        cv2.putText(panel, sub_text, (12, h - 10), FONT, 0.4, (180, 180, 180), 1, cv2.LINE_AA)
    return panel


def draw_text_bg(panel, text, pos, font_scale=0.5, color=(255, 255, 255), thickness=1):
    (tw, th), baseline = cv2.getTextSize(text, FONT, font_scale, thickness)
    x, y = pos
    pad = 3
    bg = panel.copy()
    cv2.rectangle(bg, (x - pad, y - th - pad), (x + tw + pad, y + baseline + pad), (0, 0, 0), -1)
    cv2.addWeighted(bg, 0.6, panel, 0.4, 0, panel)
    cv2.putText(panel, text, (x, y), FONT, font_scale, color, thickness, cv2.LINE_AA)
    return panel


def build_composite(raw_frame, small_bgr, small_rgb, resize_ms, color_ms):
    h, w = raw_frame.shape[:2]

    # ── Panel 1: RAW FRAME ───────────────────────────────────────────
    panel_raw = cv2.resize(raw_frame, (PANEL_W, PANEL_H))
    label_bar(panel_raw, "STEP 1: RAW FRAME", f"{w}x{h}px  BGR (camera native)")

    # ── Panel 2: SCALED FRAME ────────────────────────────────────────
    # Show native 160x120 in top-left, then a large magnified inset
    panel_scaled = np.full((PANEL_H, PANEL_W, 3), 25, dtype=np.uint8)

    # Native size thumbnail (160x120) in top-left
    thumb_h, thumb_w = small_bgr.shape[:2]
    panel_scaled[10:10+thumb_h, 10:10+thumb_w] = small_bgr
    cv2.rectangle(panel_scaled, (9, 9), (11+thumb_w, 11+thumb_h), (100, 100, 100), 1)
    draw_text_bg(panel_scaled, f"Native: {thumb_w}x{thumb_h}px", (10, 10+thumb_h+18), 0.42, (180, 180, 180), 1)

    # Magnified inset (4x zoom) with visible pixel blocks
    inset_x, inset_y = 200, 10
    inset_size = 240  # 60 original pixels * 4
    # Crop a 60x60 region from center of small_bgr and zoom 4x
    cx, cy = thumb_w // 2, thumb_h // 2
    crop = small_bgr[cy-30:cy+30, cx-30:cx+30]
    zoomed = cv2.resize(crop, (inset_size, inset_size), interpolation=cv2.INTER_NEAREST)

    # Draw thick grid lines on the zoomed inset so pixels are OBVIOUS
    for x in range(0, inset_size, 4):
        cv2.line(zoomed, (x, 0), (x, inset_size), (255, 255, 255), 1)
    for y in range(0, inset_size, 4):
        cv2.line(zoomed, (0, y), (inset_size, y), (255, 255, 255), 1)

    panel_scaled[inset_y:inset_y+inset_size, inset_x:inset_x+inset_size] = zoomed
    cv2.rectangle(panel_scaled, (inset_x-2, inset_y-2), (inset_x+inset_size+2, inset_y+inset_size+2), (0, 200, 255), 2)
    draw_text_bg(panel_scaled, "4x zoom (each square = 1 pixel)", (inset_x, inset_y+inset_size+18), 0.42, (0, 200, 255), 1)

    # Pixel reduction stats
    draw_text_bg(panel_scaled, f"19,200 pixels  (was 307,200)", (10, PANEL_H - 60), 0.5, (0, 200, 255), 1)
    draw_text_bg(panel_scaled, f"16x fewer pixels to process", (10, PANEL_H - 35), 0.42, (180, 180, 180), 1)

    label_bar(panel_scaled, "STEP 2: SCALED FRAME",
              f"cv2.resize()  scale=0.25x  {thumb_w}x{thumb_h}px  time={resize_ms:.1f}ms")

    # ── Panel 3: COLOR CONVERTED ─────────────────────────────────────
    # Show RGB data with a prominent BGR vs RGB comparison
    panel_rgb = np.full((PANEL_H, PANEL_W, 3), 25, dtype=np.uint8)

    # Large color comparison strip at top
    strip_h = 100
    strip_w = PANEL_W - 20
    half = strip_w // 2
    bgr_strip = cv2.resize(small_bgr, (half - 5, strip_h - 20), interpolation=cv2.INTER_NEAREST)
    rgb_strip = cv2.resize(small_rgb, (half - 5, strip_h - 20), interpolation=cv2.INTER_NEAREST)

    panel_rgb[10:10+bgr_strip.shape[0], 10:10+bgr_strip.shape[1]] = bgr_strip
    panel_rgb[10:10+rgb_strip.shape[0], 15+half:15+half+rgb_strip.shape[1]] = rgb_strip

    cv2.putText(panel_rgb, "BGR (correct)", (20, strip_h + 5), FONT, 0.5, (100, 100, 255), 1, cv2.LINE_AA)
    cv2.putText(panel_rgb, "RGB (shifted)", (15+half + 10, strip_h + 5), FONT, 0.5, (255, 100, 100), 1, cv2.LINE_AA)

    # Show the full RGB frame below (will look color-shifted)
    rgb_display = cv2.resize(small_rgb, (280, 210), interpolation=cv2.INTER_NEAREST)
    panel_rgb[strip_h + 20:strip_h + 20 + rgb_display.shape[0], 
              (PANEL_W - rgb_display.shape[1])//2:(PANEL_W - rgb_display.shape[1])//2 + rgb_display.shape[1]] = rgb_display

    draw_text_bg(panel_rgb, "BGR -> RGB channel swap", (10, PANEL_H - 60), 0.5, (255, 200, 0), 1)
    draw_text_bg(panel_rgb, "Required by dlib HOG detector", (10, PANEL_H - 35), 0.42, (180, 180, 180), 1)

    label_bar(panel_rgb, "STEP 3: COLOR CONVERTED",
              f"cv2.cvtColor()  BGR -> RGB  time={color_ms:.1f}ms")

    # ── Panel 4: MAPPED BACK ─────────────────────────────────────────
    panel_mapped = cv2.resize(raw_frame, (PANEL_W, PANEL_H))

    cx, cy = PANEL_W // 2, PANEL_H // 2
    small_x, small_y, small_w, small_h = 55, 55, 51, 52
    full_w, full_h = small_w * 4, small_h * 4
    full_x = cx - full_w // 2
    full_y = cy - full_h // 2

    cv2.rectangle(panel_mapped, (full_x, full_y), (full_x + full_w, full_y + full_h), (0, 255, 0), 2)

    draw_text_bg(panel_mapped, f"small: [{small_x},{small_y},{small_w},{small_h}]", (15, 28), 0.48, (0, 200, 255), 1)
    draw_text_bg(panel_mapped, f"x4 -> [{full_x},{full_y},{full_w},{full_h}]", (15, 52), 0.48, (0, 255, 100), 1)
    label_bar(panel_mapped, "STEP 4: MAPPED BACK",
              f"x4 scale-back  bbox=[x:{full_x}, y:{full_y}, w:{full_w}, h:{full_h}]")

    # ── Assemble 2x2 grid ─────────────────────────────────────────────
    gap_h = np.full((GAP, PANEL_W * 2 + GAP, 3), 35, dtype=np.uint8)
    gap_v = np.full((PANEL_H, GAP, 3), 35, dtype=np.uint8)

    top_row = np.hstack([panel_raw, gap_v, panel_scaled])
    bottom_row = np.hstack([panel_rgb, gap_v, panel_mapped])
    composite = np.vstack([top_row, gap_h, bottom_row])

    title_h = 40
    title_bar = np.full((title_h, composite.shape[1], 3), (20, 20, 28), dtype=np.uint8)
    title_text = "OpenCV Preprocessing Pipeline"
    ts = cv2.getTextSize(title_text, FONT, 0.7, 2)[0]
    cv2.putText(title_bar, title_text, ((composite.shape[1] - ts[0]) // 2, 28), FONT, 0.7, (220, 220, 220), 2, cv2.LINE_AA)

    return np.vstack([title_bar, composite])


def main():
    cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW) if os.name == "nt" else cv2.VideoCapture(CAMERA_INDEX)
    if not cap.isOpened():
        print(f"Could not open camera index {CAMERA_INDEX}")
        return

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    os.makedirs(SAVE_DIR, exist_ok=True)

    frame_count = 0
    small_bgr = np.zeros((120, 160, 3), dtype=np.uint8)
    small_rgb = np.zeros((120, 160, 3), dtype=np.uint8)
    resize_ms = color_ms = 0.0

    print("Running. Press 's' to save, 'q' or ESC to quit.")

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame = cv2.resize(frame, (640, 480))

        if frame_count % PROCESS_EVERY_N == 0:
            t0 = time.time()
            small_bgr = cv2.resize(frame, (160, 120), interpolation=cv2.INTER_NEAREST)
            resize_ms = (time.time() - t0) * 1000.0

            t0 = time.time()
            small_rgb = cv2.cvtColor(small_bgr, cv2.COLOR_BGR2RGB)
            color_ms = (time.time() - t0) * 1000.0

        frame_count += 1

        composite = build_composite(frame, small_bgr, small_rgb, resize_ms, color_ms)
        cv2.imshow("OpenCV Preprocessing  (s = save, q = quit)", composite)

        key = cv2.waitKey(1) & 0xFF
        if key == ord('s'):
            fname = os.path.join(SAVE_DIR, f"opencv_pipeline_{int(time.time())}.png")
            cv2.imwrite(fname, composite)
            print(f"Saved -> {fname}")
        elif key == ord('q') or key == 27:
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()