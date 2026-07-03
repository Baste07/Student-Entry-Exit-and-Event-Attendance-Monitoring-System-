from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt


SESSION_A = "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe"
SESSION_A_SCHEDULE = {
    "schedule_id": "ff914220-58db-4997-b604-a59fbea60f72",
    "section": "BSIT-3E",
    "day_of_week": "Monday",
    "start_time": "16:41:00",
    "end_time": "18:41:00",
    "school_year": "2025-2026",
    "semester": "2nd",
}


def parse_dt(value: str) -> datetime:
    return datetime.fromisoformat(value.replace(" ", "T"))


def load_attendance_rows() -> list[dict[str, object]]:
    raw_rows = [
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "72236d3f-3944-45cc-96d1-99ac2e545820",
            "time_in": "2026-05-04 08:44:27.88+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "34461490-a717-4c3a-9e47-0539281e8bde",
            "time_in": "2026-05-04 08:47:25.03+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "d6b80a93-be03-4d13-baf0-9e314d2410af",
            "time_in": "2026-05-04 08:42:32.675+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "ba62d0a0-53d3-4d4f-bd83-860bfd6a6090",
            "time_in": "2026-05-04 08:45:05.561+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "4a0ab6db-60f3-498a-ae5a-8d5252d54d99",
            "time_in": "2026-05-04 08:43:32.366+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "c146aa39-7c5a-4947-ab6b-3ca155449aad",
            "time_in": "2026-05-04 08:47:16.534+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "429b1e2f-266e-4040-8ad2-735a6b282de7",
            "time_in": "2026-05-04 08:43:09.752+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "c85dbdb9-1016-4482-be69-a3216da8dceb",
            "time_in": "2026-05-04 08:44:00.134+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "4890971c-1f0c-472c-8c87-b32e2824860f",
            "time_in": "2026-05-04 08:48:26.82+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "5b6ffe14-69d1-4bcc-97e9-608169a885ff",
            "time_in": "2026-05-04 08:45:16.314+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "2db805d3-6e8a-4220-bdbd-41db8cddc644",
            "time_in": "2026-05-04 08:46:57.548+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "0d0f7b05-4d13-4638-9fbd-c6d9a57424d6",
            "time_in": "2026-05-04 08:45:42.002+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "fcc4c797-03b3-496f-9eb9-f9cdcfbf9114",
            "time_in": "2026-05-04 08:42:47.922+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "858b3458-cb47-46f8-b69c-a822b25ddbea",
            "time_in": "2026-05-04 08:47:35.769+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "405486fd-7808-40b6-a96c-29b6a5e29b3b",
            "time_in": "2026-05-04 08:44:55.724+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "4c6762cb-ee4c-46ad-b8de-08655bee7035",
            "time_in": "2026-05-04 08:48:05.774+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "b2f93dbf-9bb6-4f87-b829-8cc6e3d15743",
            "time_in": "2026-05-04 08:45:33.261+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "cbd08aa4-219d-4ed9-873e-bc1457b18aea",
            "time_in": "2026-05-04 08:46:20.312+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "14309d59-6f1b-4fd5-8481-25409a2346b4",
            "time_in": "2026-05-04 08:47:51.421+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "b8594389-fab2-47c2-aebe-44fc4dde8c06",
            "time_in": "2026-05-04 08:42:55.622+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "d2848cf1-77f2-483d-9b10-2432b2d4b617",
            "student_id": "f4be716d-bced-438e-be2d-a634e50ca525",
            "time_in": "2026-05-06 19:27:45.067483+00",
            "time_out": "2026-05-06 19:33:52.275+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "eb92dcc5-ebac-4ccb-b1ca-eadb5867fa27",
            "time_in": "2026-05-04 08:46:29.196+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "ff85ae06-59f5-4b12-9d50-aeae0a8979ef",
            "time_in": "2026-05-04 08:44:19.596+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "e61c5a54-c512-4fa7-8f75-2f52656cb8d3",
            "time_in": "2026-05-04 08:46:41+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "f4be716d-bced-438e-be2d-a634e50ca525",
            "time_in": "2026-05-04 08:42:23.456+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "7ada5b69-4dee-4f87-acc8-23478284a119",
            "time_in": "2026-05-04 08:44:45.45+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "7d348056-d91f-404a-83a3-544950f84144",
            "time_in": "2026-05-04 08:43:02.668+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "b82e8561-d753-4ff0-9fd5-1e2c7fb00a82",
            "time_in": "2026-05-04 08:44:37.294+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "911d6ca4-7e26-4ca1-80bb-3b4765e56ef3",
            "time_in": "2026-05-04 08:44:09.08+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "ce6f5149-e625-4a71-a3a3-e53d0eccba90",
            "time_in": "2026-05-04 08:43:50.806+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
        {
            "session_id": "78b88fd3-7a2f-4f22-88f6-7ab8ea66debe",
            "student_id": "f08cea70-f3d0-4f29-b012-0590c363c283",
            "time_in": "2026-05-04 08:45:24.496+00",
            "time_out": "2026-05-04 08:48:55.255+00",
        },
    ]

    rows: list[dict[str, object]] = []
    for row in raw_rows:
        rows.append(
            {
                "session_id": row["session_id"],
                "student_id": row["student_id"],
                "time_in": parse_dt(str(row["time_in"])),
                "time_out": parse_dt(str(row["time_out"])),
                "verified_by_facial_recognition": True,
            }
        )
    return rows


def figure_3_1_timeline(rows: list[dict[str, object]], output_dir: Path) -> None:
    student_ids = sorted({str(r["student_id"]) for r in rows})
    student_to_idx = {sid: idx + 1 for idx, sid in enumerate(student_ids)}

    x_in = [r["time_in"] for r in rows]
    x_out = [r["time_out"] for r in rows]
    y = [student_to_idx[str(r["student_id"])] for r in rows]

    fig, ax = plt.subplots(figsize=(14, 8))
    ax.scatter(x_in, y, c="#1f77b4", marker="o", s=50, label="Time-in")
    ax.scatter(x_out, y, c="#2ca02c", marker="x", s=60, label="Time-out")

    ax.set_title("Figure 3.1 Time-In and Time-Out Attendance Timeline")
    ax.set_xlabel("Timestamp")
    ax.set_ylabel("Anonymized Student Index")
    ax.grid(alpha=0.25)
    ax.legend(loc="upper left")

    ax.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d %H:%M"))
    fig.autofmt_xdate(rotation=25)
    fig.tight_layout()
    fig.savefig(output_dir / "figure_3_1_attendance_timeline.png", dpi=300)
    plt.close(fig)


def figure_3_2_recognition_stacked(output_dir: Path) -> None:
    labels = ["TA", "FR", "FA", "TR"]
    values = [366, 14, 2, 188]
    colors = ["#2ca02c", "#ff7f0e", "#d62728", "#1f77b4"]

    fig, ax = plt.subplots(figsize=(10, 6))
    cumulative = 0
    for label, value, color in zip(labels, values, colors):
        ax.bar(["Recognition Outcomes"], [value], bottom=[cumulative], label=f"{label} ({value})", color=color)
        cumulative += value

    ax.set_title("Figure 3.2 Recognition Outcome Distribution")
    ax.set_ylabel("Count")
    ax.legend(loc="upper right")
    ax.grid(axis="y", alpha=0.2)
    fig.tight_layout()
    fig.savefig(output_dir / "figure_3_2_recognition_outcomes.png", dpi=300)
    plt.close(fig)


def figure_3_3_occupancy_curve(rows: list[dict[str, object]], output_dir: Path) -> None:
    session_rows = [r for r in rows if r["session_id"] == SESSION_A]
    session_rows.sort(key=lambda r: r["time_in"])

    start = min(r["time_in"] for r in session_rows)
    end = max(r["time_out"] for r in session_rows)

    points = []
    counts = []
    t = start.replace(second=0, microsecond=0)
    while t <= end:
        count = sum(1 for r in session_rows if r["time_in"] <= t < r["time_out"])
        points.append(t)
        counts.append(count)
        t += timedelta(minutes=1)

    fig, ax = plt.subplots(figsize=(12, 6))
    ax.plot(points, counts, marker="o", linewidth=2.5, color="#9467bd", label="Occupancy")
    peak = max(counts)
    peak_t = points[counts.index(peak)]
    ax.scatter([peak_t], [peak], color="#d62728", s=100, zorder=3, label=f"Peak: {peak} students")

    ax.axvline(start, color="#ff7f0e", linestyle="--", linewidth=1.5, label=f"Actual start: {start.strftime('%H:%M')}")
    ax.axvline(end, color="#2ca02c", linestyle="--", linewidth=1.5, label=f"Actual end: {end.strftime('%H:%M')}")
    
    ax.set_title(f"Figure 3.3 Laboratory Occupancy Curve (Section {SESSION_A_SCHEDULE['section']})")
    ax.set_xlabel("Session Timeline (Minute Intervals)")
    ax.set_ylabel("Students Present")
    ax.grid(alpha=0.25)
    ax.legend(loc="upper left", fontsize=9)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
    fig.autofmt_xdate(rotation=0)
    fig.tight_layout()
    fig.savefig(output_dir / "figure_3_3_occupancy_curve.png", dpi=300)
    plt.close(fig)


def figure_3_4_data_completeness(output_dir: Path) -> None:
    values = [100.0, 0.0001]
    labels = ["Complete (100%)", "Incomplete (0%)"]
    colors = ["#2ca02c", "#d62728"]

    fig, ax = plt.subplots(figsize=(8, 8))
    wedges, _ = ax.pie(values, colors=colors, startangle=90, wedgeprops={"width": 0.40, "edgecolor": "white"})
    ax.legend(wedges, labels, loc="center left", bbox_to_anchor=(1.0, 0.5))
    ax.set_title("Figure 3.4 Data Completeness")
    ax.set_aspect("equal")
    fig.tight_layout()
    fig.savefig(output_dir / "figure_3_4_data_completeness.png", dpi=300)
    plt.close(fig)


def figure_3_5_error_rate_comparison(output_dir: Path) -> None:
    metrics = ["FRR", "FAR"]
    values = [3.68, 1.05]
    colors = ["#ff7f0e", "#d62728"]

    fig, ax = plt.subplots(figsize=(8, 6))
    bars = ax.bar(metrics, values, color=colors, width=0.55)
    for bar, val in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width() / 2, val + 0.1, f"{val:.2f}%", ha="center", va="bottom")

    ax.set_title("Figure 3.5 Error Rate Comparison")
    ax.set_ylabel("Rate (%)")
    ax.set_ylim(0, max(values) + 1.5)
    ax.grid(axis="y", alpha=0.2)
    fig.tight_layout()
    fig.savefig(output_dir / "figure_3_5_error_rates.png", dpi=300)
    plt.close(fig)


def figure_3_6_verification_status(rows: list[dict[str, object]], output_dir: Path) -> None:
    verified_count = sum(1 for row in rows if bool(row.get("verified_by_facial_recognition")))
    unverified_count = len(rows) - verified_count

    values = [verified_count, max(1, unverified_count)]
    labels = [f"Verified ({verified_count})", f"Unverified ({unverified_count})"]
    colors = ["#2ca02c", "#d62728"]

    fig, ax = plt.subplots(figsize=(8, 8))
    wedges, _ = ax.pie(
        values,
        colors=colors,
        startangle=90,
        wedgeprops={"width": 0.40, "edgecolor": "white"},
    )
    ax.legend(wedges, labels, loc="center left", bbox_to_anchor=(1.0, 0.5))
    ax.set_title("Figure 3.6 Facial Recognition Verification Status")
    ax.set_aspect("equal")
    fig.tight_layout()
    fig.savefig(output_dir / "figure_3_6_verification_status.png", dpi=300)
    plt.close(fig)


def main() -> None:
    output_dir = Path(__file__).resolve().parent / "results_figures"
    output_dir.mkdir(parents=True, exist_ok=True)

    rows = load_attendance_rows()

    figure_3_1_timeline(rows, output_dir)
    figure_3_2_recognition_stacked(output_dir)
    figure_3_3_occupancy_curve(rows, output_dir)
    figure_3_4_data_completeness(output_dir)
    figure_3_5_error_rate_comparison(output_dir)
    figure_3_6_verification_status(rows, output_dir)

    print("Saved figures to:", output_dir)


if __name__ == "__main__":
    main()