/* ============================================================
   resc/js/attendanceGraphs.js
   Dedicated analytics page for attendance charts
============================================================ */

function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeCsvValue(value) {
    return '"' + String(value ?? '')
        .replace(/"/g, '""')
        .replace(/\r?\n/g, ' ') + '"';
}

function getDeptLogos() {
    try {
        const user = JSON.parse(sessionStorage.getItem('user') || '{}');
        return {
            deptLogo: user.departmentLogo || '../resc/assets/ccs_logo.png',
            deptName: user.department || 'College of Computer Studies',
            deptCode: user.departmentCode || 'CCS',
        };
    } catch (e) {
        return {
            deptLogo: '../resc/assets/ccs_logo.png',
            deptName: 'College of Computer Studies',
            deptCode: 'CCS',
        };
    }
}

let allAttendance = [];
let scheduleEnrollmentCounts = {};
let attendanceCharts = {
    subjectBreakdown: null,
    professorBreakdown: null,
    semesterBreakdown: null,
};
let graphPreviewChart = null;
let existingReportsToday = [];

const GRAPH_REPORT_TYPE = 'attendance_graphs';

function parseSessionLabFromNotes(notes) {
    const txt = String(notes || '');
    const m = txt.match(/Started in\s+(.+?)(?:\s*\(scheduled|$)/i);
    if (!m || !m[1]) return null;
    const label = m[1].trim();
    const parts = label.split(' - ');
    if (parts.length >= 2) {
        return { lab_code: parts[0].trim(), lab_name: parts.slice(1).join(' - ').trim() };
    }
    return { lab_code: label, lab_name: '' };
}

function getSemesterLabel(row) {
    const semester = row?.semester ? String(row.semester).trim() : '';
    const schoolYear = row?.school_year ? String(row.school_year).trim() : '';
    if (semester && schoolYear) return `${semester} ${schoolYear}`;
    if (semester) return semester;
    if (schoolYear) return schoolYear;
    return 'Unassigned Semester';
}

function formatYearSection(yearLevel, section, classSection) {
    const y = (yearLevel !== null && yearLevel !== undefined && String(yearLevel).trim() !== '')
        ? String(yearLevel).trim()
        : '';
    const sec = section ? String(section).trim().toUpperCase() : '';
    if (y && sec) return `${y}${sec}`;

    const cls = classSection ? String(classSection).trim() : '';
    if (!cls) return '—';

    const m = cls.match(/(\d+)\s*-?\s*([A-Za-z])$/);
    if (m) return `${m[1]}${m[2].toUpperCase()}`;

    const tail = cls.split('-').pop()?.trim();
    return tail || cls;
}

function getYearSectionDisplay(row) {
    return formatYearSection(row?.year_level, row?.student_section, row?.class_section);
}

function populateSelect(id, data, valFn, textFn) {
    const select = document.getElementById(id);
    if (!select) return;
    const defaultText = select.options[0]?.text || 'All';
    const options = data ? data.map(item => `<option value="${escapeHtml(valFn(item))}">${escapeHtml(textFn(item))}</option>`).join('') : '';
    select.innerHTML = `<option value="">${defaultText}</option>${options}`;
}

function getChartFilterState(chart) {
    switch (chart) {
        case 'subject':
            return {
                subject: document.getElementById('chartSubjectSelect')?.value || '',
                semester: document.getElementById('chartSubjectSemesterSelect')?.value || ''
            };
        case 'professor':
            return {
                professor: document.getElementById('chartProfessorSelect')?.value || '',
                semester: document.getElementById('chartProfessorSemesterSelect')?.value || ''
            };
        case 'semester':
            return {
                semester: document.getElementById('chartSemesterSelect')?.value || ''
            };
        default:
            return {};
    }
}

function getChartBaseAttendance(filters) {
    const f = filters || {};
    return allAttendance.filter((row) => {
        if (f.subject && String(row.subject_id) !== String(f.subject)) return false;
        if (f.professor && String(row.professor_id) !== String(f.professor)) return false;
        if (f.semester && String(getSemesterLabel(row)) !== String(f.semester)) return false;
        if ((row.session_status || '').toString().toLowerCase() !== 'completed') return false;
        return true;
    });
}

function createGroupMap() {
    return new Map();
}

function addGroupValue(groupMap, key, label, summary) {
    if (!key) return;
    if (!groupMap.has(key)) {
        groupMap.set(key, {
            label,
            total: 0,
            present: 0,
            late: 0,
            absent: 0,
        });
    }

    const target = groupMap.get(key);
    target.total += summary.total;
    target.present += summary.present;
    target.late += summary.late;
    target.absent += summary.absent;
}

function summarizeAttendanceGroups(baseAttendance) {
    const bySchedule = new Map();

    baseAttendance.forEach((row) => {
        if (!row.schedule_id) return;
        if (!bySchedule.has(row.schedule_id)) {
            bySchedule.set(row.schedule_id, []);
        }
        bySchedule.get(row.schedule_id).push(row);
    });

    const subjectGroups = createGroupMap();
    const professorGroups = createGroupMap();
    const semesterGroups = createGroupMap();

    bySchedule.forEach((rows) => {
        const reference = rows[0];
        if (!reference) return;

        const actualRows = rows.filter((row) => !row.is_absent);
        const present = actualRows.filter((row) => row.time_in_status !== 'late').length;
        const late = actualRows.filter((row) => row.time_in_status === 'late').length;
        const enrolled = scheduleEnrollmentCounts[reference.schedule_id] ?? actualRows.length;
        const absent = Math.max(enrolled - actualRows.length, 0);

        const summary = {
            total: enrolled,
            present,
            late,
            absent,
        };

        const subjectLabel = reference.subject_code
            ? `${reference.subject_code}${reference.subject_name ? ` - ${reference.subject_name}` : ''}`
            : 'Unknown Subject';
        const professorLabel = reference.professor_name || 'Unknown Professor';
        const semesterLabel = getSemesterLabel(reference);

        addGroupValue(subjectGroups, reference.subject_id || subjectLabel, subjectLabel, summary);
        addGroupValue(professorGroups, reference.professor_id || professorLabel, professorLabel, summary);
        addGroupValue(semesterGroups, semesterLabel, semesterLabel, summary);
    });

    return {
        subject: Array.from(subjectGroups.values()),
        professor: Array.from(professorGroups.values()),
        semester: Array.from(semesterGroups.values()),
    };
}

function compressGroupList(items, limit = 8) {
    const sorted = [...items].sort((a, b) => b.total - a.total);
    if (sorted.length <= limit) return sorted;

    const visible = sorted.slice(0, Math.max(limit - 1, 1));
    const rest = sorted.slice(Math.max(limit - 1, 1));
    const others = rest.reduce((acc, item) => {
        acc.total += item.total;
        acc.present += item.present;
        acc.late += item.late;
        acc.absent += item.absent;
        return acc;
    }, { label: 'Others', total: 0, present: 0, late: 0, absent: 0 });

    return [...visible, others];
}

function destroyChart(chartInstance) {
    if (chartInstance && typeof chartInstance.destroy === 'function') {
        chartInstance.destroy();
    }
}

function renderAttendanceChart(canvas, previousChart, config) {
    if (!canvas || typeof Chart === 'undefined') return null;

    destroyChart(previousChart);

    return new Chart(canvas, {
        type: 'bar',
        data: {
            labels: config.labels,
            datasets: [
                { label: config.mode === 'percentage' ? 'Present %' : 'Present', data: config.present, backgroundColor: '#40916c', borderRadius: 6, stack: 'attendance' },
                { label: config.mode === 'percentage' ? 'Late %' : 'Late', data: config.late, backgroundColor: '#d97706', borderRadius: 6, stack: 'attendance' },
                { label: config.mode === 'percentage' ? 'Absent %' : 'Absent', data: config.absent, backgroundColor: '#dc2626', borderRadius: 6, stack: 'attendance' },
            ],
        },
        options: {
            indexAxis: config.indexAxis || 'x',
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 350 },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { usePointStyle: true, boxWidth: 10, padding: 16 }
                },
                tooltip: {
                    callbacks: {
                        label(context) {
                            const suffix = config.mode === 'percentage' ? '%' : '';
                            const val = config.indexAxis === 'y' ? context.parsed.x : context.parsed.y;
                            return `${context.dataset.label}: ${val}${suffix}`;
                        }
                    }
                },
                title: { display: Boolean(config.title), text: config.title || '' }
            },
            scales: config.indexAxis === 'y' ? {
                x: { stacked: true, beginAtZero: true, max: config.mode === 'percentage' ? 100 : undefined, ticks: { color: '#5a7265', callback(value) { return config.mode === 'percentage' ? `${value}%` : value; } }, grid: { color: 'rgba(212, 230, 217, 0.6)' } },
                y: { stacked: true, ticks: { color: '#5a7265', maxRotation: 30, minRotation: 0 }, grid: { display: false } }
            } : {
                x: { stacked: true, ticks: { color: '#5a7265', maxRotation: 30, minRotation: 0 }, grid: { display: false } },
                y: { stacked: true, beginAtZero: true, max: config.mode === 'percentage' ? 100 : undefined, ticks: { color: '#5a7265', callback(value) { return config.mode === 'percentage' ? `${value}%` : value; } }, grid: { color: 'rgba(212, 230, 217, 0.6)' } }
            }
        }
    });
}

function buildAttendanceChartConfigs() {
    const baseAttendanceForSubjects = getChartBaseAttendance(getChartFilterState('subject'));
    const groupedSubjects = summarizeAttendanceGroups(baseAttendanceForSubjects);

    const baseAttendanceForProfessor = getChartBaseAttendance(getChartFilterState('professor'));
    const groupedProfessor = summarizeAttendanceGroups(baseAttendanceForProfessor);

    const baseAttendanceForSemester = getChartBaseAttendance(getChartFilterState('semester'));
    const groupedSemesterOnly = summarizeAttendanceGroups(baseAttendanceForSemester);

    const subjectItems = compressGroupList(groupedSubjects.subject || [], 8);
    const professorItems = compressGroupList(groupedProfessor.professor || [], 8);
    const semesterItems = groupedSemesterOnly.semester || [];

    return {
        subjectConfig: {
            title: 'Subject attendance breakdown',
            labels: subjectItems.map((item) => item.label),
            present: subjectItems.map((item) => item.present),
            late: subjectItems.map((item) => item.late),
            absent: subjectItems.map((item) => item.absent),
            mode: 'counts',
            summaryItems: subjectItems,
        },
        professorConfig: {
            title: 'Professor attendance breakdown',
            labels: professorItems.map((item) => item.label),
            present: professorItems.map((item) => item.present),
            late: professorItems.map((item) => item.late),
            absent: professorItems.map((item) => item.absent),
            mode: 'counts',
            summaryItems: professorItems,
        },
        semesterConfig: {
            title: 'Semester percentage share',
            labels: semesterItems.map((item) => item.label),
            present: semesterItems.map((item) => item.total > 0 ? Number(((item.present / item.total) * 100).toFixed(1)) : 0),
            late: semesterItems.map((item) => item.total > 0 ? Number(((item.late / item.total) * 100).toFixed(1)) : 0),
            absent: semesterItems.map((item) => item.total > 0 ? Number(((item.absent / item.total) * 100).toFixed(1)) : 0),
            mode: 'percentage',
            indexAxis: 'y',
            summaryItems: semesterItems,
        },
    };
}

function loadImage(src) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    resolve(null);
                    return;
                }
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL('image/png'));
            } catch (error) {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

function splitChartLabel(chartName, label) {
    const raw = String(label || '').trim();

    if (chartName === 'Subject Attendance' && raw.includes(' - ')) {
        const [part1, ...rest] = raw.split(' - ');
        return [part1.trim(), rest.join(' - ').trim()];
    }

    if (chartName === 'Semester Share') {
        const match = raw.match(/^(.+?)\s+(\d{4}-\d{4})$/);
        if (match) return [match[1].trim(), match[2].trim()];
    }

    if (chartName === 'Professor Attendance') {
        const parts = raw.split(' ');
        if (parts.length >= 2) {
            return [parts[0].trim(), parts.slice(1).join(' ').trim()];
        }
    }

    return [raw, ''];
}

function buildCsvRows(chartName, config) {
    return config.labels.map((label, index) => {
        const [part1, part2] = splitChartLabel(chartName, label);
        return [
            part1,
            part2,
            config.present[index],
            config.late[index],
            config.absent[index],
            config.mode,
        ];
    });
}

function getChartTotals(config) {
    return (config.summaryItems || []).reduce((acc, item) => ({
        present: acc.present + (item.present || 0),
        late: acc.late + (item.late || 0),
        absent: acc.absent + (item.absent || 0),
    }), { present: 0, late: 0, absent: 0 });
}

function makeCellValue(value) {
    return value === undefined || value === null ? '' : value;
}

function getGraphExportState(exportType) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    return {
        reportName: `Attendance Graphs Report — ${dateStr} (${exportType})`,
        dataString: JSON.stringify({
            filters: getChartFilterState(),
            charts: buildAttendanceChartConfigs(),
        }),
    };
}

async function fetchTodayReports() {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
        existingReportsToday = [];
        return;
    }

    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    try {
        const { data } = await supabaseClient
            .from('las_reports')
            .select('report_name, report_data')
            .eq('report_type', GRAPH_REPORT_TYPE)
            .like('report_name', `%${dateStr}%`);

        existingReportsToday = data
            ? data.map((item) => ({
                name: item.report_name,
                dataString: typeof item.report_data === 'string' ? item.report_data : JSON.stringify(item.report_data),
            }))
            : [];
    } catch (error) {
        existingReportsToday = [];
    }
}

function checkDuplicateWarning(exportType) {
    const { reportName, dataString } = getGraphExportState(exportType);
    const isExactDuplicate = existingReportsToday.some((item) => item.name === reportName && item.dataString === dataString);

    if (isExactDuplicate) {
        return confirm(`A ${exportType} report with this EXACT data has already been saved today.\n\nAre you sure you want to generate a duplicate?`);
    }

    return true;
}

async function autoSaveReport(exportType) {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) return;

    const { reportName, dataString } = getGraphExportState(exportType);
    const payload = {
        report_type: GRAPH_REPORT_TYPE,
        report_name: reportName,
        filters: JSON.stringify(getChartFilterState()),
        report_data: dataString,
    };

    try {
        const { error } = await supabaseClient.from('las_reports').insert([payload]);
        if (error) throw error;

        existingReportsToday.push({
            name: payload.report_name,
            dataString: payload.report_data,
        });
    } catch (error) {
        console.error('Auto-save error:', error);
    }
}

window.downloadGraphsCSV = async function() {
    if (!checkDuplicateWarning('CSV')) return;

    const configs = buildAttendanceChartConfigs();
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const nowStr = `${dateStr} at ${timeStr}`;
    const { deptName } = getDeptLogos();

    const rows = [
        ['Attendance Graphs Report'],
        ['Generated At', nowStr],
        ['Department', deptName],
        [],
    ];

    const addSection = (title, config, summaryLabel = 'Summary Totals') => {
        const totals = getChartTotals(config);
        rows.push([title]);
        rows.push([summaryLabel, '', `Present: ${totals.present}`, `Late: ${totals.late}`, `Absent: ${totals.absent}`, `Mode: ${config.mode}`]);
        rows.push(['Label Part 1', 'Label Part 2', 'Present', 'Late', 'Absent', 'Mode']);
        rows.push(...buildCsvRows(title, config));
        rows.push([]);
    };

    addSection('Subject Attendance', configs.subjectConfig);
    addSection('Professor Attendance', configs.professorConfig);
    addSection('Semester Share', configs.semesterConfig);

    const csv = rows.map((row) => row.map(escapeCsvValue).join(',')).join('\n');
    const fileName = `Attendance_Graphs_${new Date().toISOString().split('T')[0]}.csv`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(link.href);

    await autoSaveReport('CSV');
};

window.downloadGraphsExcel = async function() {
    if (!checkDuplicateWarning('Excel')) return;

    if (!window.XLSX) {
        alert('Excel library not loaded yet. Please try again.');
        return;
    }

    const configs = buildAttendanceChartConfigs();
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const nowStr = `${dateStr} at ${timeStr}`;
    const { deptName } = getDeptLogos();

    const rows = [];
    const merges = [];

    const addMergedRow = (rowNumber, startCol, endCol) => {
        merges.push({ s: { r: rowNumber - 1, c: startCol - 1 }, e: { r: rowNumber - 1, c: endCol - 1 } });
    };

    const addTitleRow = (text) => {
        rows.push([text, '', '', '', '', '']);
        addMergedRow(rows.length, 1, 6);
    };

    const addSection = (title, config) => {
        const totals = getChartTotals(config);

        rows.push([title, '', '', '', '', '']);
        addMergedRow(rows.length, 1, 6);

        rows.push([
            'Summary Totals',
            '',
            `Present: ${totals.present}`,
            `Late: ${totals.late}`,
            `Absent: ${totals.absent}`,
            `Mode: ${config.mode}`,
        ]);
        addMergedRow(rows.length, 1, 2);

        rows.push(['Label', '', 'Present', 'Late', 'Absent', 'Mode']);
        addMergedRow(rows.length, 1, 2);

        (config.labels || []).forEach((label, index) => {
            rows.push([
                makeCellValue(label),
                '',
                makeCellValue(config.present[index]),
                makeCellValue(config.late[index]),
                makeCellValue(config.absent[index]),
                makeCellValue(config.mode),
            ]);
            addMergedRow(rows.length, 1, 2);
        });

        rows.push(['', '', '', '', '', '']);
    };

    addTitleRow('Attendance Graphs Report');
    addTitleRow(`Generated At: ${nowStr}`);
    addTitleRow(`Department: ${deptName}`);
    rows.push(['', '', '', '', '', '']);

    addSection('Subject Attendance', configs.subjectConfig);
    addSection('Professor Attendance', configs.professorConfig);
    addSection('Semester Share', configs.semesterConfig);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!merges'] = merges;
    ws['!cols'] = [
        { wch: 24 },
        { wch: 24 },
        { wch: 14 },
        { wch: 14 },
        { wch: 14 },
        { wch: 14 },
    ];

    // Light styling through row height and alignment-friendly widths.
    ws['!rows'] = rows.map((row, index) => {
        if (index < 3) return { hpt: 22 };
        return { hpt: 20 };
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance Graphs');
    XLSX.writeFile(wb, `Attendance_Graphs_${new Date().toISOString().split('T')[0]}.xlsx`);

    await autoSaveReport('Excel');
};

window.downloadGraphsPDF = async function() {
    if (!checkDuplicateWarning('PDF')) return;

    if (!window.jspdf) {
        alert('PDF library not loaded yet. Please try again.');
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.width;
    const pageH = doc.internal.pageSize.height;
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const nowStr = `${dateStr} at ${timeStr}`;
    const { deptLogo, deptName } = getDeptLogos();
    const [plpData, ccsData] = await Promise.all([
        loadImage('../resc/assets/plp_logo.png'),
        loadImage(deptLogo),
    ]);

    const chartConfigs = buildAttendanceChartConfigs();

    const charts = [
        {
            title: 'Subject Attendance',
            subtitle: 'Counts of present, late, and absent students per subject.',
            canvas: document.getElementById('graphAttendanceSubjectChart'),
            config: chartConfigs.subjectConfig,
        },
        {
            title: 'Professor Attendance',
            subtitle: 'Aggregated present, late, and absent counts for each professor.',
            canvas: document.getElementById('graphAttendanceProfessorChart'),
            config: chartConfigs.professorConfig,
        },
        {
            title: 'Semester Share',
            subtitle: 'Percent split of present, late, and absent students per semester.',
            canvas: document.getElementById('graphSemesterAttendanceChart'),
            config: chartConfigs.semesterConfig,
        },
    ];

    const drawHeader = () => {
        const headerHeight = 42;
        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.15);
        doc.rect(10, 6, pageW - 20, headerHeight, 'S');

        const centerX = pageW / 2;
        const logoSize = 16;
        if (plpData) doc.addImage(plpData, 'PNG', centerX - 85, 10, logoSize, logoSize);
        if (ccsData) doc.addImage(ccsData, 'PNG', centerX + 69, 10, logoSize, logoSize);

        doc.setTextColor(0, 0, 0);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(15);
        doc.text('PAMANTASAN NG LUNGSOD NG PASIG', centerX, 18, { align: 'center' });
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(60, 60, 60);
        doc.text(deptName.toUpperCase(), centerX, 23, { align: 'center' });
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.setTextColor(0, 0, 0);
        doc.text('ATTENDANCE GRAPHS REPORT', centerX, 32, { align: 'center' });
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(80, 80, 80);
        doc.text(`Generated: ${nowStr}`, centerX, 38, { align: 'center' });
        return headerHeight;
    };

    const drawFooter = (pageNumber, totalPages) => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(156, 163, 175);
        doc.text(`Laboratory Attendance System  ·  Page ${pageNumber} of ${totalPages}  ·  ${nowStr}`, pageW / 2, pageH - 7, { align: 'center' });
    };

    charts.forEach((chart, index) => {
        if (index > 0) doc.addPage();
        const headerHeight = drawHeader();

        const titleY = headerHeight + 12;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(26, 71, 49);
        doc.text(chart.title, 14, titleY);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(90, 114, 101);
        doc.text(chart.subtitle, 14, titleY + 5);

        const summaryY = titleY + 11;
        const summaryItems = chart.config?.summaryItems || [];
        if (summaryItems.length > 0) {
            const total = summaryItems.reduce((acc, item) => ({
                present: acc.present + (item.present || 0),
                late: acc.late + (item.late || 0),
                absent: acc.absent + (item.absent || 0),
            }), { present: 0, late: 0, absent: 0 });
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(9);
            doc.setTextColor(26, 71, 49);
            doc.text(`Present: ${total.present}    Late: ${total.late}    Absent: ${total.absent}`, 14, summaryY);
        }

        const imageTop = titleY + 16;
        const availableW = pageW - 28;
        const availableH = pageH - imageTop - 14;
        if (chart.canvas) {
            const imgData = chart.canvas.toDataURL('image/png', 1.0);
            const imgProps = doc.getImageProperties(imgData);
            const ratio = Math.min(availableW / imgProps.width, availableH / imgProps.height);
            const imgW = imgProps.width * ratio;
            const imgH = imgProps.height * ratio;
            const x = (pageW - imgW) / 2;
            doc.addImage(imgData, 'PNG', x, imageTop, imgW, imgH);
        }
    });

    const totalPages = doc.internal.getNumberOfPages();
    for (let page = 1; page <= totalPages; page++) {
        doc.setPage(page);
        drawFooter(page, totalPages);
    }

    doc.save(`Attendance_Graphs_${new Date().toISOString().split('T')[0]}.pdf`);

    await autoSaveReport('PDF');
};

function updateSubjectChart() {
    const { subjectConfig } = buildAttendanceChartConfigs();
    attendanceCharts.subjectBreakdown = renderAttendanceChart(
        document.getElementById('graphAttendanceSubjectChart'),
        attendanceCharts.subjectBreakdown,
        subjectConfig
    );
}

function updateProfessorChart() {
    const { professorConfig } = buildAttendanceChartConfigs();
    attendanceCharts.professorBreakdown = renderAttendanceChart(
        document.getElementById('graphAttendanceProfessorChart'),
        attendanceCharts.professorBreakdown,
        professorConfig
    );
}

function updateSemesterChart() {
    const { semesterConfig } = buildAttendanceChartConfigs();
    attendanceCharts.semesterBreakdown = renderAttendanceChart(
        document.getElementById('graphSemesterAttendanceChart'),
        attendanceCharts.semesterBreakdown,
        semesterConfig
    );
}

function renderAllCharts() {
    updateSubjectChart();
    updateProfessorChart();
    updateSemesterChart();
}

function openGraphPreview(chartKey) {
    const overlay = document.getElementById('graphPreviewOverlay');
    const title = document.getElementById('graphPreviewTitle');
    const subtitle = document.getElementById('graphPreviewSubtitle');
    const canvas = document.getElementById('graphPreviewCanvas');
    if (!overlay || !title || !subtitle || !canvas) return;

    const configs = buildAttendanceChartConfigs();
    const configMap = {
        subject: { config: configs.subjectConfig, text: 'Expanded subject attendance view' },
        professor: { config: configs.professorConfig, text: 'Expanded professor attendance view' },
        semester: { config: configs.semesterConfig, text: 'Expanded semester share view' },
    };

    const selected = configMap[chartKey] || configMap.subject;
    const heading = chartKey === 'professor'
        ? 'Professor Attendance'
        : chartKey === 'semester'
            ? 'Semester Share'
            : 'Subject Attendance';

    title.innerHTML = `<i class="fa-solid fa-chart-column" style="color:var(--green-bright)"></i> ${heading}`;
    subtitle.textContent = selected.text;
    overlay.classList.add('on');

    graphPreviewChart = renderAttendanceChart(canvas, graphPreviewChart, selected.config);
}

function closeGraphPreview() {
    document.getElementById('graphPreviewOverlay')?.classList.remove('on');
    destroyChart(graphPreviewChart);
    graphPreviewChart = null;
}

window.openGraphPreview = openGraphPreview;
window.closeGraphPreview = closeGraphPreview;

function populateChartFilters() {
    const subMap = new Map();
    const profMap = new Map();
    const semSet = new Set();

    allAttendance.forEach((a) => {
        if (a.subject_id) subMap.set(a.subject_id, { id: a.subject_id, code: a.subject_code, name: a.subject_name });
        if (a.professor_id) profMap.set(a.professor_id, { id: a.professor_id, name: a.professor_name });
        const semLabel = getSemesterLabel(a);
        if (semLabel) semSet.add(semLabel);
    });

    const semOpts = Array.from(semSet).sort().map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');

    const chartSub = document.getElementById('chartSubjectSelect');
    if (chartSub) {
        const opts = Array.from(subMap.values()).sort((a, b) => a.code.localeCompare(b.code))
            .map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.code + ' - ' + s.name)}</option>`).join('');
        chartSub.innerHTML = `<option value="">All Subjects</option>${opts}`;
    }

    const chartProf = document.getElementById('chartProfessorSelect');
    if (chartProf) {
        const opts = Array.from(profMap.values()).sort((a, b) => a.name.localeCompare(b.name))
            .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
        chartProf.innerHTML = `<option value="">All Professors</option>${opts}`;
    }

    const chartSem = document.getElementById('chartSemesterSelect');
    const chartSubSem = document.getElementById('chartSubjectSemesterSelect');
    const chartProfSem = document.getElementById('chartProfessorSemesterSelect');

    if (chartSem) chartSem.innerHTML = `<option value="">All Semesters</option>${semOpts}`;
    if (chartSubSem) chartSubSem.innerHTML = `<option value="">All Semesters</option>${semOpts}`;
    if (chartProfSem) chartProfSem.innerHTML = `<option value="">All Semesters</option>${semOpts}`;

    chartSub?.addEventListener('change', updateSubjectChart);
    chartProf?.addEventListener('change', updateProfessorChart);
    chartSem?.addEventListener('change', updateSemesterChart);
    chartSubSem?.addEventListener('change', updateSubjectChart);
    chartProfSem?.addEventListener('change', updateProfessorChart);
}

async function loadAttendanceData() {
    let query = supabaseClient
        .from('lab_attendance')
        .select(`
            attendance_id, time_in, time_out, time_in_status, late_minutes, duration_minutes, verified_by_facial_recognition,
            students ( student_id, id_number, first_name, middle_name, last_name, course, year_level, section, profile_picture ),
            lab_sessions (
                session_id, session_date, status, actual_start_time, notes,
                lab_schedules (
                    schedule_id, section, day_of_week, start_time, end_time, semester, school_year,
                    subjects ( subject_id, subject_code, subject_name ),
                    professors ( professor_id, first_name, last_name ),
                    laboratory_rooms ( lab_id, lab_code, lab_name )
                )
            )
        `)
        .order('time_in', { ascending: false });

    try {
        const { data, error } = await query;
        if (error) throw error;

        allAttendance = (data || []).filter(d => d.lab_sessions && d.students && d.lab_sessions.lab_schedules).map(d => {
            const st = d.students || {};
            const sess = d.lab_sessions || {};
            const sch = sess.lab_schedules || {};
            const subjects = sch.subjects || {};
            const professors = sch.professors || {};
            const labs = sch.laboratory_rooms || {};
            const sessLab = parseSessionLabFromNotes(sess.notes);

            return {
                attendance_id: d.attendance_id,
                time_in: d.time_in,
                time_out: d.time_out,
                time_in_status: d.time_in_status,
                late_minutes: d.late_minutes || 0,
                duration_minutes: d.duration_minutes,
                verified_by_facial_recognition: d.verified_by_facial_recognition,
                student_id: st.student_id,
                id_number: st.id_number,
                student_name: `${st.first_name} ${st.last_name}`,
                student_full_name: `${st.first_name} ${st.middle_name || ''} ${st.last_name}`.replace(/\s+/g, ' ').trim(),
                course: st.course,
                year_level: st.year_level,
                student_section: st.section,
                profile_picture: st.profile_picture,
                initials: `${(st.first_name || '')[0] || ''}${(st.last_name || '')[0] || ''}`.toUpperCase(),
                session_id: sess.session_id,
                session_status: sess.status,
                session_date: sess.session_date,
                actual_start_time: sess.actual_start_time,
                schedule_id: sch.schedule_id,
                class_section: sch.section,
                day_of_week: sch.day_of_week,
                sched_start: sch.start_time,
                sched_end: sch.end_time,
                semester: sch.semester,
                school_year: sch.school_year,
                subject_id: subjects.subject_id,
                subject_code: subjects.subject_code,
                subject_name: subjects.subject_name,
                professor_id: professors.professor_id,
                professor_name: `${professors.first_name || ''} ${professors.last_name || ''}`.trim(),
                lab_id: labs.lab_id,
                lab_code: (sessLab && sessLab.lab_code) || labs.lab_code,
                lab_name: (sessLab && sessLab.lab_name) || labs.lab_name
            };
        });

        scheduleEnrollmentCounts = {};
        const scheduleIds = [...new Set(allAttendance.map(a => a.schedule_id).filter(Boolean))];
        if (scheduleIds.length > 0) {
            const { data: enrolledRows, error: enrolledError } = await supabaseClient
                .from('schedule_enrollments')
                .select('schedule_id, student_id')
                .eq('status', 'enrolled')
                .in('schedule_id', scheduleIds);

            if (!enrolledError) {
                const enrollmentMap = new Map();
                (enrolledRows || []).forEach((row) => {
                    if (!row.schedule_id) return;
                    if (!enrollmentMap.has(row.schedule_id)) enrollmentMap.set(row.schedule_id, new Set());
                    enrollmentMap.get(row.schedule_id).add(row.student_id);
                });
                scheduleIds.forEach((scheduleId) => {
                    scheduleEnrollmentCounts[scheduleId] = enrollmentMap.has(scheduleId) ? enrollmentMap.get(scheduleId).size : 0;
                });
            }
        }

        populateChartFilters();
        renderAllCharts();
    } catch (error) {
        console.error('Error fetching attendance graphs:', error);
        const host = window.location.hostname || '';
        if (host.includes('localhost') || host === '127.0.0.1') {
            const today = new Date();
            const yyyy = today.getFullYear();
            const mm = String(today.getMonth() + 1).padStart(2, '0');
            const dd = String(today.getDate()).padStart(2, '0');
            const dateStr = `${yyyy}-${mm}-${dd}`;
            const sampleScheduleId = 9999;

            allAttendance = [
                { attendance_id: 'm1', time_in: `${dateStr}T08:10:00`, time_out: `${dateStr}T10:00:00`, time_in_status: 'on_time', late_minutes: 0, duration_minutes: 110, verified_by_facial_recognition: false, student_id: 1, id_number: 'S1001', student_name: 'Juan Dela Cruz', student_full_name: 'Juan M Dela Cruz', course: 'BSIT', year_level: '1', student_section: 'A', profile_picture: null, initials: 'JD', session_id: 111, session_status: 'completed', session_date: dateStr, actual_start_time: `${dateStr}T08:00:00`, schedule_id: sampleScheduleId, class_section: 'A', day_of_week: 'Mon', sched_start: '08:00', sched_end: '10:00', semester: '2nd', school_year: '2025-2026', subject_id: 201, subject_code: 'COMP105', subject_name: 'Information Management', professor_id: 301, professor_name: 'Juanito Alvarez', lab_id: 401, lab_code: 'LAB1', lab_name: 'Computer Lab 1' },
                { attendance_id: 'm2', time_in: null, time_out: null, time_in_status: 'absent', late_minutes: 0, duration_minutes: null, verified_by_facial_recognition: false, student_id: 2, id_number: 'S1002', student_name: 'Maria Clara', student_full_name: 'Maria Clara', course: 'BSIT', year_level: '1', student_section: 'A', profile_picture: null, initials: 'MC', session_id: 111, session_status: 'completed', session_date: dateStr, actual_start_time: `${dateStr}T08:00:00`, schedule_id: sampleScheduleId, class_section: 'A', day_of_week: 'Mon', sched_start: '08:00', sched_end: '10:00', semester: '2nd', school_year: '2025-2026', subject_id: 201, subject_code: 'COMP105', subject_name: 'Information Management', professor_id: 301, professor_name: 'Juanito Alvarez', lab_id: 401, lab_code: 'LAB1', lab_name: 'Computer Lab 1', is_absent: true },
                { attendance_id: 'm3', time_in: `${dateStr}T09:05:00`, time_out: `${dateStr}T11:00:00`, time_in_status: 'late', late_minutes: 5, duration_minutes: 115, verified_by_facial_recognition: false, student_id: 3, id_number: 'S1003', student_name: 'Pedro Santos', student_full_name: 'Pedro Santos', course: 'BSCS', year_level: '2', student_section: 'B', profile_picture: null, initials: 'PS', session_id: 222, session_status: 'completed', session_date: dateStr, actual_start_time: `${dateStr}T09:00:00`, schedule_id: 9998, class_section: 'B', day_of_week: 'Tue', sched_start: '09:00', sched_end: '11:00', semester: '1st', school_year: '2025-2026', subject_id: 202, subject_code: 'COMP102', subject_name: 'Fundamentals of Programming (C++)', professor_id: 302, professor_name: 'Ana Reyes', lab_id: 402, lab_code: 'LAB2', lab_name: 'Computer Lab 2' }
            ];
            scheduleEnrollmentCounts = { [sampleScheduleId]: 20, 9998: 18 };
            populateChartFilters();
            renderAllCharts();
            return;
        }

        const message = error?.message || 'Unknown error';
        const box = document.querySelector('.container');
        if (box) {
            const note = document.createElement('div');
            note.className = 'controls-card';
            note.style.marginBottom = '20px';
            note.innerHTML = `<div class="fg-grid"><div class="fg"><label><i class="fa-solid fa-triangle-exclamation"></i> Error</label><div style="padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:#fff7ed;color:#9a3412;font-size:13px;line-height:1.6">Unable to load attendance data: ${escapeHtml(message)}</div></div></div>`;
            box.insertBefore(note, box.querySelector('.charts-section'));
        }
    }
}

function refreshAttendanceGraphs() {
    populateChartFilters();
    renderAllCharts();
}

document.addEventListener('DOMContentLoaded', () => {
    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
        console.warn('Supabase client not initialized on graphs page.');
    }
    fetchTodayReports();
    loadAttendanceData();
});
