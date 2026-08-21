"""
hog_svm_visual_demo.py

Interactive visualization of HOG feature extraction + SVM classification.
Shows: gradient computation → cell histograms → block normalization → SVM score

Uses paper example: bbox=[x:220, y:220, w:204, h:208]  SVM_score=1.2354
                    scan_time=78.8ms

Controls: SPACE = new random face/position, s = save, q/ESC = quit
Install:  pip install opencv-python numpy
Run:      python hog_svm_visual_demo.py
"""

import os
import time
import math
import random
import cv2
import numpy as np

CAMERA_INDEX = int(os.getenv("CAMERA_INDEX", "0"))
SAVE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hog_visuals")
FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_BOLD = cv2.FONT_HERSHEY_DUPLEX

# ── Paper example values (hardcoded as requested) ──
PAPER_BBOX = {"x": 220, "y": 220, "w": 204, "h": 208}
PAPER_SCORE = 1.2354
PAPER_SCAN_MS = 78.8

# ── Visualization layout ──
W, H = 1280, 800
PANEL_W, PANEL_H = 400, 360
GAP = 12

# ── HOG parameters (dlib defaults, simplified for visual) ──
CELL_SIZE = 8      # pixels per cell
BIN_COUNT = 9      # gradient orientation bins (0-180°)
BLOCK_SIZE = 2     # cells per block (2x2 = 16x16 pixels)


def label_bar(panel, text, sub_text="", bar_h=48):
    """Draw a label bar at the bottom of a panel with proper spacing."""
    h, w = panel.shape[:2]
    overlay = panel.copy()
    cv2.rectangle(overlay, (0, h - bar_h), (w, h), (18, 18, 25), -1)
    cv2.addWeighted(overlay, 0.75, panel, 0.25, 0, panel)

    # Main text - positioned higher to avoid bottom edge
    cv2.putText(panel, text, (12, h - bar_h + 24), FONT_BOLD, 0.55, (0, 255, 180), 1, cv2.LINE_AA)

    if sub_text:
        # Sub text - positioned with proper padding from bottom
        cv2.putText(panel, sub_text, (12, h - 10), FONT, 0.38, (160, 160, 160), 1, cv2.LINE_AA)
    return panel


def draw_text_bg(panel, text, pos, font_scale=0.5, color=(255, 255, 255), thickness=1, alpha=0.65):
    """Draw text with a background rectangle. Properly handles baseline for correct vertical alignment."""
    (tw, th), baseline = cv2.getTextSize(text, FONT, font_scale, thickness)
    x, y = pos
    pad = 5
    # FIX: Proper baseline calculation - y is the baseline, so text extends from (y - th) to (y + baseline)
    bg = panel.copy()
    top = y - th - pad
    bottom = y + baseline + pad
    left = x - pad
    right = x + tw + pad
    cv2.rectangle(bg, (left, top), (right, bottom), (0, 0, 0), -1)
    cv2.addWeighted(bg, alpha, panel, 1 - alpha, 0, panel)
    cv2.putText(panel, text, (x, y), FONT, font_scale, color, thickness, cv2.LINE_AA)
    return panel


def compute_gradients(gray):
    """Compute Sobel gradients (magnitude + direction)."""
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.sqrt(gx**2 + gy**2)
    ang = np.arctan2(gy, gx) * 180 / math.pi
    ang[ang < 0] += 180  # Map to 0-180° (unsigned gradients)
    return gx, gy, mag, ang


def visualize_gradients(mag, ang, size=(200, 200)):
    """Create a colorful gradient direction visualization."""
    vis = np.zeros((mag.shape[0], mag.shape[1], 3), dtype=np.uint8)
    # Hue = orientation, Value = magnitude
    mag_norm = np.clip(mag / (mag.max() + 1e-6) * 255, 0, 255).astype(np.uint8)
    ang_norm = (ang / 180.0 * 179).astype(np.uint8)  # 0-179 for hue
    hsv = np.zeros((mag.shape[0], mag.shape[1], 3), dtype=np.uint8)
    hsv[:, :, 0] = ang_norm
    hsv[:, :, 1] = 255
    hsv[:, :, 2] = mag_norm
    vis = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
    return cv2.resize(vis, size, interpolation=cv2.INTER_NEAREST)


def draw_hog_cell_arrows(panel, cell_x, cell_y, cell_w, cell_h, histogram, color=(0, 255, 255)):
    """Draw oriented gradient arrows inside a cell based on histogram bins."""
    cx = cell_x + cell_w // 2
    cy = cell_y + cell_h // 2
    max_bin = np.argmax(histogram)
    max_val = histogram[max_bin]

    for i, val in enumerate(histogram):
        if val < 0.1:
            continue
        angle = i * 20 + 10  # Center of bin (0,20,40...160 → 10,30,50...170)
        rad = math.radians(angle)
        length = int(min(cell_w, cell_h) * 0.35 * (val / (max_val + 1e-6)))
        dx = int(length * math.cos(rad))
        dy = int(length * math.sin(rad))

        brightness = 0.4 + 0.6 * (val / (max_val + 1e-6))
        line_color = tuple(int(c * brightness) for c in color)
        cv2.line(panel, (cx - dx, cy + dy), (cx + dx, cy - dy), line_color, 1, cv2.LINE_AA)

    # Highlight dominant direction
    angle = max_bin * 20 + 10
    rad = math.radians(angle)
    length = int(min(cell_w, cell_h) * 0.45)
    dx = int(length * math.cos(rad))
    dy = int(length * math.sin(rad))
    cv2.line(panel, (cx - dx, cy + dy), (cx + dx, cy - dy), (0, 255, 100), 2, cv2.LINE_AA)

    return panel


def build_hog_cells_visual(cropped_gray, cell_size=CELL_SIZE):
    """Build a visual grid showing HOG cells with orientation arrows."""
    h, w = cropped_gray.shape
    ch, cw = h // cell_size, w // cell_size

    # Resize for display
    display_w, display_h = 320, 320
    panel = np.full((display_h, display_w, 3), 30, dtype=np.uint8)

    cell_disp_w = display_w // cw
    cell_disp_h = display_h // ch

    gx, gy, mag, ang = compute_gradients(cropped_gray)

    # Draw cell grid with arrows
    for cy in range(ch):
        for cx in range(cw):
            y0, y1 = cy * cell_size, (cy + 1) * cell_size
            x0, x1 = cx * cell_size, (cx + 1) * cell_size

            cell_ang = ang[y0:y1, x0:x1]
            cell_mag = mag[y0:y1, x0:x1]

            # Build histogram
            hist = np.zeros(BIN_COUNT)
            for i in range(BIN_COUNT):
                bin_start = i * 20
                bin_end = (i + 1) * 20
                mask = (cell_ang >= bin_start) & (cell_ang < bin_end)
                hist[i] = np.sum(cell_mag[mask])

            # Normalize
            hist_sum = hist.sum() + 1e-6
            hist = hist / hist_sum

            # Draw cell background
            dx0, dy0 = cx * cell_disp_w, cy * cell_disp_h
            dx1, dy1 = dx0 + cell_disp_w, dy0 + cell_disp_h
            intensity = int(40 + 60 * (hist.max()))
            cv2.rectangle(panel, (dx0, dy0), (dx1, dy1), (intensity, intensity, intensity + 20), -1)
            cv2.rectangle(panel, (dx0, dy0), (dx1, dy1), (80, 80, 80), 1)

            # Draw arrows
            draw_hog_cell_arrows(panel, dx0, dy0, cell_disp_w, cell_disp_h, hist)

    return panel, mag, ang


def build_svm_panel(score, scan_ms, bbox, detected=True):
    """Build the SVM classification result panel with FIXED text alignment.

    Args:
        score: SVM score (positive = face, negative = no face)
        scan_ms: scan time in milliseconds
        bbox: bounding box dict with x, y, w, h
        detected: whether a face was detected

    VERTICAL LAYOUT (Panel height = 360px):
    - Title area:       y: 0-55    (STEP 3: SVM CLASSIFIER + subtitle)
    - Score bar area:   y: 65-155  (bar + SVM_score text + status text)
    - Result box:       y: 165-255 (CLASSIFICATION RESULT + bbox info, or NO FACE)
    - scan_time label:  y: 265-305 (scan_time=78.8ms)
    - Label bar:        y: 312-360 (STEP 3: SVM CLASSIFICATION)
    """
    panel = np.full((PANEL_H, PANEL_W, 3), 25, dtype=np.uint8)
    h, w = panel.shape[:2]

    # ── Colors based on detection state ──
    if detected and score > 0:
        bar_color = (0, 255, 100)      # Green for face detected
        score_color = (0, 255, 100)
        status_color = (180, 255, 180)
        status_text = "> 0 = FACE DETECTED"
        result_title = "CLASSIFICATION RESULT"
        result_title_color = (0, 255, 0)
        result_text_color = (200, 255, 200)
        result_border = (0, 80, 0)
        result_bg = (20, 40, 20)
    else:
        bar_color = (0, 0, 255)        # Red for no face
        score_color = (100, 100, 255)
        status_color = (180, 180, 255)
        status_text = "< 0 = NO FACE DETECTED"
        result_title = "NO FACE IN FRAME"
        result_title_color = (255, 100, 100)
        result_text_color = (200, 200, 200)
        result_border = (80, 0, 0)
        result_bg = (40, 20, 20)

    # ── Title area (y: 0-55) ──
    cv2.putText(panel, "STEP 3: SVM CLASSIFIER", (15, 30), FONT_BOLD, 0.6, (0, 200, 255), 1, cv2.LINE_AA)
    cv2.putText(panel, "Linear SVM evaluates HOG descriptor", (15, 52), FONT, 0.4, (150, 150, 150), 1, cv2.LINE_AA)

    # ── Score bar area (y: 65-155) ──
    # Decision boundary line (0 threshold)
    center_y = 145
    cv2.line(panel, (40, center_y), (w - 40, center_y), (60, 60, 60), 2)
    cv2.putText(panel, "0 (threshold)", (w - 130, center_y - 8), FONT, 0.4, (120, 120, 120), 1, cv2.LINE_AA)

    # Score bar
    bar_x = 55
    bar_w = 22

    if detected and score > 0:
        # Face detected: bar goes UP from threshold
        bar_height = int(min(score * 60, 80))  # Cap at 80px
        score_y = center_y - bar_height
        score_y = max(70, score_y)  # Keep below title area (y: 55)
        cv2.rectangle(panel, (bar_x, score_y), (bar_x + bar_w, center_y), bar_color, -1)
        cv2.rectangle(panel, (bar_x - 2, score_y - 2), (bar_x + bar_w + 2, center_y + 2), (255, 255, 255), 1)
    else:
        # No face: bar goes DOWN from threshold (red)
        no_face_score = score if score < 0 else -0.5  # Use negative score or default
        bar_height = int(min(abs(no_face_score) * 40, 60))  # Cap at 60px
        bar_bottom = center_y + bar_height
        bar_bottom = min(155, bar_bottom)  # Keep above result box area
        cv2.rectangle(panel, (bar_x, center_y), (bar_x + bar_w, bar_bottom), bar_color, -1)
        cv2.rectangle(panel, (bar_x - 2, center_y - 2), (bar_x + bar_w + 2, bar_bottom + 2), (255, 255, 255), 1)
        score_y = center_y  # Text starts at threshold line for no-face

    # Score text - positioned to the right of the bar
    text_x = bar_x + bar_w + 15
    text_y = max(75, score_y + 15)  # Force below title area
    draw_text_bg(panel, f"SVM_score = {score:.4f}", (text_x, text_y), 0.55, score_color, 2)

    # Status text below score
    draw_text_bg(panel, status_text, (text_x, text_y + 32), 0.45, status_color, 1)

    # ── Result box (y: 165-255) ──
    result_y = 165
    result_h = 90
    result_bottom = result_y + result_h  # 255

    cv2.rectangle(panel, (25, result_y), (w - 25, result_bottom), result_border, 2)
    cv2.rectangle(panel, (27, result_y + 2), (w - 27, result_bottom - 2), result_bg, -1)

    cv2.putText(panel, result_title, (40, result_y + 22), FONT_BOLD, 0.5, result_title_color, 1, cv2.LINE_AA)

    if detected and score > 0:
        # Show bbox info
        cv2.putText(panel, f"bbox=[x:{bbox['x']}, y:{bbox['y']},", (40, result_y + 48), FONT, 0.42, result_text_color, 1, cv2.LINE_AA)
        cv2.putText(panel, f"     w:{bbox['w']}, h:{bbox['h']} ]", (40, result_y + 74), FONT, 0.42, result_text_color, 1, cv2.LINE_AA)
    else:
        # Show "no face" info
        cv2.putText(panel, "No bounding box available", (40, result_y + 48), FONT, 0.42, result_text_color, 1, cv2.LINE_AA)
        cv2.putText(panel, f"scan_time={scan_ms:.1f}ms", (40, result_y + 74), FONT, 0.42, result_text_color, 1, cv2.LINE_AA)

    # ── scan_time label (y: 265-305) ──
    scan_time_y = 285
    draw_text_bg(panel, f"scan_time={scan_ms:.1f}ms", (w - 175, scan_time_y), 0.5, (255, 200, 0), 1)

    # ── Bottom label bar (y: 312-360) ──
    label_bar(panel, "STEP 3: SVM CLASSIFICATION",
              f"score={score:.4f}  |  scan_time={scan_ms:.1f}ms")
    return panel


def build_composite(frame, use_paper_values=True, no_face_mode=False):
    """Build the full 3-panel HOG+SVM visualization with FIXED alignments.

    Args:
        frame: input BGR frame
        use_paper_values: whether to use paper example values
        no_face_mode: if True, simulate "no face detected" state
    """

    # Extract face region (use paper bbox or detect)
    if no_face_mode:
        # No face detected state
        bx, by, bw, bh = 0, 0, 0, 0
        score = -0.8234  # Negative score = no face
        scan_ms = 20.0
        detected = False
    elif use_paper_values:
        bx, by, bw, bh = PAPER_BBOX["x"], PAPER_BBOX["y"], PAPER_BBOX["w"], PAPER_BBOX["h"]
        score = PAPER_SCORE
        scan_ms = PAPER_SCAN_MS
        detected = True
    else:
        # Simulate variation
        bx = PAPER_BBOX["x"] + random.randint(-30, 30)
        by = PAPER_BBOX["y"] + random.randint(-30, 30)
        bw = PAPER_BBOX["w"] + random.randint(-20, 20)
        bh = PAPER_BBOX["h"] + random.randint(-20, 20)
        score = round(random.uniform(0.8, 1.8), 4)
        scan_ms = round(random.uniform(40, 90), 1)
        detected = True

    # Ensure bounds
    h, w = frame.shape[:2]
    if detected:
        bx = max(0, min(bx, w - bw))
        by = max(0, min(by, h - bh))

    # ── Panel 1: INPUT FRAME with bbox ──
    panel_input = cv2.resize(frame, (PANEL_W, PANEL_H))

    if detected:
        # Scale bbox to panel
        scale_x = PANEL_W / w
        scale_y = PANEL_H / h
        px, py = int(bx * scale_x), int(by * scale_y)
        pw, ph = int(bw * scale_x), int(bh * scale_y)
        cv2.rectangle(panel_input, (px, py), (px + pw, py + ph), (0, 255, 0), 2)
        draw_text_bg(panel_input, f"Input: {w}x{h}px", (10, 25), 0.45, (200, 200, 200), 1)
        draw_text_bg(panel_input, f"Face ROI: [{bx},{by},{bw},{bh}]", (10, 48), 0.42, (0, 255, 100), 1)
    else:
        # No face: show message on input panel
        draw_text_bg(panel_input, f"Input: {w}x{h}px", (10, 25), 0.45, (200, 200, 200), 1)
        draw_text_bg(panel_input, "NO FACE DETECTED", (10, 48), 0.45, (0, 0, 255), 1)

    label_bar(panel_input, "STEP 1: INPUT FRAME", "640x480 BGR -> crop face region")

    # ── Panel 2: HOG GRADIENTS ──
    panel_hog = np.full((PANEL_H, PANEL_W, 3), 25, dtype=np.uint8)

    if detected:
        # Crop face region and convert to grayscale
        face_crop = frame[by:by+bh, bx:bx+bw]
        face_gray = cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)
        face_gray_small = cv2.resize(face_gray, (128, 128))

        gx, gy, mag, ang = compute_gradients(face_gray_small)
        grad_vis = visualize_gradients(mag, ang, size=(280, 280))

        # Place gradient visualization
        y_off = (PANEL_H - 280) // 2 - 10
        x_off = (PANEL_W - 280) // 2
        panel_hog[y_off:y_off+280, x_off:x_off+280] = grad_vis

        # Draw cell grid overlay
        cell_vis, _, _ = build_hog_cells_visual(face_gray_small, cell_size=16)
        cell_vis = cv2.resize(cell_vis, (200, 200), interpolation=cv2.INTER_NEAREST)
        cell_x_start = PANEL_W - 210
        cell_y_start = 15
        panel_hog[cell_y_start:cell_y_start+200, cell_x_start:cell_x_start+200] = cell_vis
        cv2.rectangle(panel_hog, (cell_x_start - 1, cell_y_start - 1), 
                      (cell_x_start + 201, cell_y_start + 201), (100, 100, 100), 1)

        cv2.putText(panel_hog, "HOG Cells", (PANEL_W - 205, cell_y_start + 220), FONT, 0.4, (180, 180, 180), 1, cv2.LINE_AA)
        cv2.putText(panel_hog, "(8x8 gradient bins)", (PANEL_W - 205, cell_y_start + 240), FONT, 0.35, (120, 120, 120), 1, cv2.LINE_AA)

        draw_text_bg(panel_hog, "Hue = orientation", (15, PANEL_H - 70), 0.42, (200, 200, 255), 1)
        draw_text_bg(panel_hog, "Brightness = magnitude", (15, PANEL_H - 48), 0.42, (200, 200, 255), 1)
    else:
        # No face: show placeholder
        cv2.putText(panel_hog, "NO FACE REGION", (PANEL_W//2 - 90, PANEL_H//2 - 20), FONT_BOLD, 0.6, (100, 100, 100), 1, cv2.LINE_AA)
        cv2.putText(panel_hog, "HOG features not computed", (PANEL_W//2 - 130, PANEL_H//2 + 20), FONT, 0.45, (100, 100, 100), 1, cv2.LINE_AA)
        cv2.putText(panel_hog, "(no region of interest)", (PANEL_W//2 - 110, PANEL_H//2 + 45), FONT, 0.4, (80, 80, 80), 1, cv2.LINE_AA)

    label_bar(panel_hog, "STEP 2: HOG FEATURES",
              "Sobel gradients -> 9-bin orientation histograms")

    # ── Panel 3: SVM RESULT ──
    if detected:
        panel_svm = build_svm_panel(score, scan_ms, {"x": bx, "y": by, "w": bw, "h": bh}, detected=True)
    else:
        panel_svm = build_svm_panel(score, scan_ms, {"x": 0, "y": 0, "w": 0, "h": 0}, detected=False)

    # ── Assemble ──
    gap_v = np.full((PANEL_H, GAP, 3), 35, dtype=np.uint8)
    row = np.hstack([panel_input, gap_v, panel_hog, gap_v, panel_svm])

    # Title bar
    title_h = 45
    title_bar = np.full((title_h, row.shape[1], 3), (15, 15, 22), dtype=np.uint8)
    title = "HOG + SVM Face Detection Pipeline"
    ts = cv2.getTextSize(title, FONT_BOLD, 0.75, 2)[0]
    cv2.putText(title_bar, title, ((row.shape[1] - ts[0]) // 2, 32), FONT_BOLD, 0.75, (220, 220, 220), 2, cv2.LINE_AA)

    # Log bar at bottom
    log_h = 50
    log_bar = np.full((log_h, row.shape[1], 3), (10, 10, 15), dtype=np.uint8)
    if detected:
        log_text = f"[HOG+SVM] scan#00000  face#1  bbox=[x:{bx}, y:{by}, w:{bw}, h:{bh}]  SVM_score={score:.4f}  (>0 = face)  scan_time={scan_ms:.1f}ms"
    else:
        log_text = f"[HOG+SVM] scan#00147  no face in frame  scan_time={scan_ms:.1f}ms"
    cv2.putText(log_bar, log_text, (20, 32), FONT, 0.45, (0, 255, 180), 1, cv2.LINE_AA)

    composite = np.vstack([title_bar, row, log_bar])

    # Side info panel
    info_w = 280
    info_panel = np.full((composite.shape[0], info_w, 3), (20, 20, 25), dtype=np.uint8)

    # Draw info text
    y = 60
    cv2.putText(info_panel, "HOW HOG+SVM WORKS", (15, y), FONT_BOLD, 0.55, (0, 200, 255), 1, cv2.LINE_AA)
    y += 35

    explanations = [
        ("1. GRADIENTS", "Sobel filters compute edge", "direction & strength per pixel"),
        ("2. CELLS", "Image divided into 8x8 cells", "Each cell -> 9-bin histogram"),
        ("3. BLOCKS", "2x2 cells normalized", "for lighting invariance"),
        ("4. DESCRIPTOR", "Concatenated histograms", "form face fingerprint"),
        ("5. SVM SCORE", "Linear classifier outputs", "confidence (>0 = face)"),
    ]

    for title_text, line1, line2 in explanations:
        cv2.putText(info_panel, title_text, (15, y), FONT_BOLD, 0.48, (255, 200, 100), 1, cv2.LINE_AA)
        y += 22
        cv2.putText(info_panel, line1, (25, y), FONT, 0.38, (180, 180, 180), 1, cv2.LINE_AA)
        y += 18
        cv2.putText(info_panel, line2, (25, y), FONT, 0.38, (180, 180, 180), 1, cv2.LINE_AA)
        y += 30

    # Highlight current step
    y += 20
    cv2.putText(info_panel, "Dalal & Triggs (2005)", (15, y), FONT, 0.4, (120, 120, 160), 1, cv2.LINE_AA)
    y += 20
    cv2.putText(info_panel, "dlib HOG detector", (15, y), FONT, 0.4, (120, 120, 160), 1, cv2.LINE_AA)

    # Paper reference box
    y = info_panel.shape[0] - 120
    cv2.rectangle(info_panel, (10, y), (info_w - 10, y + 100), (40, 40, 50), 1)
    cv2.putText(info_panel, "PAPER VALUES", (20, y + 22), FONT_BOLD, 0.5, (0, 255, 180), 1, cv2.LINE_AA)
    cv2.putText(info_panel, f"bbox=[{PAPER_BBOX['x']},{PAPER_BBOX['y']},", (20, y + 45), FONT, 0.4, (200, 255, 200), 1, cv2.LINE_AA)
    cv2.putText(info_panel, f"      {PAPER_BBOX['w']},{PAPER_BBOX['h']} ]", (20, y + 65), FONT, 0.4, (200, 255, 200), 1, cv2.LINE_AA)
    cv2.putText(info_panel, f"score={PAPER_SCORE}", (20, y + 85), FONT, 0.4, (200, 255, 200), 1, cv2.LINE_AA)

    return np.hstack([composite, info_panel])


def main():
    cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW) if os.name == "nt" else cv2.VideoCapture(CAMERA_INDEX)
    if not cap.isOpened():
        print(f"Could not open camera index {CAMERA_INDEX}")
        return

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    os.makedirs(SAVE_DIR, exist_ok=True)

    use_paper = True
    no_face = False
    print("HOG+SVM Visual Demo")
    print("Controls: SPACE = toggle paper/random values, n = toggle no-face mode, s = save, q = quit")

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame = cv2.resize(frame, (640, 480))

        composite = build_composite(frame, use_paper_values=use_paper, no_face_mode=no_face)
        cv2.imshow("HOG+SVM Face Detection Visual  (SPACE=toggle, n=no-face, s=save, q=quit)", composite)

        key = cv2.waitKey(1) & 0xFF
        if key == ord(" "):
            use_paper = not use_paper
            mode = "PAPER VALUES" if use_paper else "RANDOM VARIATION"
            print(f"Switched to: {mode}")
        elif key == ord("n"):
            no_face = not no_face
            mode = "NO FACE MODE" if no_face else "FACE DETECTION MODE"
            print(f"Switched to: {mode}")
        elif key == ord("s"):
            fname = os.path.join(SAVE_DIR, f"hog_svm_{int(time.time())}.png")
            cv2.imwrite(fname, composite)
            print(f"Saved -> {fname}")
        elif key == ord("q") or key == 27:
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()