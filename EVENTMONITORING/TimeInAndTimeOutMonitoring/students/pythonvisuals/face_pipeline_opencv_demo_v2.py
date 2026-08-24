"""
face_alignment_stability_visual_demo.py

Interactive visualization of Face Alignment & Stability Validation.
Shows: HOG+SVM detection -> Alignment check (position + size) -> Stability window -> Countdown -> Capture

Uses paper example (hardcoded) values for alignment and stability tracking.

Controls: SPACE = cycle scenarios, a = toggle alignment pass/fail,
          t = toggle stability pass/fail, c = toggle capture ready,
          s = save, q/ESC = quit
Install:  pip install opencv-python numpy
Run:      python face_alignment_stability_visual_demo.py
"""

import os
import time
import cv2
import numpy as np

CAMERA_INDEX = int(os.getenv("CAMERA_INDEX", "0"))
SAVE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "alignment_visuals")
FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_BOLD = cv2.FONT_HERSHEY_DUPLEX

# ── Paper example values (hardcoded) ──
PAPER_BBOX = {"x": 220, "y": 220, "w": 204, "h": 208}
PAPER_SCORE = 1.2354
PAPER_SCAN_MS = 78.8

# Alignment / stability thresholds from the paper
ALIGN_NORM_DIST_THRESH = 0.400
ALIGN_WIDTH_RATIO_MIN = 1.30
ALIGN_WIDTH_RATIO_MAX = 1.80
STABILITY_MAX_DX = 10
STABILITY_MAX_DY = 10
STABILITY_WINDOW_SIZE = 8
STABILITY_MIN_SAMPLES = 5
COUNTDOWN_SECONDS = 2

# ── Layout ──
# Base panel size - will be scaled down to fit screen
BASE_PANEL_W, BASE_PANEL_H = 460, 460
BAR_H = 46
GAP = 12
SIDEBAR_W = 230

# Target window size (fits on most screens including 1366x768 laptops)
TARGET_W, TARGET_H = 1200, 800

COLOR_GREEN = (0, 255, 100)
COLOR_RED = (0, 0, 255)
COLOR_ORANGE = (0, 165, 255)
COLOR_YELLOW = (0, 255, 255)
COLOR_WHITE = (255, 255, 255)
COLOR_GRAY = (150, 150, 150)


def compute_scale_factor():
    """Compute how much we need to scale down to fit the target window."""
    # Total dimensions at 1.0 scale
    total_w = BASE_PANEL_W * 2 + GAP + SIDEBAR_W
    total_h = BASE_PANEL_H * 2 + GAP + 44  # 44 = title bar

    scale_w = TARGET_W / total_w
    scale_h = TARGET_H / total_h
    return min(scale_w, scale_h, 1.0)  # Never upscale beyond 1.0


SCALE = compute_scale_factor()
PANEL_W = int(BASE_PANEL_W * SCALE)
PANEL_H = int(BASE_PANEL_H * SCALE)
SIDEBAR_W_SCALED = int(SIDEBAR_W * SCALE)
GAP_SCALED = max(4, int(GAP * SCALE))
BAR_H_SCALED = max(28, int(BAR_H * SCALE))
TITLE_H = max(28, int(44 * SCALE))

print(f"Display scale: {SCALE:.2f}x")
print(f"Panel size: {PANEL_W}x{PANEL_H}")
print(f"Total window: {PANEL_W*2 + GAP_SCALED + SIDEBAR_W_SCALED}x{PANEL_H*2 + GAP_SCALED + TITLE_H}")


def content_floor():
    """Lowest y any panel's content may draw at, leaving room for the label bar."""
    return PANEL_H - BAR_H_SCALED - 10


def label_bar(panel, text):
    h, w = panel.shape[:2]
    overlay = panel.copy()
    cv2.rectangle(overlay, (0, h - BAR_H_SCALED), (w, h), (18, 18, 25), -1)
    cv2.addWeighted(overlay, 0.85, panel, 0.15, 0, panel)
    font_scale = 0.48 * SCALE
    cv2.putText(panel, text, (10, h - BAR_H_SCALED // 2 + 6), FONT_BOLD, font_scale, (0, 255, 180), 1, cv2.LINE_AA)
    return panel


def draw_text_bg(panel, text, pos, font_scale=0.5, color=COLOR_WHITE, thickness=1, alpha=0.65):
    font_scale = font_scale * SCALE
    (tw, th), baseline = cv2.getTextSize(text, FONT, font_scale, thickness)
    x, y = pos
    pad = int(5 * SCALE)
    bg = panel.copy()
    cv2.rectangle(bg, (x - pad, y - th - pad), (x + tw + pad, y + baseline + pad), (0, 0, 0), -1)
    cv2.addWeighted(bg, alpha, panel, 1 - alpha, 0, panel)
    cv2.putText(panel, text, (x, y), FONT, font_scale, color, thickness, cv2.LINE_AA)
    return panel


def draw_status_badge(panel, text, x, y, color, font_scale=0.48):
    font_scale = font_scale * SCALE
    (tw, th), baseline = cv2.getTextSize(text, FONT_BOLD, font_scale, 2)
    pad_x, pad_y = int(9 * SCALE), int(6 * SCALE)
    cv2.rectangle(panel, (x, y - th - pad_y), (x + tw + pad_x * 2, y + baseline + pad_y), color, -1)
    cv2.rectangle(panel, (x, y - th - pad_y), (x + tw + pad_x * 2, y + baseline + pad_y), COLOR_WHITE, 1)
    cv2.putText(panel, text, (x + pad_x, y + 2), FONT_BOLD, font_scale, (0, 0, 0), 2, cv2.LINE_AA)
    return panel


def draw_progress_bar(panel, x, y, w, h, progress, color, bg_color=(50, 50, 50)):
    cv2.rectangle(panel, (x, y), (x + w, y + h), bg_color, -1)
    fill_w = int(w * max(0.0, min(1.0, progress)))
    if fill_w > 0:
        cv2.rectangle(panel, (x, y), (x + fill_w, y + h), color, -1)
    cv2.rectangle(panel, (x, y), (x + w, y + h), COLOR_WHITE, 1)
    return panel


def build_input_panel(frame, bbox, face_color):
    content_h = PANEL_H - BAR_H_SCALED
    panel = cv2.resize(frame, (PANEL_W, content_h))
    panel = cv2.copyMakeBorder(panel, 0, BAR_H_SCALED, 0, 0, cv2.BORDER_CONSTANT, value=(25, 25, 25))
    h, w = panel.shape[:2]
    inner_h = h - BAR_H_SCALED

    cx, cy = w // 2, inner_h // 2
    rx, ry = int(w * 0.22), int(inner_h * 0.38)
    cv2.ellipse(panel, (cx, cy), (rx, ry), 0, 0, 360, (200, 200, 200), 1)

    scale_x = w / frame.shape[1]
    scale_y = inner_h / frame.shape[0]
    px, py = int(bbox["x"] * scale_x), int(bbox["y"] * scale_y)
    pw, ph = int(bbox["w"] * scale_x), int(bbox["h"] * scale_y)
    cv2.rectangle(panel, (px, py), (px + pw, py + ph), face_color, max(1, int(2 * SCALE)))
    face_cx, face_cy = px + pw // 2, py + ph // 2
    cv2.circle(panel, (face_cx, face_cy), max(2, int(4 * SCALE)), face_color, -1)
    cv2.circle(panel, (face_cx, face_cy), max(2, int(6 * SCALE)), COLOR_WHITE, 1)

    draw_text_bg(panel, f"Face: [{bbox['x']},{bbox['y']},{bbox['w']},{bbox['h']}]", (10, 20), 0.42, face_color)
    label_bar(panel, "STEP 1: INPUT FRAME  |  HOG+SVM detection")
    return panel


def build_alignment_panel(bbox, alignment_passed, normalized_dist, width_ratio):
    panel = np.full((PANEL_H, PANEL_W, 3), 25, dtype=np.uint8)
    floor = content_floor()

    cv2.putText(panel, "STEP 2: ALIGNMENT & SIZE", (12, 24), FONT_BOLD, 0.58 * SCALE, (0, 200, 255), 1, cv2.LINE_AA)

    # ── Mini oval + face preview ──
    mini_size = int(190 * SCALE)
    mini = np.full((mini_size, mini_size, 3), 35, dtype=np.uint8)
    oval_cx, oval_cy = mini_size // 2, mini_size // 2
    oval_rx, oval_ry = int(mini_size * 0.35), int(mini_size * 0.40)
    cv2.ellipse(mini, (oval_cx, oval_cy), (oval_rx, oval_ry), 0, 0, 360, (180, 180, 180), 1)
    face_color = COLOR_GREEN if alignment_passed else COLOR_RED
    scale = min(mini_size / 640, mini_size / 480)
    fx, fy = int(bbox["x"] * scale), int(bbox["y"] * scale)
    fw, fh = int(bbox["w"] * scale), int(bbox["h"] * scale)
    cv2.rectangle(mini, (fx, fy), (fx + fw, fy + fh), face_color, max(1, int(2 * SCALE)))
    face_cx, face_cy = fx + fw // 2, fy + fh // 2
    cv2.circle(mini, (face_cx, face_cy), max(2, int(3 * SCALE)), face_color, -1)
    cv2.line(mini, (oval_cx, oval_cy), (face_cx, face_cy), COLOR_YELLOW, 1, cv2.LINE_AA)

    mini_x, mini_y = 16, 40
    panel[mini_y:mini_y + mini_size, mini_x:mini_x + mini_size] = mini

    # ── Math reference next to the mini preview ──
    math_x = mini_x + mini_size + 14
    cv2.putText(panel, "normalized_dist =", (math_x, mini_y + 16), FONT_BOLD, 0.4 * SCALE, COLOR_WHITE, 1, cv2.LINE_AA)
    cv2.putText(panel, "(dx^2/rx^2)+(dy^2/ry^2)", (math_x, mini_y + 32), FONT, 0.35 * SCALE, COLOR_GRAY, 1, cv2.LINE_AA)
    cv2.putText(panel, "width_ratio =", (math_x, mini_y + 54), FONT_BOLD, 0.4 * SCALE, COLOR_WHITE, 1, cv2.LINE_AA)
    cv2.putText(panel, "face_width / oval_rx", (math_x, mini_y + 70), FONT, 0.35 * SCALE, COLOR_GRAY, 1, cv2.LINE_AA)

    # ── Results ──
    y = mini_y + mini_size + 24
    nd_color = COLOR_GREEN if normalized_dist <= ALIGN_NORM_DIST_THRESH else COLOR_RED
    nd_pass = "PASS" if normalized_dist <= ALIGN_NORM_DIST_THRESH else "FAIL"
    cv2.putText(panel, f"normalized_dist = {normalized_dist:.3f}  (<= {ALIGN_NORM_DIST_THRESH})", (12, y), FONT, 0.42 * SCALE, nd_color, 1, cv2.LINE_AA)
    draw_status_badge(panel, nd_pass, PANEL_W - 90, y - 10, nd_color)

    y += int(32 * SCALE)
    wr_ok = ALIGN_WIDTH_RATIO_MIN <= width_ratio <= ALIGN_WIDTH_RATIO_MAX
    wr_color = COLOR_GREEN if wr_ok else COLOR_RED
    wr_pass = "PASS" if wr_ok else "FAIL"
    cv2.putText(panel, f"width_ratio = {width_ratio:.2f}  ({ALIGN_WIDTH_RATIO_MIN}-{ALIGN_WIDTH_RATIO_MAX})", (12, y), FONT, 0.42 * SCALE, wr_color, 1, cv2.LINE_AA)
    draw_status_badge(panel, wr_pass, PANEL_W - 90, y - 10, wr_color)

    y += int(38 * SCALE)
    status_color = COLOR_GREEN if alignment_passed else COLOR_RED
    status_text = "ACCEPTED" if alignment_passed else "REJECTED"
    draw_status_badge(panel, status_text, 12, y, status_color, 0.55)
    reason = "Face centered and correctly sized" if alignment_passed else "Adjust position or distance"
    cv2.putText(panel, reason, (130, y + 2), FONT, 0.4 * SCALE, status_color, 1, cv2.LINE_AA)

    assert y <= floor, f"alignment panel overflowed: y={y}, floor={floor}"
    label_bar(panel, f"STEP 2  |  dist={normalized_dist:.3f}  ratio={width_ratio:.2f}")
    return panel


def build_stability_panel(center_history, stability_passed, countdown_remaining, capture_ready):
    panel = np.full((PANEL_H, PANEL_W, 3), 25, dtype=np.uint8)
    floor = content_floor()

    cv2.putText(panel, "STEP 3: STABILITY WINDOW", (12, 24), FONT_BOLD, 0.58 * SCALE, (0, 200, 255), 1, cv2.LINE_AA)

    graph_w = PANEL_W - 40
    graph_h = int(190 * SCALE)
    graph_x, graph_y = 20, 40
    graph = np.full((graph_h, graph_w, 3), 35, dtype=np.uint8)
    for i in range(5):
        gy = int(graph_h * i / 4)
        cv2.line(graph, (0, gy), (graph_w, gy), (50, 50, 50), 1)
    cx, cy = graph_w // 2, graph_h // 2
    cv2.line(graph, (cx, 0), (cx, graph_h), (80, 80, 80), 1)
    cv2.line(graph, (0, cy), (graph_w, cy), (80, 80, 80), 1)
    cv2.circle(graph, (cx, cy), max(2, int(4 * SCALE)), (100, 100, 100), -1)

    if len(center_history) >= 2:
        xs = [p[0] for p in center_history]
        ys = [p[1] for p in center_history]
        base_x, base_y = xs[0], ys[0]
        pts = []
        for x, y_ in center_history:
            gx = int(np.clip(cx + (x - base_x), 10, graph_w - 10))
            gy = int(np.clip(cy + (y_ - base_y), 10, graph_h - 10))
            pts.append((gx, gy))
        color = COLOR_GREEN if stability_passed else COLOR_ORANGE
        for i in range(1, len(pts)):
            cv2.line(graph, pts[i - 1], pts[i], color, max(1, int(2 * SCALE)), cv2.LINE_AA)
        for i, p in enumerate(pts):
            r = max(3, int(5 * SCALE)) if i == len(pts) - 1 else max(2, int(3 * SCALE))
            cv2.circle(graph, p, r, color, -1)
    panel[graph_y:graph_y + graph_h, graph_x:graph_x + graph_w] = graph

    y = graph_y + graph_h + 22
    if len(center_history) >= STABILITY_MIN_SAMPLES:
        xs = [p[0] for p in center_history]
        ys = [p[1] for p in center_history]
        max_dx = max(xs) - min(xs)
        max_dy = max(ys) - min(ys)
        dx_color = COLOR_GREEN if max_dx < STABILITY_MAX_DX else COLOR_RED
        dy_color = COLOR_GREEN if max_dy < STABILITY_MAX_DY else COLOR_RED
        cv2.putText(panel, f"max_dx={max_dx}px (<{STABILITY_MAX_DX})", (16, y), FONT, 0.4 * SCALE, dx_color, 1, cv2.LINE_AA)
        cv2.putText(panel, f"max_dy={max_dy}px (<{STABILITY_MAX_DY})", (200, y), FONT, 0.4 * SCALE, dy_color, 1, cv2.LINE_AA)

        y += int(26 * SCALE)
        cv2.putText(panel, f"window = {len(center_history)}/{STABILITY_WINDOW_SIZE}", (16, y), FONT, 0.4 * SCALE, COLOR_YELLOW, 1, cv2.LINE_AA)

        y += int(32 * SCALE)
        if stability_passed:
            draw_status_badge(panel, "STEADY", 16, y, COLOR_GREEN, 0.5)
            if capture_ready:
                cv2.putText(panel, "-> CAPTURE!", (130, y + 2), FONT_BOLD, 0.5 * SCALE, COLOR_GREEN, 2, cv2.LINE_AA)
            else:
                progress = 1.0 - (countdown_remaining / COUNTDOWN_SECONDS)
                bar_w = int(130 * SCALE)
                draw_progress_bar(panel, 130, y - 14, bar_w, int(18 * SCALE), progress, COLOR_GREEN)
                cv2.putText(panel, f"{countdown_remaining}s", (130 + bar_w + 10, y), FONT_BOLD, 0.5 * SCALE, COLOR_YELLOW, 1, cv2.LINE_AA)
        else:
            draw_status_badge(panel, "NOT STEADY", 16, y, COLOR_ORANGE, 0.5)
            cv2.putText(panel, "countdown resets", (170, y + 2), FONT, 0.4 * SCALE, COLOR_ORANGE, 1, cv2.LINE_AA)
    else:
        cv2.putText(panel, f"Collecting samples {len(center_history)}/{STABILITY_MIN_SAMPLES}", (16, y), FONT, 0.42 * SCALE, COLOR_YELLOW, 1, cv2.LINE_AA)

    assert y <= floor, f"stability panel overflowed: y={y}, floor={floor}"
    label_bar(panel, f"STEP 3  |  max_dx/dy < {STABILITY_MAX_DX}px  countdown={COUNTDOWN_SECONDS}s")
    return panel


def build_result_panel(alignment_passed, stability_passed, capture_ready, bbox):
    panel = np.full((PANEL_H, PANEL_W, 3), 25, dtype=np.uint8)
    floor = content_floor()

    cv2.putText(panel, "STEP 4: CAPTURE RESULT", (12, 24), FONT_BOLD, 0.58 * SCALE, (0, 200, 255), 1, cv2.LINE_AA)

    steps = [
        ("1. HOG+SVM Detection", "Face detected, SVM_score > 0", COLOR_GREEN, None),
        ("2. Alignment & Size", "normalized_dist + width_ratio", COLOR_GREEN if alignment_passed else COLOR_RED,
         "PASS" if alignment_passed else "FAIL"),
        ("3. Stability Window", f"max_dx/dy < {STABILITY_MAX_DX}px", COLOR_GREEN if stability_passed else COLOR_ORANGE,
         "PASS" if stability_passed else "WAITING"),
        ("4. Photo Capture", "2s countdown then capture", COLOR_GREEN if capture_ready else COLOR_YELLOW,
         "READY" if capture_ready else "COUNTING"),
    ]

    box_h = int(56 * SCALE)
    y = 40
    stop_after = None
    if not alignment_passed:
        stop_after = 1
    elif not stability_passed:
        stop_after = 2
    elif not capture_ready:
        stop_after = 3

    for i, (title, sub, color, badge_text) in enumerate(steps):
        cv2.rectangle(panel, (12, y), (PANEL_W - 12, y + box_h), (40, 40, 40), -1)
        cv2.rectangle(panel, (12, y), (PANEL_W - 12, y + box_h), color, max(1, int(2 * SCALE)))
        cv2.putText(panel, title, (22, y + int(20 * SCALE)), FONT_BOLD, 0.46 * SCALE, color, 1, cv2.LINE_AA)
        cv2.putText(panel, sub, (22, y + int(38 * SCALE)), FONT, 0.36 * SCALE, COLOR_GRAY, 1, cv2.LINE_AA)
        if badge_text:
            draw_status_badge(panel, badge_text, PANEL_W - 110, y + int(16 * SCALE), color, 0.42)
        y += box_h + int(12 * SCALE)
        if stop_after is not None and i + 1 > stop_after:
            break
        if stop_after == i + 1:
            break

    if capture_ready:
        cv2.putText(panel, "CAPTURE COMPLETE!", (22, y + 8), FONT_BOLD, 0.55 * SCALE, COLOR_GREEN, 2, cv2.LINE_AA)
        cv2.putText(panel, f"bbox=[{bbox['x']},{bbox['y']},{bbox['w']},{bbox['h']}]", (22, y + int(30 * SCALE)), FONT, 0.4 * SCALE, COLOR_GREEN, 1, cv2.LINE_AA)
        y += int(40 * SCALE)

    assert y <= floor, f"result panel overflowed: y={y}, floor={floor}"
    status = f"align={'PASS' if alignment_passed else 'FAIL'} | steady={'PASS' if stability_passed else 'FAIL'} | capture={'DONE' if capture_ready else 'WAIT'}"
    label_bar(panel, f"STEP 4  |  {status}")
    return panel


def sidebar(h):
    panel = np.full((h, SIDEBAR_W_SCALED, 3), (20, 20, 25), dtype=np.uint8)
    y = int(36 * SCALE)
    cv2.putText(panel, "VALIDATION FLOW", (10, y), FONT_BOLD, 0.5 * SCALE, (0, 200, 255), 1, cv2.LINE_AA)
    y += int(24 * SCALE)
    for line in ("1. Detect (HOG+SVM)", "2. Align + size check", "3. Stability window", "4. 2s countdown -> capture"):
        cv2.putText(panel, line, (10, y), FONT, 0.4 * SCALE, COLOR_GRAY, 1, cv2.LINE_AA)
        y += int(20 * SCALE)

    y += int(16 * SCALE)
    cv2.putText(panel, "THRESHOLDS", (10, y), FONT_BOLD, 0.5 * SCALE, (0, 255, 180), 1, cv2.LINE_AA)
    y += int(22 * SCALE)
    for line in (
        f"norm_dist <= {ALIGN_NORM_DIST_THRESH}",
        f"width_ratio {ALIGN_WIDTH_RATIO_MIN}-{ALIGN_WIDTH_RATIO_MAX}",
        f"max_dx/dy < {STABILITY_MAX_DX}px",
        f"countdown = {COUNTDOWN_SECONDS}s",
    ):
        cv2.putText(panel, line, (10, y), FONT, 0.4 * SCALE, COLOR_GRAY, 1, cv2.LINE_AA)
        y += int(18 * SCALE)

    y += int(16 * SCALE)
    box_h = int(80 * SCALE)
    cv2.rectangle(panel, (8, y), (SIDEBAR_W_SCALED - 8, y + box_h), (40, 40, 50), 1)
    cv2.putText(panel, "PAPER VALUES", (16, y + int(18 * SCALE)), FONT_BOLD, 0.46 * SCALE, (0, 255, 180), 1, cv2.LINE_AA)
    cv2.putText(panel, f"bbox=[{PAPER_BBOX['x']},{PAPER_BBOX['y']},", (16, y + int(36 * SCALE)), FONT, 0.36 * SCALE, (200, 255, 200), 1, cv2.LINE_AA)
    cv2.putText(panel, f"      {PAPER_BBOX['w']},{PAPER_BBOX['h']}]", (16, y + int(52 * SCALE)), FONT, 0.36 * SCALE, (200, 255, 200), 1, cv2.LINE_AA)
    cv2.putText(panel, f"SVM_score={PAPER_SCORE}", (16, y + int(68 * SCALE)), FONT, 0.36 * SCALE, (200, 255, 200), 1, cv2.LINE_AA)

    return panel


def build_composite(frame, alignment_passed, stability_passed, capture_ready, center_history, countdown_remaining):
    bx, by = PAPER_BBOX["x"], PAPER_BBOX["y"]
    bw, bh = PAPER_BBOX["w"], PAPER_BBOX["h"]
    bbox = {"x": bx, "y": by, "w": bw, "h": bh}

    h, w = frame.shape[:2]
    cx, cy = w // 2, h // 2
    rx, ry = int(w * 0.22), int(h * 0.38)
    face_cx, face_cy = bx + bw // 2, by + bh // 2
    normalized_dist = ((face_cx - cx) ** 2 / (rx ** 2)) + ((face_cy - cy) ** 2 / (ry ** 2))
    width_ratio = bw / rx if rx else 0

    if not alignment_passed:
        face_color = COLOR_RED
    elif not stability_passed:
        face_color = COLOR_ORANGE
    elif capture_ready:
        face_color = COLOR_GREEN
    else:
        face_color = COLOR_YELLOW

    p1 = build_input_panel(frame, bbox, face_color)
    p2 = build_alignment_panel(bbox, alignment_passed, normalized_dist, width_ratio)
    p3 = build_stability_panel(center_history, stability_passed, countdown_remaining, capture_ready)
    p4 = build_result_panel(alignment_passed, stability_passed, capture_ready, bbox)

    gap_v = np.full((PANEL_H, GAP_SCALED, 3), 35, dtype=np.uint8)
    gap_h = np.full((GAP_SCALED, PANEL_W * 2 + GAP_SCALED, 3), 35, dtype=np.uint8)
    top = np.hstack([p1, gap_v, p2])
    bot = np.hstack([p3, gap_v, p4])
    grid = np.vstack([top, gap_h, bot])

    title_bar = np.full((TITLE_H, grid.shape[1], 3), (15, 15, 22), dtype=np.uint8)
    title = "Face Alignment & Stability Validation Pipeline"
    ts = cv2.getTextSize(title, FONT_BOLD, 0.75 * SCALE, 2)[0]
    cv2.putText(title_bar, title, ((grid.shape[1] - ts[0]) // 2, TITLE_H - 10), FONT_BOLD, 0.75 * SCALE, (220, 220, 220), 2, cv2.LINE_AA)

    composite = np.vstack([title_bar, grid])
    side = sidebar(composite.shape[0])
    return np.hstack([composite, side])


def generate_demo_frame():
    frame = np.full((480, 640, 3), (40, 40, 50), dtype=np.uint8)
    for y in range(480):
        frame[y, :] = (40 + y // 20, 40 + y // 25, 50 + y // 15)
    face_cx, face_cy = 320, 240
    cv2.ellipse(frame, (face_cx, face_cy), (100, 120), 0, 0, 360, (180, 160, 140), -1)
    cv2.circle(frame, (face_cx - 35, face_cy - 20), 12, (30, 30, 30), -1)
    cv2.circle(frame, (face_cx + 35, face_cy - 20), 12, (30, 30, 30), -1)
    cv2.circle(frame, (face_cx - 33, face_cy - 22), 4, (220, 220, 220), -1)
    cv2.circle(frame, (face_cx + 37, face_cy - 22), 4, (220, 220, 220), -1)
    cv2.ellipse(frame, (face_cx, face_cy + 15), (8, 15), 0, 0, 360, (140, 120, 100), -1)
    cv2.ellipse(frame, (face_cx, face_cy + 50), (30, 12), 0, 0, 180, (100, 60, 60), 2)
    return frame


def main():
    cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW) if os.name == "nt" else cv2.VideoCapture(CAMERA_INDEX)
    use_camera = cap.isOpened()
    if not use_camera:
        print(f"Could not open camera index {CAMERA_INDEX}, using synthetic demo frame")
    if use_camera:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    os.makedirs(SAVE_DIR, exist_ok=True)

    steady_history = [(322, 300)] * 8
    moving_history = [(322, 300)] * 6 + [(332, 336), (332, 336)]
    short_history = [(322, 300)] * 3

    scenarios = [
        ("STEADY", steady_history, True, True),
        ("MOVING", moving_history, True, False),
        ("SHORT HISTORY", short_history, True, False),
        ("ALIGN FAIL", [], False, False),
    ]
    scenario_idx = 0
    _, center_history, alignment_passed, stability_passed = scenarios[0]
    center_history = list(center_history)
    capture_ready = False
    countdown_start = 0
    countdown_remaining = COUNTDOWN_SECONDS

    print("Face Alignment & Stability Visual Demo")
    print(f"Window size: {PANEL_W*2 + GAP_SCALED + SIDEBAR_W_SCALED}x{PANEL_H*2 + GAP_SCALED + TITLE_H}")
    print("Controls: SPACE = cycle scenarios, a = toggle alignment, t = toggle stability,")
    print("          c = toggle capture state, s = save, q = quit")

    while True:
        if use_camera:
            ok, frame = cap.read()
            if not ok:
                frame = generate_demo_frame()
        else:
            frame = generate_demo_frame()
        frame = cv2.resize(frame, (640, 480))

        if alignment_passed and stability_passed and not capture_ready:
            if countdown_start == 0:
                countdown_start = time.time()
            elapsed = time.time() - countdown_start
            countdown_remaining = max(0, COUNTDOWN_SECONDS - int(elapsed))
            if countdown_remaining == 0:
                capture_ready = True
        elif not (alignment_passed and stability_passed):
            countdown_start = 0
            countdown_remaining = COUNTDOWN_SECONDS
            capture_ready = False

        composite = build_composite(frame, alignment_passed, stability_passed, capture_ready, center_history, countdown_remaining)
        cv2.imshow("Face Alignment & Stability Validation  (SPACE=cycle, a=align, t=steady, c=capture, s=save, q=quit)", composite)

        key = cv2.waitKey(200) & 0xFF
        if key == ord(" "):
            scenario_idx = (scenario_idx + 1) % len(scenarios)
            name, hist, alignment_passed, stability_passed = scenarios[scenario_idx]
            center_history = list(hist)
            capture_ready = False
            countdown_start = 0
            print(f"Scenario: {name}")
        elif key == ord("a"):
            alignment_passed = not alignment_passed
            if not alignment_passed:
                stability_passed = False
                capture_ready = False
                countdown_start = 0
        elif key == ord("t"):
            stability_passed = not stability_passed
            capture_ready = False
            countdown_start = 0
        elif key == ord("c"):
            if alignment_passed and stability_passed:
                capture_ready = not capture_ready
        elif key == ord("s"):
            fname = os.path.join(SAVE_DIR, f"alignment_stability_{int(time.time())}.png")
            cv2.imwrite(fname, composite)
            print(f"Saved -> {fname}")
        elif key == ord("q") or key == 27:
            break

    if use_camera:
        cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
