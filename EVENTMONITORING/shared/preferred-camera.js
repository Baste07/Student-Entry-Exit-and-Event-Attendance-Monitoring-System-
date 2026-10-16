/* Camera ordering shared by the LOCAL_GATE QR scanners. Labels need camera permission. */
(function (global) {
    'use strict';

    const LOCAL_LABEL = /integrated|built[ -]?in|internal|facetime|face time|laptop|front camera/i;
    const EXTERNAL_LABEL = /\busb\b|external|webcam|\bcdr\b|hd camera|hd pro|logitech|brio|document camera/i;

    function classify(label) {
        if (LOCAL_LABEL.test(label || '')) return 'local';
        if (EXTERNAL_LABEL.test(label || '')) return 'external';
        return 'unknown';
    }

    function orderVideoInputs(devices) {
        const seen = new Set();
        const rank = { external: 0, unknown: 1, local: 2 };
        return (devices || []).filter(device => device.kind === 'videoinput').map((device, index) => ({
            id: device.deviceId || device.id || '',
            label: device.label || '',
            type: classify(device.label),
            index
        })).filter(device => {
            if (!device.id || seen.has(device.id)) return false;
            seen.add(device.id);
            return true;
        }).sort((a, b) => rank[a.type] - rank[b.type] || a.index - b.index);
    }

    function cameraError(error) {
        const name = `${error?.name || ''} ${error?.message || ''}`;
        if (/NotAllowed|Permission|SecurityError/i.test(name)) return new Error('CAMERA_PERMISSION_DENIED');
        if (/NotFound|DevicesNotFound/i.test(name)) return new Error('NO_CAMERA_FOUND');
        return error;
    }

    async function listVideoInputs(mediaDevices = global.navigator?.mediaDevices) {
        if (!mediaDevices?.getUserMedia) throw new Error('CAMERA_UNSUPPORTED');
        let devices = [];
        try {
            if (mediaDevices.enumerateDevices) devices = await mediaDevices.enumerateDevices();
        } catch (error) {
            throw cameraError(error);
        }
        const videos = devices.filter(device => device.kind === 'videoinput');
        let permissionGranted = false;
        if (!videos.length || videos.some(device => !device.label)) {
            let stream;
            try {
                stream = await mediaDevices.getUserMedia({ video: true, audio: false });
                permissionGranted = true;
            } catch (error) {
                throw cameraError(error);
            } finally {
                stream?.getTracks().forEach(track => track.stop());
            }
            if (mediaDevices.enumerateDevices) {
                try { devices = await mediaDevices.enumerateDevices(); }
                catch (error) { throw cameraError(error); }
            }
        }
        const ordered = orderVideoInputs(devices);
        if (!ordered.length && mediaDevices.enumerateDevices && !permissionGranted) throw new Error('NO_CAMERA_FOUND');
        return ordered; // Empty only on browsers without enumerateDevices: use facing-mode fallback.
    }

    global.PreferredCamera = { classify, orderVideoInputs, listVideoInputs };
})(window);
