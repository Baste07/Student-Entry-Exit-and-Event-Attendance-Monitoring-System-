from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
from dataclasses import dataclass, asdict
from pathlib import Path
from statistics import mean
from typing import Iterable

import cv2
import face_recognition
import numpy as np
from dotenv import load_dotenv
from supabase import Client, create_client


SCRIPT_DIR = Path(__file__).resolve().parent
ENV_PATH = SCRIPT_DIR / ".env"
BUCKET_NAME = "facial_data"
DEFAULT_THRESHOLD = 0.40


@dataclass(frozen=True)
class StudentProbe:
    student_id: str
    sample_image: Path
    label: str = ""


@dataclass
class AttemptResult:
    probe_type: str
    probe_id: str
    target_id: str
    target_label: str
    outcome: str
    best_match_id: str
    best_match_label: str
    best_distance: float | None
    matched: bool
    note: str = ""


def load_supabase_client() -> Client:
    load_dotenv(ENV_PATH, override=True)
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_KEY")

    if not supabase_url or not supabase_key:
        raise RuntimeError(f"Missing SUPABASE_URL or SUPABASE_KEY in {ENV_PATH}")

    return create_client(supabase_url, supabase_key)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Evaluate facial recognition performance using one genuine sample image per enrolled student "
            "and optional impostor comparisons."
        )
    )
    parser.add_argument("--section", default="BSIT-3E", help="Section label for reporting only.")
    parser.add_argument(
        "--threshold",
        type=float,
        default=DEFAULT_THRESHOLD,
        help="Face distance threshold used to decide a match.",
    )
    parser.add_argument(
        "--samples-csv",
        type=Path,
        default=None,
        help=(
            "Optional CSV file with columns: student_id,sample_image_path[,label]. "
            "If omitted, the script looks for sample images inside --samples-dir named by student_id."
        ),
    )
    parser.add_argument(
        "--samples-dir",
        type=Path,
        default=SCRIPT_DIR / "sample_photos",
        help="Directory containing sample images named <student_id>.jpg/.jpeg/.png when --samples-csv is not used.",
    )
    parser.add_argument(
        "--impostor-dir",
        type=Path,
        default=None,
        help=(
            "Optional directory of non-registered impostor photos. When omitted, the script performs "
            "cross-identity impostor comparisons using the enrolled sample set."
        ),
    )
    parser.add_argument(
        "--no-cross-impostor",
        action="store_true",
        help="Disable cross-identity impostor comparisons when no explicit impostor directory is provided.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=SCRIPT_DIR / "evaluation_results",
        help="Directory where detailed CSV/Markdown outputs will be written.",
    )
    return parser.parse_args()


def read_student_probes_from_csv(csv_path: Path) -> list[StudentProbe]:
    probes: list[StudentProbe] = []
    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            student_id = str(row.get("student_id") or "").strip()
            sample_path = str(row.get("sample_image_path") or "").strip()
            label = str(row.get("label") or "").strip()
            if not student_id or not sample_path:
                continue
            probes.append(StudentProbe(student_id=student_id, sample_image=Path(sample_path), label=label))
    return probes


def discover_student_probes(samples_dir: Path, student_ids: Iterable[str]) -> list[StudentProbe]:
    probes: list[StudentProbe] = []
    extensions = (".jpg", ".jpeg", ".png", ".webp")
    for student_id in student_ids:
        found_path: Path | None = None
        for ext in extensions:
            candidate = samples_dir / f"{student_id}{ext}"
            if candidate.exists():
                found_path = candidate
                break
        if found_path is not None:
            probes.append(StudentProbe(student_id=student_id, sample_image=found_path))
    return probes


def read_image_bytes(path: Path) -> bytes:
    return path.read_bytes()


def decode_image(image_bytes: bytes) -> np.ndarray | None:
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return image


def extract_primary_encoding(image_bytes: bytes) -> np.ndarray | None:
    image = decode_image(image_bytes)
    if image is None:
        return None

    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    locations = face_recognition.face_locations(rgb, model="hog")
    if not locations:
        return None

    def area(location: tuple[int, int, int, int]) -> int:
        top, right, bottom, left = location
        return max(0, bottom - top) * max(0, right - left)

    primary_location = max(locations, key=area)
    encodings = face_recognition.face_encodings(rgb, [primary_location], num_jitters=1)
    if not encodings:
        return None
    return encodings[0].astype(np.float32, copy=False)


def list_bucket_images(supabase: Client, folder: str) -> list[dict[str, object]]:
    files = supabase.storage.from_(BUCKET_NAME).list(folder)
    if not files:
        return []
    valid = [
        item
        for item in files
        if str(item.get("name", "")).lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
    ]
    return sorted(valid, key=lambda item: str(item.get("name", "")))


def download_reference_encodings(supabase: Client, folder: str) -> list[np.ndarray]:
    encodings: list[np.ndarray] = []
    for item in list_bucket_images(supabase, folder):
        file_name = str(item.get("name", "")).strip()
        if not file_name:
            continue
        storage_path = f"{folder}/{file_name}"
        image_bytes = supabase.storage.from_(BUCKET_NAME).download(storage_path)
        encoding = extract_primary_encoding(image_bytes)
        if encoding is not None:
            encodings.append(encoding)
    return encodings


def fetch_registered_students(supabase: Client) -> list[dict[str, object]]:
    result = supabase.table("students").select(
        "student_id, id_number, first_name, middle_name, last_name, facial_dataset_path"
    ).execute()
    rows = result.data or []
    valid_rows = []
    for row in rows:
        folder = str(row.get("facial_dataset_path") or "").strip()
        student_id = str(row.get("student_id") or "").strip()
        if folder and student_id:
            valid_rows.append(row)
    return valid_rows


def student_label(row: dict[str, object]) -> str:
    first = str(row.get("first_name") or "").strip()
    middle = str(row.get("middle_name") or "").strip()
    last = str(row.get("last_name") or "").strip()
    label = " ".join(part for part in [first, middle, last] if part)
    return label or str(row.get("id_number") or row.get("student_id") or "Unknown")


def build_reference_index(supabase: Client, student_rows: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    reference_index: dict[str, dict[str, object]] = {}
    for row in student_rows:
        student_id = str(row.get("student_id") or "").strip()
        folder = str(row.get("facial_dataset_path") or "").strip()
        label = student_label(row)
        encodings = download_reference_encodings(supabase, folder)
        reference_index[student_id] = {
            "label": label,
            "folder": folder,
            "encodings": encodings,
        }
    return reference_index


def find_best_match(probe_encoding: np.ndarray, reference_index: dict[str, dict[str, object]], exclude_student_id: str | None = None) -> tuple[str, str, float | None]:
    best_student_id = ""
    best_label = ""
    best_distance: float | None = None

    for student_id, ref in reference_index.items():
        if exclude_student_id and student_id == exclude_student_id:
            continue
        encodings = ref.get("encodings") or []
        if not encodings:
            continue
        enc_array = np.asarray(encodings, dtype=np.float32)
        distances = np.linalg.norm(enc_array - probe_encoding, axis=1)
        distance = float(np.min(distances))
        if best_distance is None or distance < best_distance:
            best_distance = distance
            best_student_id = student_id
            best_label = str(ref.get("label") or student_id)

    return best_student_id, best_label, best_distance


def evaluate_genuine_samples(
    probes: list[StudentProbe],
    reference_index: dict[str, dict[str, object]],
    threshold: float,
) -> list[AttemptResult]:
    results: list[AttemptResult] = []
    for probe in probes:
        ref = reference_index.get(probe.student_id)
        if not ref:
            results.append(
                AttemptResult(
                    probe_type="genuine",
                    probe_id=probe.student_id,
                    target_id=probe.student_id,
                    target_label=probe.label or probe.student_id,
                    outcome="FR",
                    best_match_id="",
                    best_match_label="",
                    best_distance=None,
                    matched=False,
                    note="No registered reference found",
                )
            )
            continue

        sample_bytes = read_image_bytes(probe.sample_image)
        probe_encoding = extract_primary_encoding(sample_bytes)
        if probe_encoding is None:
            results.append(
                AttemptResult(
                    probe_type="genuine",
                    probe_id=probe.student_id,
                    target_id=probe.student_id,
                    target_label=probe.label or str(ref.get("label") or probe.student_id),
                    outcome="FR",
                    best_match_id="",
                    best_match_label="",
                    best_distance=None,
                    matched=False,
                    note="No face detected in sample image",
                )
            )
            continue

        encodings = ref.get("encodings") or []
        if not encodings:
            results.append(
                AttemptResult(
                    probe_type="genuine",
                    probe_id=probe.student_id,
                    target_id=probe.student_id,
                    target_label=probe.label or str(ref.get("label") or probe.student_id),
                    outcome="FR",
                    best_match_id="",
                    best_match_label="",
                    best_distance=None,
                    matched=False,
                    note="No reference encodings available",
                )
            )
            continue

        ref_array = np.asarray(encodings, dtype=np.float32)
        distances = np.linalg.norm(ref_array - probe_encoding, axis=1)
        best_idx = int(np.argmin(distances))
        best_distance = float(distances[best_idx])
        matched = best_distance < threshold
        results.append(
            AttemptResult(
                probe_type="genuine",
                probe_id=probe.student_id,
                target_id=probe.student_id,
                target_label=probe.label or str(ref.get("label") or probe.student_id),
                outcome="TA" if matched else "FR",
                best_match_id=probe.student_id,
                best_match_label=str(ref.get("label") or probe.student_id),
                best_distance=best_distance,
                matched=matched,
            )
        )
    return results


def evaluate_cross_impostors(
    probes: list[StudentProbe],
    reference_index: dict[str, dict[str, object]],
    threshold: float,
) -> list[AttemptResult]:
    results: list[AttemptResult] = []
    for probe in probes:
        sample_bytes = read_image_bytes(probe.sample_image)
        probe_encoding = extract_primary_encoding(sample_bytes)
        if probe_encoding is None:
            continue

        for candidate_student_id, ref in reference_index.items():
            if candidate_student_id == probe.student_id:
                continue
            encodings = ref.get("encodings") or []
            if not encodings:
                continue
            enc_array = np.asarray(encodings, dtype=np.float32)
            distances = np.linalg.norm(enc_array - probe_encoding, axis=1)
            best_distance = float(np.min(distances))
            matched = best_distance < threshold
            results.append(
                AttemptResult(
                    probe_type="impostor_cross",
                    probe_id=probe.student_id,
                    target_id=candidate_student_id,
                    target_label=str(ref.get("label") or candidate_student_id),
                    outcome="FA" if matched else "TR",
                    best_match_id=candidate_student_id,
                    best_match_label=str(ref.get("label") or candidate_student_id),
                    best_distance=best_distance,
                    matched=matched,
                )
            )
    return results


def evaluate_external_impostors(
    impostor_dir: Path,
    reference_index: dict[str, dict[str, object]],
    threshold: float,
) -> list[AttemptResult]:
    results: list[AttemptResult] = []
    if not impostor_dir.exists():
        return results

    image_paths = sorted(
        [
            path
            for path in impostor_dir.iterdir()
            if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        ]
    )

    for path in image_paths:
        probe_encoding = extract_primary_encoding(path.read_bytes())
        if probe_encoding is None:
            continue

        best_student_id, best_label, best_distance = find_best_match(probe_encoding, reference_index)
        matched = best_distance is not None and best_distance < threshold
        results.append(
            AttemptResult(
                probe_type="impostor_external",
                probe_id=path.stem,
                target_id=best_student_id,
                target_label=best_label,
                outcome="FA" if matched else "TR",
                best_match_id=best_student_id,
                best_match_label=best_label,
                best_distance=best_distance,
                matched=matched,
                note=str(path),
            )
        )
    return results


def summarize_results(genuine_results: list[AttemptResult], impostor_results: list[AttemptResult], threshold: float) -> dict[str, object]:
    ta = sum(1 for item in genuine_results if item.outcome == "TA")
    fr = sum(1 for item in genuine_results if item.outcome == "FR")
    fa = sum(1 for item in impostor_results if item.outcome == "FA")
    tr = sum(1 for item in impostor_results if item.outcome == "TR")

    genuine_total = ta + fr
    impostor_total = fa + tr
    overall_total = genuine_total + impostor_total

    recognition_accuracy = ((ta + tr) / overall_total * 100.0) if overall_total else 0.0
    recognition_success_rate = (ta / genuine_total * 100.0) if genuine_total else 0.0
    frr = (fr / genuine_total * 100.0) if genuine_total else 0.0
    far = (fa / impostor_total * 100.0) if impostor_total else 0.0

    genuine_distances = [item.best_distance for item in genuine_results if item.best_distance is not None]
    impostor_distances = [item.best_distance for item in impostor_results if item.best_distance is not None]

    return {
        "threshold": threshold,
        "genuine_attempts": genuine_total,
        "impostor_attempts": impostor_total,
        "total_attempts": overall_total,
        "TA": ta,
        "FR": fr,
        "FA": fa,
        "TR": tr,
        "Recognition Accuracy (%)": round(recognition_accuracy, 2),
        "Recognition Success Rate (%)": round(recognition_success_rate, 2),
        "False Rejection Rate (%)": round(frr, 2),
        "False Acceptance Rate (%)": round(far, 2),
        "Mean Genuine Distance": round(mean(genuine_distances), 4) if genuine_distances else None,
        "Mean Impostor Distance": round(mean(impostor_distances), 4) if impostor_distances else None,
    }


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_markdown_summary(path: Path, summary: dict[str, object], genuine_results: list[AttemptResult], impostor_results: list[AttemptResult], probes: list[StudentProbe], section: str) -> None:
    lines: list[str] = []
    lines.append(f"# Facial Recognition Evaluation Summary - {section}")
    lines.append("")
    lines.append("This report is based on a limited controlled evaluation using one sample image per enrolled student.")
    lines.append("Impostor performance is computed either from cross-identity comparisons within the enrolled sample set or from external impostor images if provided.")
    lines.append("")
    lines.append("## Summary Metrics")
    lines.append("")
    lines.append("| Metric | Value |")
    lines.append("|---|---:|")
    lines.append(f"| Genuine attempts | {summary['genuine_attempts']} |")
    lines.append(f"| Impostor attempts | {summary['impostor_attempts']} |")
    lines.append(f"| True Accept (TA) | {summary['TA']} |")
    lines.append(f"| False Reject (FR) | {summary['FR']} |")
    lines.append(f"| False Accept (FA) | {summary['FA']} |")
    lines.append(f"| True Reject (TR) | {summary['TR']} |")
    lines.append(f"| Recognition Accuracy | {summary['Recognition Accuracy (%)']}% |")
    lines.append(f"| Recognition Success Rate | {summary['Recognition Success Rate (%)']}% |")
    lines.append(f"| False Rejection Rate (FRR) | {summary['False Rejection Rate (%)']}% |")
    lines.append(f"| False Acceptance Rate (FAR) | {summary['False Acceptance Rate (%)']}% |")
    if summary.get("Mean Genuine Distance") is not None:
        lines.append(f"| Mean genuine best distance | {summary['Mean Genuine Distance']} |")
    if summary.get("Mean Impostor Distance") is not None:
        lines.append(f"| Mean impostor best distance | {summary['Mean Impostor Distance']} |")
    lines.append("")
    lines.append("## Per-Student Genuine Results")
    lines.append("")
    lines.append("| Student ID | Sample | Outcome | Best Distance | Note |")
    lines.append("|---|---|---|---:|---|")
    for item in genuine_results:
        sample_name = next((p.sample_image.name for p in probes if p.student_id == item.probe_id), "")
        best_distance = "" if item.best_distance is None else f"{item.best_distance:.4f}"
        lines.append(f"| {item.probe_id} | {sample_name} | {item.outcome} | {best_distance} | {item.note} |")
    if impostor_results:
        lines.append("")
        lines.append("## Impostor Results")
        lines.append("")
        lines.append("| Probe | Target | Outcome | Best Distance | Note |")
        lines.append("|---|---|---|---:|---|")
        for item in impostor_results[:200]:
            best_distance = "" if item.best_distance is None else f"{item.best_distance:.4f}"
            lines.append(f"| {item.probe_id} | {item.target_id} | {item.outcome} | {best_distance} | {item.note} |")
        if len(impostor_results) > 200:
            lines.append("")
            lines.append(f"Note: first 200 impostor rows shown in the markdown preview; full detail is written to the CSV output.")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def print_summary(summary: dict[str, object]) -> None:
    print("\nFacial Recognition Evaluation Summary")
    print("-" * 44)
    for key in [
        "genuine_attempts",
        "impostor_attempts",
        "TA",
        "FR",
        "FA",
        "TR",
        "Recognition Accuracy (%)",
        "Recognition Success Rate (%)",
        "False Rejection Rate (%)",
        "False Acceptance Rate (%)",
    ]:
        print(f"{key}: {summary[key]}")


def main() -> None:
    args = parse_args()
    supabase = load_supabase_client()

    student_rows = fetch_registered_students(supabase)
    if not student_rows:
        raise RuntimeError("No registered students with facial_dataset_path were found in Supabase.")

    reference_index = build_reference_index(supabase, student_rows)

    if args.samples_csv is not None:
        probes = read_student_probes_from_csv(args.samples_csv)
    else:
        probes = discover_student_probes(args.samples_dir, reference_index.keys())

    if not probes:
        raise RuntimeError(
            "No sample images were found. Provide --samples-csv or place <student_id>.jpg/.png files inside the sample directory."
        )

    genuine_results = evaluate_genuine_samples(probes, reference_index, args.threshold)

    impostor_results: list[AttemptResult] = []
    if args.impostor_dir is not None:
        impostor_results = evaluate_external_impostors(args.impostor_dir, reference_index, args.threshold)
    elif not args.no_cross_impostor:
        impostor_results = evaluate_cross_impostors(probes, reference_index, args.threshold)

    summary = summarize_results(genuine_results, impostor_results, args.threshold)

    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    detailed_rows = [asdict(item) for item in genuine_results + impostor_results]
    write_csv(output_dir / "evaluation_detailed_results.csv", detailed_rows)
    write_csv(output_dir / "evaluation_summary_table.csv", [summary])
    write_markdown_summary(
        output_dir / "evaluation_summary_table.md",
        summary,
        genuine_results,
        impostor_results,
        probes,
        args.section,
    )

    metadata = {
        "generated_at": dt.datetime.now().isoformat(),
        "section": args.section,
        "threshold": args.threshold,
        "sample_count": len(probes),
        "impostor_mode": "external" if args.impostor_dir is not None else ("cross_identity" if not args.no_cross_impostor else "none"),
    }
    (output_dir / "evaluation_metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print_summary(summary)
    print(f"\nOutputs written to: {output_dir}")
    print("\nMethodology note: this is a limited controlled evaluation using one sample image per enrolled student.")
    if args.impostor_dir is None and not args.no_cross_impostor:
        print("Impostor results were derived from cross-identity comparisons within the enrolled sample set.")
    elif args.impostor_dir is not None:
        print(f"Impostor results were derived from external photos in: {args.impostor_dir}")


if __name__ == "__main__":
    main()