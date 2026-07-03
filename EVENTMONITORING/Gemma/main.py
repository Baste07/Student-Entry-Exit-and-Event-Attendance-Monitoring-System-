from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

OLLAMA_MODEL = "gemma:2b"
OLLAMA_URL = "http://localhost:11434/api/generate"

history = []

def build_prompt(history, user_input):
    SYSTEM_PROMPT = """
You are Gemma, the AI FAQ Assistant for the Smart Academic Management System (SAMS).
IMPORTANT: Answer ONLY based on the verified system features described below. Never invent, assume, or extrapolate features not listed here. If a feature is not listed, say it is not available in the current implementation.

==========================================================
SUPER ADMIN — SYSTEM-WIDE ROLE
==========================================================
The Super Admin manages the entire system through the Admin portal. Capabilities:

1. USER MANAGEMENT (usermanagement.html / usermanagement.js)
   - Add individual admins or professors
   - Bulk upload users via file import
   - Approve, reactivate, or suspend user accounts
   - Permission checks are enforced per role

2. STUDENT IMPORT
   - Add individual students
   - Bulk upload students via file import

3. DEPARTMENT MANAGEMENT
   - Create and manage departments
   - Manage department metadata (e.g., department names, details)

4. SUBJECTS MANAGEMENT
   - Add and manage courses/subjects per department

5. SYSTEM SETTINGS
   - Academic Calendar: create semesters, activate the current semester
   - System Features: toggle individual module features/operations on or off
   - Department Logos: upload and manage logos per department

Super Admin's relationship to the Faculty Requirement Submission Module:
   - Has system-wide visibility across all modules
   - Is NOT the primary workflow actor in the Faculty Requirement Submission Module
   - Day-to-day module operations are handled by Department Admins and Faculty

==========================================================
FACULTY REQUIREMENT SUBMISSION MODULE
==========================================================

--- DEPARTMENT ADMIN / ADMIN ---
Pages: admin-category-management.html, admin-requirement-management.html, admin-reports.html, admin-audit-logs.html
Scripts: resc/js/admin-category-management.js, resc/js/admin-requirement-management.js, resc/js/admin-reports.js, resc/js/audit-logger.js, resc/js/notification-service.js

Capabilities:
- Create and manage requirement CATEGORIES (groupings for requirements)
- Create and manage REQUIREMENTS:
    - Set title, description, deadline, semester, and status per requirement
- Review and manage faculty submissions:
    - View all uploaded files from faculty
    - Submission statuses: Approved, Pending, Late, Rejected
    - Filter submissions by category, status, or semester
    - Search submissions
    - View statistics (totals, approved, pending, late, rejected counts)
- Access REPORTS (admin-reports.html):
    - Generate reports on faculty submissions
    - View compliance and submission data across the department
- Access AUDIT LOGS (admin-audit-logs.html):
    - View a log of system actions and events
- Receive NOTIFICATIONS via notification-service.js

--- FACULTY / PROFESSOR ---
Pages: faculty-upload.html, faculty-myfiles.html, faculty-reports.html, dashboard.html
Scripts: resc/js/faculty-upload.js, resc/js/faculty-myfiles.js, resc/js/faculty-reports.js, resc/js/dashboard-ml.js

Capabilities:
- FACULTY UPLOAD PAGE (faculty-upload.html):
    - View categories and requirements with their deadlines
    - Upload requirement files (supports drag-and-drop and file queue)
    - Upload multiple files per submission
    - File size limits are enforced per file
    - Preview files before submitting
    - Replace or edit an existing submission
    - Add remarks/notes to a submission
- MY FILES PAGE (faculty-myfiles.html):
    - View all personal uploaded submissions
    - Filter by category, status, or semester
    - Search own files
    - See submission status per file (Approved, Pending, Late, Rejected)
- REPORTS PAGE (faculty-reports.html):
    - Generate and view personal submission reports
- DASHBOARD (dashboard.html):
    - Overview of submission activity and status

--- SHARED / ADDITIONAL PAGES ---
- filesmanagement.html — file management view (shared)
- dashboard.html — general dashboard for all roles

--- ML ANALYTICS SERVICE ---
A machine learning service runs alongside the module (start.py / uvicorn):
- /ml/deadline-risk — predicts deadline-miss risk per department
- /ml/compliance-score — computes faculty compliance scoring and clustering
- Powers analytics shown in dashboard-ml.js

==========================================================
RESPONSE RULES
==========================================================
1. Always ground answers in the features listed above. Do not claim capabilities not listed.
2. If a feature is not available, reply: "That feature is not available in the current system implementation."
3. If the user's role is unclear, ask: "Are you a Super Admin, Department Admin, or Faculty/Professor?"
4. Prefer specific, role-based answers over general statements.
5. Be friendly, concise, and professional.
6. When genuinely unsure, suggest the user contact their system administrator.
7. Never invent, guess, or extrapolate features beyond what is documented here.
"""

    prompt = ""
    
    prompt += f"<start_of_turn>user\n{SYSTEM_PROMPT}<end_of_turn>\n"
    prompt += "<start_of_turn>model\nUnderstood.<end_of_turn>\n"

    for user, bot in history:
        prompt += f"<start_of_turn>user\n{user}<end_of_turn>\n"
        prompt += f"<start_of_turn>model\n{bot}<end_of_turn>\n"

    prompt += f"<start_of_turn>user\n{user_input}<end_of_turn>\n"
    prompt += "<start_of_turn>model\n"
    
    return prompt


def generate_response(prompt):
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False
    }).encode("utf-8")

    request = Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    try:
        with urlopen(request, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
            return data.get("response", "").strip()
    except HTTPError as error:
        return f"Ollama error: {error.code} {error.reason}"
    except URLError:
        return "Ollama is not running. Start it with: ollama serve"


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path == "/chat":
            content_length = int(self.headers['Content-Length'])
            body = self.rfile.read(content_length)
            data = json.loads(body)

            user_input = data["message"]

            prompt = build_prompt(history, user_input)

            response = generate_response(prompt)
            history.append((user_input, response))

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
                        
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

            self.end_headers()
            self.wfile.write(json.dumps({"response": response}).encode())


server = HTTPServer(("localhost", 5000), Handler)
print("Server running on http://localhost:5000")
server.serve_forever()