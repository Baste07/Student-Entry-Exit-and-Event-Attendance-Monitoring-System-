// Shared, presentation-only wording for the Event Attendance face and QR scanners.
(function (root) {
    function forOutcome(type, attendanceStatus) {
        if (type === 'time_in' || type === 'IN') {
            return attendanceStatus === 'late'
                ? { title: 'Late Attendance Recorded', message: 'Time In successfully recorded as Late.', badge: 'LATE TIME IN' }
                : { title: 'Attendance Recorded', message: 'Time In successfully recorded.', badge: 'TIME IN RECORDED' };
        }
        if (type === 'time_out' || type === 'OUT') {
            return { title: 'Time Out Recorded', message: 'Time Out successfully recorded.', badge: 'TIME OUT RECORDED' };
        }
        if (type === 'time_out_unavailable' || type === 'TIME_OUT_UNAVAILABLE') {
            return { title: 'Cannot Time Out Yet', message: 'Time Out is not yet available for this event.', badge: 'TIME OUT UNAVAILABLE' };
        }
        if (type === 'already_recorded' || type === 'ATTENDANCE_COMPLETE') {
            return { title: 'Attendance Already Completed', message: 'Time In and Time Out are already recorded for this event.', badge: 'ALREADY COMPLETED' };
        }
        if (type === 'not_participant' || type === 'NOT_REGISTERED') {
            return { title: 'Not Part of Event', message: 'You are not registered for any event.', badge: 'NOT REGISTERED' };
        }
        if (type === 'event_not_started' || type === 'EVENT_NOT_STARTED') {
            return { title: 'Event Not Started Yet', message: 'Your next registered event has not started yet.', badge: 'UPCOMING EVENT' };
        }
        if (type === 'no_active_event' || type === 'NO_ACTIVE_EVENT') {
            return { title: 'No Active Event', message: 'You are not registered for an active or upcoming event.', badge: 'NO ACTIVE EVENT' };
        }
        return null;
    }

    const feedback = { forOutcome };
    root.EventAttendanceFeedback = feedback;
    if (typeof module !== 'undefined' && module.exports) module.exports = feedback;
})(typeof window !== 'undefined' ? window : globalThis);
