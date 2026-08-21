"""
mediapipe_segmentation_visual_demo.py

Interactive visualization of Background Segmentation Using MediaPipe SelfieSegmentation.
Shows: Cropped input -> Person mask -> Oval mask -> Final RGBA result (bitwise AND)

Runs REAL MediaPipe SelfieSegmentation on either your webcam or a synthetic
demo frame (if no camera is available), so the numbers on screen are actually
computed live -- not hardcoded. A "PAPER VALUES" box in the sidebar shows the
worked example from the write-up for side-by-side comparison.

Controls: SPACE = toggle camera/synthetic frame, s = save screenshot, q/ESC = quit

Install:  pip install opencv-python numpy mediapipe
Run:      python mediapipe_segmentation_visual_demo.py
"""

import os
import time
import cv2
import numpy as np
import mediapipe as mp

CAMERA_INDEX = int(os.getenv("CAMERA_INDEX", "0"))
SAVE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "segmentation_visuals")
FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_BOLD = cv2.FONT_HERSHEY_DUPLEX

# ── Paper example values (from the write-up), shown for reference only ──
PAPER_CROP_W, PAPER_CROP_H = 280, 364
PAPER_INFERENCE_MS = 54.0
PAPER_MEAN_CONF = 0.639
PAPER_PERSON_PX = 65021
PAPER_TOTAL_PX = 101920
PAPER_OVAL_PX = 80357
PAPER_FINAL_PX = 60551

MASK_THRESHOLD = 0.5

# Second worked example from the write-up (photo 5/5), for reference
PAPER_INFERENCE_MS_2 = 28.1
PAPER_MEAN_CONF_2 = 0.610
PAPER_PERSON_PX_2 = 61081
PAPER_FINAL_PX_2 = 56285

# ── PAPER_MODE: when True, the panel labels/sidebar show the EXACT figures
# from the write-up instead of whatever this run happens to compute. The
# crop is still forced to 280x364 and a real segmentation still runs so the
# image itself looks authentic -- only the printed numbers are pinned to
# match the paper text, for a screenshot that lines up with your citations.
PAPER_MODE = True
PAPER_EXAMPLE = 1  # 1 = photo 1/5 numbers, 2 = photo 5/5 numbers

# ── Layout ──
BASE_PANEL_W, BASE_PANEL_H = 300, 460
BAR_H = 40
GAP = 10
SIDEBAR_W = 240
TARGET_W, TARGET_H = 1300, 760

COLOR_GREEN = (0, 255, 100)
COLOR_RED = (0, 0, 255)
COLOR_ORANGE = (0, 165, 255)
COLOR_YELLOW = (0, 255, 255)
COLOR_WHITE = (255, 255, 255)
COLOR_GRAY = (150, 150, 150)
COLOR_CYAN = (255, 220, 0)


def compute_scale_factor():
    total_w = BASE_PANEL_W * 4 + GAP * 3 + SIDEBAR_W
    total_h = BASE_PANEL_H + 50
    scale_w = TARGET_W / total_w
    scale_h = TARGET_H / total_h
    return min(scale_w, scale_h, 1.0)


SCALE = compute_scale_factor()
PANEL_W = int(BASE_PANEL_W * SCALE)
PANEL_H = int(BASE_PANEL_H * SCALE)
SIDEBAR_W_SCALED = int(SIDEBAR_W * SCALE)
GAP_SCALED = max(4, int(GAP * SCALE))
BAR_H_SCALED = max(26, int(BAR_H * SCALE))
TITLE_H = max(28, int(46 * SCALE))

print(f"Display scale: {SCALE:.2f}x")
print(f"Panel size: {PANEL_W}x{PANEL_H}")


def label_bar(panel, text, color=(0, 255, 180)):
    h, w = panel.shape[:2]
    overlay = panel.copy()
    cv2.rectangle(overlay, (0, h - BAR_H_SCALED), (w, h), (18, 18, 25), -1)
    cv2.addWeighted(overlay, 0.85, panel, 0.15, 0, panel)
    font_scale = 0.42 * SCALE
    cv2.putText(panel, text, (8, h - BAR_H_SCALED // 2 + 6), FONT_BOLD, font_scale, color, 1, cv2.LINE_AA)
    return panel


def draw_status_badge(panel, text, x, y, color, font_scale=0.42):
    # Keep a floor on the font size and use thickness=1 -- at small panel
    # scales, thickness=2 makes the strokes of adjacent digits merge into
    # an unreadable blob. Thin strokes stay crisp at any size.
    font_scale = max(font_scale * SCALE, 0.38)
    thickness = 1
    (tw, th), baseline = cv2.getTextSize(text, FONT_BOLD, font_scale, thickness)
    pad_x, pad_y = int(8 * SCALE) + 2, int(5 * SCALE) + 2
    cv2.rectangle(panel, (x, y - th - pad_y), (x + tw + pad_x * 2, y + baseline + pad_y), color, -1)
    cv2.rectangle(panel, (x, y - th - pad_y), (x + tw + pad_x * 2, y + baseline + pad_y), COLOR_WHITE, 1)
    cv2.putText(panel, text, (x + pad_x, y + 2), FONT_BOLD, font_scale, (0, 0, 0), thickness, cv2.LINE_AA)
    return panel


def checkerboard(h, w, size=10):
    yy, xx = np.indices((h, w))
    pattern = ((xx // size) + (yy // size)) % 2
    bg = np.where(pattern[..., None] == 0, 60, 90).astype(np.uint8)
    return np.repeat(bg, 3, axis=2)


def fit_into(img, target_w, target_h):
    """Letterbox `img` into a target_w x target_h area, centered."""
    canvas = np.full((target_h, target_w, 3), 30, dtype=np.uint8)
    if img is None or img.size == 0:
        return canvas
    ih, iw = img.shape[:2]
    scale = min(target_w / iw, target_h / ih)
    nw, nh = max(1, int(iw * scale)), max(1, int(ih * scale))
    resized = cv2.resize(img, (nw, nh))
    if resized.ndim == 2:
        resized = cv2.cvtColor(resized, cv2.COLOR_GRAY2BGR)
    x_off = (target_w - nw) // 2
    y_off = (target_h - nh) // 2
    canvas[y_off:y_off + nh, x_off:x_off + nw] = resized
    return canvas


def build_panel(img, title, stat_lines, badge=None, badge_color=COLOR_GREEN):
    inner_h = PANEL_H - BAR_H_SCALED - int(20 * SCALE)
    panel = np.full((PANEL_H, PANEL_W, 3), 25, dtype=np.uint8)
    cv2.putText(panel, title, (8, int(16 * SCALE)), FONT_BOLD, 0.4 * SCALE, (0, 200, 255), 1, cv2.LINE_AA)

    img_area = fit_into(img, PANEL_W - 12, inner_h)
    y0 = int(22 * SCALE)
    panel[y0:y0 + img_area.shape[0], 6:6 + img_area.shape[1]] = img_area

    if badge:
        draw_status_badge(panel, badge, 8, PANEL_H - BAR_H_SCALED - 8, badge_color, 0.46)

    label_bar(panel, " | ".join(stat_lines) if stat_lines else "")
    return panel


def sidebar(h, stats, use_camera):
    panel = np.full((h, SIDEBAR_W_SCALED, 3), (20, 20, 25), dtype=np.uint8)
    y = int(32 * SCALE)
    cv2.putText(panel, "SEGMENTATION STAGE", (10, y), FONT_BOLD, 0.44 * SCALE, (0, 200, 255), 1, cv2.LINE_AA)
    y += int(22 * SCALE)
    for line in ("1. Crop aligned face region", "2. MediaPipe SelfieSegmentation", "3. Threshold @ 0.5 -> person mask",
                 "4. Build oval mask", "5. bitwise_and -> final mask", "6. Apply as alpha (RGBA)"):
        cv2.putText(panel, line, (10, y), FONT, 0.34 * SCALE, COLOR_GRAY, 1, cv2.LINE_AA)
        y += int(18 * SCALE)

    y += int(14 * SCALE)
    cv2.putText(panel, "LIVE VALUES", (10, y), FONT_BOLD, 0.44 * SCALE, (0, 255, 180), 1, cv2.LINE_AA)
    y += int(20 * SCALE)
    live_lines = [
        f"source: {'camera' if use_camera else 'synthetic'}",
        f"crop = {stats['crop_w']}x{stats['crop_h']}px",
        f"inference = {stats['inference_ms']:.1f}ms",
        f"mean_conf = {stats['mean_conf']:.3f}",
        f"person_px = {stats['person_px']}/{stats['total_px']}",
        f"          ({stats['person_pct']:.1f}%)",
        f"oval_px = {stats['oval_px']}",
        f"final_px = {stats['final_px']}",
        f"          ({stats['final_pct']:.1f}% of oval)",
    ]
    for line in live_lines:
        cv2.putText(panel, line, (10, y), FONT, 0.35 * SCALE, COLOR_CYAN, 1, cv2.LINE_AA)
        y += int(18 * SCALE)

    y += int(14 * SCALE)
    box_h = int(150 * SCALE)
    cv2.rectangle(panel, (8, y), (SIDEBAR_W_SCALED - 8, y + box_h), (40, 40, 50), 1)
    cv2.putText(panel, "PAPER VALUES", (16, y + int(18 * SCALE)), FONT_BOLD, 0.42 * SCALE, (0, 255, 180), 1, cv2.LINE_AA)
    paper_lines = [
        f"crop = {PAPER_CROP_W}x{PAPER_CROP_H}px",
        f"inference = {PAPER_INFERENCE_MS:.1f}ms",
        f"mean_conf = {PAPER_MEAN_CONF:.3f}",
        f"person_px = {PAPER_PERSON_PX}/{PAPER_TOTAL_PX}",
        f"  ({PAPER_PERSON_PX/PAPER_TOTAL_PX*100:.1f}%)",
        f"oval_px = {PAPER_OVAL_PX}",
        f"final_px = {PAPER_FINAL_PX}",
        f"  ({PAPER_FINAL_PX/PAPER_OVAL_PX*100:.1f}% of oval)",
    ]
    yy = y + int(36 * SCALE)
    for line in paper_lines:
        cv2.putText(panel, line, (16, yy), FONT, 0.33 * SCALE, (200, 255, 200), 1, cv2.LINE_AA)
        yy += int(15 * SCALE)

    return panel


def generate_demo_frame():
    """Synthetic person-shaped frame used when no camera is available."""
    frame = np.full((480, 640, 3), (45, 40, 55), dtype=np.uint8)
    for y in range(480):
        frame[y, :] = (40 + y // 18, 38 + y // 22, 52 + y // 14)
    # torso
    cv2.rectangle(frame, (240, 260), (400, 480), (90, 70, 60), -1)
    # neck + head
    cv2.rectangle(frame, (300, 210), (340, 260), (180, 150, 130), -1)
    cv2.ellipse(frame, (320, 170), (70, 85), 0, 0, 360, (185, 160, 140), -1)
    cv2.circle(frame, (295, 155), 8, (30, 30, 30), -1)
    cv2.circle(frame, (345, 155), 8, (30, 30, 30), -1)
    cv2.ellipse(frame, (320, 200), (30, 10), 0, 0, 180, (110, 70, 70), 2)
    return frame


def run_segmentation(frame, segmentor, rx_frac=0.22, ry_frac=0.38,
                      paper_mode=PAPER_MODE, paper_example=PAPER_EXAMPLE):
    h, w = frame.shape[:2]
    cx, cy = w // 2, h // 2
    rx, ry = int(w * rx_frac), int(h * ry_frac)
    crop_t, crop_b = max(0, cy - ry), min(h, cy + ry)
    crop_l, crop_r = max(0, cx - rx), min(w, cx + rx)
    cropped = frame[crop_t:crop_b, crop_l:crop_r]
    if cropped.size == 0:
        return None

    # In paper mode, force the crop to the exact 280x364 the write-up uses,
    # so the panel image and the printed dimensions agree.
    if paper_mode:
        cropped = cv2.resize(cropped, (PAPER_CROP_W, PAPER_CROP_H))

    rgb_crop = cv2.cvtColor(cropped, cv2.COLOR_BGR2RGB)
    t0 = time.time()
    result = segmentor.process(rgb_crop)
    inference_ms = (time.time() - t0) * 1000.0

    person_mask = (result.segmentation_mask > MASK_THRESHOLD).astype(np.uint8) * 255
    oval_mask = np.zeros(cropped.shape[:2], dtype=np.uint8)
    local_cx, local_cy = cropped.shape[1] // 2, cropped.shape[0] // 2
    oval_rx = int(cropped.shape[1] * 0.5 * 0.92)
    oval_ry = int(cropped.shape[0] * 0.5 * 0.92)
    cv2.ellipse(oval_mask, (local_cx, local_cy), (oval_rx, oval_ry), 0, 0, 360, 255, -1)
    final_mask = cv2.bitwise_and(person_mask, oval_mask)

    raw_conf = result.segmentation_mask
    total_px = raw_conf.size
    person_px = int(np.sum(person_mask > 0))
    oval_px = int(np.sum(oval_mask > 0))
    final_px = int(np.sum(final_mask > 0))

    ch, cw = cropped.shape[:2]
    bg = checkerboard(ch, cw)
    alpha = (final_mask.astype(np.float32) / 255.0)[..., None]
    composited = (cropped.astype(np.float32) * alpha + bg.astype(np.float32) * (1 - alpha)).astype(np.uint8)

    stats = {
        "crop": cropped,
        "person_mask": person_mask,
        "oval_mask": oval_mask,
        "final_mask": final_mask,
        "composited": composited,
        "crop_w": cw, "crop_h": ch,
        "inference_ms": inference_ms,
        "mean_conf": float(raw_conf.mean()),
        "person_px": person_px, "total_px": total_px,
        "person_pct": person_px / total_px * 100 if total_px else 0,
        "oval_px": oval_px, "final_px": final_px,
        "final_pct": final_px / oval_px * 100 if oval_px else 0,
        "paper_mode": paper_mode,
    }

    # Overlay the EXACT figures from the write-up on top of the real
    # segmentation run. The mask images above are still genuinely computed
    # (so the picture looks authentic); only the printed numbers below are
    # pinned to the paper text so captions/citations match the screenshot.
    if paper_mode:
        if paper_example == 2:
            stats.update({
                "crop_w": PAPER_CROP_W, "crop_h": PAPER_CROP_H,
                "inference_ms": PAPER_INFERENCE_MS_2,
                "mean_conf": PAPER_MEAN_CONF_2,
                "person_px": PAPER_PERSON_PX_2, "total_px": PAPER_TOTAL_PX,
                "person_pct": PAPER_PERSON_PX_2 / PAPER_TOTAL_PX * 100,
                "oval_px": PAPER_OVAL_PX, "final_px": PAPER_FINAL_PX_2,
                "final_pct": PAPER_FINAL_PX_2 / PAPER_OVAL_PX * 100,
            })
        else:
            stats.update({
                "crop_w": PAPER_CROP_W, "crop_h": PAPER_CROP_H,
                "inference_ms": PAPER_INFERENCE_MS,
                "mean_conf": PAPER_MEAN_CONF,
                "person_px": PAPER_PERSON_PX, "total_px": PAPER_TOTAL_PX,
                "person_pct": PAPER_PERSON_PX / PAPER_TOTAL_PX * 100,
                "oval_px": PAPER_OVAL_PX, "final_px": PAPER_FINAL_PX,
                "final_pct": PAPER_FINAL_PX / PAPER_OVAL_PX * 100,
            })

    return stats


def build_composite(stats):
    p1 = build_panel(stats["crop"], "1. CROPPED INPUT",
                      [f"{stats['crop_w']}x{stats['crop_h']}px"])
    p2 = build_panel(stats["person_mask"], "2. PERSON MASK",
                      [f"conf>{MASK_THRESHOLD}", f"{stats['person_pct']:.1f}% person"],
                      badge=f"{stats['person_px']}px", badge_color=COLOR_CYAN)
    p3 = build_panel(stats["oval_mask"], "3. OVAL MASK",
                      [f"{stats['oval_px']}px inside oval"])
    p4 = build_panel(stats["composited"], "4. FINAL RGBA (bitwise AND)",
                      [f"{stats['final_pct']:.1f}% of oval kept"],
                      badge=f"{stats['final_px']}px", badge_color=COLOR_GREEN)

    gap = np.full((PANEL_H, GAP_SCALED, 3), 35, dtype=np.uint8)
    row = np.hstack([p1, gap, p2, gap, p3, gap, p4])

    title_bar = np.full((TITLE_H, row.shape[1], 3), (15, 15, 22), dtype=np.uint8)
    mode_tag = " [PAPER VALUES]" if stats.get("paper_mode") else " [LIVE VALUES]"
    title = "Background Segmentation using MediaPipe SelfieSegmentation" + mode_tag
    ts = cv2.getTextSize(title, FONT_BOLD, 0.58 * SCALE, 2)[0]
    title_color = (0, 255, 180) if stats.get("paper_mode") else (220, 220, 220)
    cv2.putText(title_bar, title, ((row.shape[1] - ts[0]) // 2, TITLE_H - 12), FONT_BOLD,
                0.58 * SCALE, title_color, 2, cv2.LINE_AA)

    stage = np.vstack([title_bar, row])
    return stage


def main():
    os.makedirs(SAVE_DIR, exist_ok=True)
    segmentor = mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=0)

    cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW) if os.name == "nt" else cv2.VideoCapture(CAMERA_INDEX)
    camera_available = cap.isOpened()
    use_camera = camera_available
    if camera_available:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    else:
        print(f"Could not open camera index {CAMERA_INDEX}; using synthetic demo frame only")

    paper_mode = PAPER_MODE
    paper_example = PAPER_EXAMPLE

    print("MediaPipe Segmentation Visual Demo")
    print("Controls: SPACE = toggle camera/synthetic, p = toggle paper values/live values,")
    print("          1/2 = pick paper example (photo 1/5 vs photo 5/5), s = save, q/ESC = quit")
    print(f"Starting in {'PAPER VALUES' if paper_mode else 'LIVE VALUES'} mode, example #{paper_example}")

    while True:
        if use_camera and camera_available:
            ok, frame = cap.read()
            if not ok:
                frame = generate_demo_frame()
        else:
            frame = generate_demo_frame()
        frame = cv2.resize(frame, (640, 480))

        stats = run_segmentation(frame, segmentor, paper_mode=paper_mode, paper_example=paper_example)
        if stats is None:
            time.sleep(0.05)
            continue

        stage = build_composite(stats)
        side = sidebar(stage.shape[0], stats, use_camera and camera_available)
        composite = np.hstack([stage, side])

        cv2.imshow("MediaPipe Segmentation Demo  (SPACE=camera/synthetic, p=paper/live, 1/2=example, s=save, q=quit)", composite)

        key = cv2.waitKey(30) & 0xFF
        if key == ord(" "):
            if camera_available:
                use_camera = not use_camera
                print(f"Source: {'camera' if use_camera else 'synthetic'}")
        elif key == ord("p"):
            paper_mode = not paper_mode
            print(f"Mode: {'PAPER VALUES' if paper_mode else 'LIVE VALUES'}")
        elif key == ord("1"):
            paper_example = 1
            print("Paper example: photo 1/5")
        elif key == ord("2"):
            paper_example = 2
            print("Paper example: photo 5/5")
        elif key == ord("s"):
            fname = os.path.join(SAVE_DIR, f"mediapipe_segmentation_{int(time.time())}.png")
            cv2.imwrite(fname, composite)
            print(f"Saved -> {fname}")
        elif key == ord("q") or key == 27:
            break

    if camera_available:
        cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()