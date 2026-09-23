"""
Anti-Spoofing Evaluation Script (MiniFASNetV2 + MiniFASNetV1SE)
==================================================================
Standalone evaluation -- does NOT import flask_attendance.py, does NOT
touch Supabase, camera, or Flask. Reuses only src/anti_spoof_predict.py,
src/generate_patches.py, src/utility.py -- the same modules your
production engine uses -- to reproduce the exact same inference method.

Usage:
    python eval_liveness.py ^
        --eval-dir "D:\\DATASETS\\eval_subset" ^
        --src-dir "D:\\...\\src" ^
        --model-dir "D:\\...\\models" ^
        --out "D:\\DATASETS\\liveness_eval_results"

Expects --eval-dir to contain:
    real/           (live face images)
    spoof_print/    (print-attack images)
    spoof_phone/    (phone/replay-attack images)

Requires: torch, opencv-python, face_recognition, scikit-learn,
matplotlib, pandas, numpy
    pip install scikit-learn matplotlib pandas numpy --break-system-packages
"""

import os
import sys
import argparse
import time
import numpy as np
import pandas as pd
import cv2
import matplotlib.pyplot as plt
from sklearn.metrics import (
    confusion_matrix, classification_report, balanced_accuracy_score,
    ConfusionMatrixDisplay,
)

IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp"}
THRESHOLD_SWEEP = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70]
PRODUCTION_THRESHOLD = 0.5


def load_silent_face_modules(src_dir):
    """Import AntiSpoofPredict, CropImage, parse_model_name from the user's
    actual src/ folder -- reproducing production logic exactly."""
    src_dir = os.path.abspath(src_dir)
    parent_dir = os.path.dirname(src_dir)
    for p in (parent_dir, src_dir):
        if p not in sys.path:
            sys.path.insert(0, p)
    try:
        from src.anti_spoof_predict import AntiSpoofPredict
        from src.generate_patches import CropImage
        from src.utility import parse_model_name
    except Exception:
        from anti_spoof_predict import AntiSpoofPredict
        from generate_patches import CropImage
        from utility import parse_model_name
    return AntiSpoofPredict, CropImage, parse_model_name


def init_models(src_dir, model_dir, model_files, device_id=0):
    import torch
    AntiSpoofPredict, CropImage, parse_model_name = load_silent_face_modules(src_dir)

    model_paths = []
    for fname in model_files:
        p = os.path.join(model_dir, fname)
        if not os.path.exists(p):
            raise FileNotFoundError(f"Model file not found: {p}")
        model_paths.append(p)

    try:
        predictor = AntiSpoofPredict(device_id)
    except Exception:
        predictor = object.__new__(AntiSpoofPredict)
        predictor.device = torch.device(f"cuda:{device_id}" if torch.cuda.is_available() else "cpu")

    cropper = CropImage()
    print(f"✓ Loaded {len(model_paths)} model(s) on device={getattr(predictor, 'device', 'cpu')}")
    return predictor, cropper, model_paths, parse_model_name


def detect_face_bbox(img_bgr):
    """Same HOG detector used in production (face_recognition.face_locations)."""
    import face_recognition
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    locs = face_recognition.face_locations(rgb, model="hog")
    if not locs:
        return None
    # Use the largest detected face if multiple are found
    def area(loc):
        top, right, bottom, left = loc
        return (bottom - top) * (right - left)
    top, right, bottom, left = max(locs, key=area)
    return (top, right, bottom, left)


def run_models_on_image(img_bgr, bbox, predictor, cropper, model_paths, parse_model_name):
    """Reproduces _run_anti_spoof_diagnostic logic: per-model scores + combined average."""
    top, right, bottom, left = bbox
    x, y = max(0, int(left)), max(0, int(top))
    w, h = max(1, int(right - left)), max(1, int(bottom - top))
    image_bbox = [x, y, w, h]

    per_model_scores = {}
    prediction_sum = np.zeros((1, 3), dtype=np.float32)

    for model_path in model_paths:
        model_name = os.path.basename(model_path)
        h_input, w_input, _model_type, scale = parse_model_name(model_name)
        param = {
            "org_img": img_bgr, "bbox": image_bbox, "scale": scale,
            "out_w": w_input, "out_h": h_input, "crop": True,
        }
        patch = cropper.crop(**param)
        pred = predictor.predict(patch, model_path)
        live_score = float(pred[0][1])
        per_model_scores[model_name] = live_score
        prediction_sum += pred

    combined_score = float(prediction_sum[0][1] / len(model_paths))
    return combined_score, per_model_scores


def walk_eval_dir(eval_dir):
    """Returns list of (filepath, true_label, attack_type)."""
    mapping = {
        "real": ("real", "real"),
        "spoof_print": ("spoof", "print"),
        "spoof_phone": ("spoof", "phone"),
    }
    items = []
    for folder_name, (label, attack_type) in mapping.items():
        folder = os.path.join(eval_dir, folder_name)
        if not os.path.isdir(folder):
            print(f"⚠ WARNING: expected folder not found: {folder}")
            continue
        for fname in os.listdir(folder):
            if os.path.splitext(fname)[1].lower() in IMG_EXTS:
                items.append((os.path.join(folder, fname), label, attack_type))
    return items


def compute_far_frr(y_true, y_pred):
    """y_true/y_pred: 1=Live, 0=Spoof"""
    y_true = np.array(y_true)
    y_pred = np.array(y_pred)
    spoof_mask = y_true == 0
    live_mask = y_true == 1
    far = np.mean(y_pred[spoof_mask] == 1) if spoof_mask.sum() > 0 else float("nan")
    frr = np.mean(y_pred[live_mask] == 0) if live_mask.sum() > 0 else float("nan")
    return far, frr


def evaluate_subset(df, threshold, label_filter=None):
    """label_filter: None (all), 'print', or 'phone' -- filters spoof rows by attack_type,
    always keeping all 'real' rows."""
    if label_filter:
        sub = df[(df["attack_type"] == "real") | (df["attack_type"] == label_filter)].copy()
    else:
        sub = df.copy()
    y_true = (sub["true_label"] == "real").astype(int).values
    y_pred = (sub["combined_score"] >= threshold).astype(int).values
    far, frr = compute_far_frr(y_true, y_pred)
    acc = np.mean(y_true == y_pred)
    bal_acc = balanced_accuracy_score(y_true, y_pred) if len(set(y_true)) > 1 else float("nan")
    recall_live = np.mean(y_pred[y_true == 1] == 1) if (y_true == 1).sum() > 0 else float("nan")
    recall_spoof = np.mean(y_pred[y_true == 0] == 0) if (y_true == 0).sum() > 0 else float("nan")
    return {
        "accuracy": acc, "balanced_accuracy": bal_acc,
        "FAR": far, "FRR": frr,
        "recall_live": recall_live, "recall_spoof": recall_spoof,
        "n": len(sub),
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate MiniFASNetV2 + MiniFASNetV1SE on labeled dataset")
    parser.add_argument("--eval-dir", required=True, help="Path to eval_subset folder (real/, spoof_print/, spoof_phone/)")
    parser.add_argument("--src-dir", required=True, help="Path to your project's src/ folder")
    parser.add_argument("--model-dir", required=True, help="Path to your project's models/ folder")
    parser.add_argument("--model-files", default="2.7_80x80_MiniFASNetV2.pth,4_0_0_80x80_MiniFASNetV1SE.pth",
                         help="Comma-separated model filenames")
    parser.add_argument("--device", type=int, default=0, help="Device ID (0 for cuda:0 if available, else cpu)")
    parser.add_argument("--out", default="./liveness_eval_results", help="Output folder for results")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    model_files = [f.strip() for f in args.model_files.split(",") if f.strip()]

    print("=" * 60)
    print("Anti-Spoofing Evaluation: MiniFASNetV2 + MiniFASNetV1SE")
    print("=" * 60)

    predictor, cropper, model_paths, parse_model_name = init_models(
        args.src_dir, args.model_dir, model_files, args.device
    )
    model_names = [os.path.basename(p) for p in model_paths]

    items = walk_eval_dir(args.eval_dir)
    print(f"Found {len(items)} images to evaluate.\n")

    rows = []
    undetected = 0
    t0 = time.time()

    for i, (fpath, true_label, attack_type) in enumerate(items):
        img = cv2.imread(fpath)
        if img is None:
            print(f"  ⚠ Could not read image: {fpath}")
            continue

        bbox = detect_face_bbox(img)
        if bbox is None:
            undetected += 1
            rows.append({
                "image_filename": os.path.basename(fpath),
                "true_label": true_label,
                "attack_type": attack_type,
                "combined_score": None,
                **{f"score_{name}": None for name in model_names},
                "face_detected": False,
            })
            continue

        combined_score, per_model_scores = run_models_on_image(
            img, bbox, predictor, cropper, model_paths, parse_model_name
        )
        row = {
            "image_filename": os.path.basename(fpath),
            "true_label": true_label,
            "attack_type": attack_type,
            "combined_score": combined_score,
            "face_detected": True,
        }
        for name in model_names:
            row[f"score_{name}"] = per_model_scores.get(name)
        rows.append(row)

        if (i + 1) % 50 == 0:
            elapsed = time.time() - t0
            print(f"  Processed {i+1}/{len(items)} images... ({elapsed:.1f}s elapsed)")

    df = pd.DataFrame(rows)
    detected_df = df[df["face_detected"] == True].copy()
    print(f"\n✓ Finished. {len(detected_df)} images successfully processed, "
          f"{undetected} images had no detectable face (excluded from metrics).\n")

    # ── Apply production threshold for the saved results file ──
    detected_df["predicted_label"] = np.where(
        detected_df["combined_score"] >= PRODUCTION_THRESHOLD, "real", "spoof"
    )
    detected_df["threshold_used"] = PRODUCTION_THRESHOLD
    detected_df["result"] = np.where(
        detected_df["predicted_label"] == detected_df["true_label"], "correct", "incorrect"
    )
    detected_df.to_csv(os.path.join(args.out, "liveness_results.csv"), index=False)
    print(f"✓ Saved liveness_results.csv ({len(detected_df)} rows)")

    # ── Overall binary metrics @ production threshold ──
    y_true_overall = (detected_df["true_label"] == "real").astype(int).values
    y_pred_overall = (detected_df["combined_score"] >= PRODUCTION_THRESHOLD).astype(int).values

    cm_overall = confusion_matrix(y_true_overall, y_pred_overall, labels=[0, 1])
    pd.DataFrame(cm_overall, index=["Actual Spoof", "Actual Live"],
                 columns=["Pred Spoof", "Pred Live"]).to_csv(
        os.path.join(args.out, "confusion_matrix_overall.csv"))
    disp = ConfusionMatrixDisplay(cm_overall, display_labels=["Spoof", "Live"])
    disp.plot(cmap="Blues")
    plt.title(f"Overall Confusion Matrix (threshold={PRODUCTION_THRESHOLD})")
    plt.savefig(os.path.join(args.out, "confusion_matrix_overall.png"), dpi=150, bbox_inches="tight")
    plt.close()

    report_txt = classification_report(y_true_overall, y_pred_overall, target_names=["Spoof", "Live"])
    with open(os.path.join(args.out, "classification_report_overall.txt"), "w") as f:
        f.write(report_txt)
    print("\n=== Overall Classification Report (production threshold=0.5) ===")
    print(report_txt)

    # ── Per-attack-type confusion matrices ──
    for attack_name in ["print", "phone"]:
        sub = detected_df[(detected_df["attack_type"] == "real") | (detected_df["attack_type"] == attack_name)]
        y_t = (sub["true_label"] == "real").astype(int).values
        y_p = (sub["combined_score"] >= PRODUCTION_THRESHOLD).astype(int).values
        cm = confusion_matrix(y_t, y_p, labels=[0, 1])
        pd.DataFrame(cm, index=["Actual Spoof", "Actual Live"],
                     columns=["Pred Spoof", "Pred Live"]).to_csv(
            os.path.join(args.out, f"confusion_matrix_{attack_name}.csv"))
        disp = ConfusionMatrixDisplay(cm, display_labels=["Spoof", "Live"])
        disp.plot(cmap="Oranges" if attack_name == "print" else "Greens")
        plt.title(f"Real vs {attack_name.capitalize()}-Attack Confusion Matrix")
        plt.savefig(os.path.join(args.out, f"confusion_matrix_{attack_name}.png"), dpi=150, bbox_inches="tight")
        plt.close()

    # ── Threshold sweep ──
    threshold_rows = []
    for th in THRESHOLD_SWEEP:
        overall = evaluate_subset(detected_df, th, None)
        print_m = evaluate_subset(detected_df, th, "print")
        phone_m = evaluate_subset(detected_df, th, "phone")
        threshold_rows.append({
            "threshold": th,
            "accuracy": overall["accuracy"],
            "balanced_accuracy": overall["balanced_accuracy"],
            "FAR_overall": overall["FAR"],
            "FRR_overall": overall["FRR"],
            "FAR_print": print_m["FAR"],
            "FAR_phone": phone_m["FAR"],
            "recall_live": overall["recall_live"],
            "recall_spoof": overall["recall_spoof"],
        })
    threshold_df = pd.DataFrame(threshold_rows)
    threshold_df.to_csv(os.path.join(args.out, "threshold_results.csv"), index=False)
    print("\n=== Threshold Sweep Results ===")
    print(threshold_df.to_string(index=False))

    # ── Threshold performance plot ──
    plt.figure(figsize=(8, 5))
    plt.plot(threshold_df["threshold"], threshold_df["FAR_overall"], label="FAR (overall)", marker="o")
    plt.plot(threshold_df["threshold"], threshold_df["FRR_overall"], label="FRR (overall)", marker="o")
    plt.plot(threshold_df["threshold"], threshold_df["FAR_print"], label="FAR (print only)", linestyle="--")
    plt.plot(threshold_df["threshold"], threshold_df["FAR_phone"], label="FAR (phone only)", linestyle="--")
    plt.axvline(PRODUCTION_THRESHOLD, color="gray", linestyle=":", label=f"Production threshold ({PRODUCTION_THRESHOLD})")
    plt.xlabel("Threshold")
    plt.ylabel("Error Rate")
    plt.title("Threshold Performance: FAR / FRR across thresholds")
    plt.legend()
    plt.savefig(os.path.join(args.out, "threshold_performance.png"), dpi=150, bbox_inches="tight")
    plt.close()

    # ── Score distribution plot ──
    plt.figure(figsize=(8, 5))
    for label, name, color in [("real", "Live", "green"), ("print", "Print Attack", "orange"), ("phone", "Phone Attack", "red")]:
        scores = detected_df[detected_df["attack_type"] == label]["combined_score"]
        plt.hist(scores, bins=30, alpha=0.5, label=name, color=color)
    plt.axvline(PRODUCTION_THRESHOLD, color="black", linestyle="--", label=f"Threshold ({PRODUCTION_THRESHOLD})")
    plt.xlabel("Combined Live Score")
    plt.ylabel("Count")
    plt.title("Score Distribution: Live vs Print vs Phone Attacks")
    plt.legend()
    plt.savefig(os.path.join(args.out, "score_distribution.png"), dpi=150, bbox_inches="tight")
    plt.close()

    # ── Per-model individual evaluation (V2 alone vs V1SE alone) ──
    print("\n=== Per-Model Individual Performance (threshold=0.5) ===")
    per_model_summary = []
    for name in model_names:
        col = f"score_{name}"
        if col not in detected_df.columns:
            continue
        y_t = (detected_df["true_label"] == "real").astype(int).values
        y_p = (detected_df[col] >= PRODUCTION_THRESHOLD).astype(int).values
        acc = np.mean(y_t == y_p)
        bal = balanced_accuracy_score(y_t, y_p)
        far, frr = compute_far_frr(y_t, y_p)
        per_model_summary.append({"model": name, "accuracy": acc, "balanced_accuracy": bal, "FAR": far, "FRR": frr})
        print(f"  {name}: acc={acc:.4f} bal_acc={bal:.4f} FAR={far:.4f} FRR={frr:.4f}")
    pd.DataFrame(per_model_summary).to_csv(os.path.join(args.out, "per_model_comparison.csv"), index=False)

    print("\n" + "=" * 60)
    print(f"All results saved to: {os.path.abspath(args.out)}")
    print("=" * 60)


if __name__ == "__main__":
    main()
