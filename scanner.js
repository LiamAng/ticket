const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwqZoGSyRvOYR7Af-Xsn92WqD30kT1wjBCPMkoK3bRPvhKXr0iIDUGy-MRiLKQSBbt6sQ/exec';

let scanned = null;
let selectedCameraId = null;
let previewStream = null;
let html5QrCode = null;
let videoStream = null;
let switchDebounceTimer = null;
let blackCheckTimer = null;

const QR_BOX_SIZE = 250;

const cameraSelect = document.getElementById('camera-select');
const previewVideo = document.getElementById('preview-video');
const btnConfirm = document.getElementById('btn-confirm');
const loadingSpinner = document.getElementById('loading-spinner');
const loadingLabel = document.getElementById('loading-label');
const cameraUI = document.getElementById('camera-ui');
const blackWarning = document.getElementById('black-warning');

const screenSelect = document.getElementById('screen-select');
const screenScan = document.getElementById('screen-scan');
const qrPhase = document.getElementById('qr-phase');
const photoPhase = document.getElementById('photo-phase');
const qrStatus = document.getElementById('qr-status');
const liveVideo = document.getElementById('live-video');
const photoPreview = document.getElementById('photo-preview');
const btnPhoto = document.getElementById('btn-photo');
const btnRetake = document.getElementById('btn-retake');
const btnDone = document.getElementById('btn-done');
const photoStatus = document.getElementById('photo-status');

let cropOverlay = null;

function ensureVideoWrapper() {
    let wrapper = document.getElementById('live-video-wrapper');
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.id = 'live-video-wrapper';
        wrapper.style.cssText = 'position:relative;display:inline-block;overflow:hidden;';
        liveVideo.parentNode.insertBefore(wrapper, liveVideo);
        wrapper.appendChild(liveVideo);
    }

    if (!cropOverlay) {
        cropOverlay = document.createElement('div');
        cropOverlay.id = 'crop-overlay';
        cropOverlay.style.cssText = `
            position: absolute;
            border: 2px solid rgba(255,255,255,0.85);
            box-shadow: 0 0 0 9999px rgba(0,0,0,0.45);
            pointer-events: none;
            display: none;
            box-sizing: border-box;
        `;
        wrapper.appendChild(cropOverlay);
    }
}

function showCropOverlay() {
    ensureVideoWrapper();
    requestAnimationFrame(() => {
        const w = liveVideo.clientWidth;
        const h = liveVideo.clientHeight;
        const size = Math.min(w, h, QR_BOX_SIZE);
        const left = (w - size) / 2;
        const top = (h - size) / 2;
        cropOverlay.style.width = size + 'px';
        cropOverlay.style.height = size + 'px';
        cropOverlay.style.left = left + 'px';
        cropOverlay.style.top = top + 'px';
        cropOverlay.style.display = 'block';
    });
}

function hideCropOverlay() {
    if (cropOverlay) cropOverlay.style.display = 'none';
}

async function loadCamerasWithRetry(maxAttempts = 4) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            loadingLabel.textContent = attempt === 1
                ? 'Detecting cameras...'
                : `Retrying... (attempt ${attempt} of ${maxAttempts})`;

            const cameras = await Html5Qrcode.getCameras();

            loadingSpinner.style.display = 'none';

            if (!cameras.length) {
                loadingLabel.textContent = 'No cameras found.';
                loadingSpinner.querySelector('.spinner').style.display = 'none';
                loadingSpinner.style.display = 'flex';
                return;
            }

            cameras.forEach(cam => {
                const opt = document.createElement('option');
                opt.value = cam.id;
                opt.textContent = cam.label || cam.id;
                cameraSelect.appendChild(opt);
            });

            cameraUI.style.display = '';
            startPreview(cameraSelect.value);
            return;

        } catch (err) {
            console.warn(`Camera detection attempt ${attempt} failed:`, err);

            if (attempt < maxAttempts) {
                loadingLabel.textContent = `Attempt ${attempt} failed, retrying...`;
                await new Promise(r => setTimeout(r, 800));
            } else {
                loadingSpinner.querySelector('.spinner').style.display = 'none';
                loadingLabel.textContent = `Could not detect cameras after ${maxAttempts} attempts. Check permissions.`;
            }
        }
    }
}

loadCamerasWithRetry();

cameraSelect.addEventListener('change', () => {
    clearTimeout(switchDebounceTimer);
    clearTimeout(blackCheckTimer);
    blackWarning.style.display = 'none';

    cameraSelect.disabled = true;
    switchDebounceTimer = setTimeout(() => {
        startPreview(cameraSelect.value);
        cameraSelect.disabled = false;
    }, 800);
});

async function startPreview(cameraId) {
    blackWarning.style.display = 'none';
    clearTimeout(blackCheckTimer);

    if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); previewStream = null; }

    try {
        previewStream = await Promise.race([
            navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cameraId } } }),
            new Promise((_, rej) => setTimeout(() => rej('Timeout'), 3000))
        ]);
        previewVideo.srcObject = previewStream;

        previewVideo.onloadeddata = () => {
            btnConfirm.disabled = false;
            blackCheckTimer = setTimeout(() => checkIfBlack(previewVideo), 1000);
        };
    } catch (err) {
        console.log(err);
        btnConfirm.disabled = false;
        blackWarning.textContent = '⚠ Could not access camera. Try another.';
        blackWarning.style.display = '';
    }
}

function checkIfBlack(videoEl) {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, 64, 64);
    const pixels = ctx.getImageData(0, 0, 64, 64).data;
    let total = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        total += pixels[i] + pixels[i + 1] + pixels[i + 2];
    }
    const avg = total / ((pixels.length / 4) * 3);
    if (avg < 25) {
        blackWarning.textContent = 'Camera not working? Try switching to another camera.';
        blackWarning.style.display = '';
    }
}

btnConfirm.addEventListener('click', () => {
    selectedCameraId = cameraSelect.value;
    clearTimeout(blackCheckTimer);
    clearTimeout(switchDebounceTimer);
    if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); previewStream = null; }
    previewVideo.srcObject = null;

    screenSelect.classList.remove('active');
    screenScan.classList.add('active');
    startQrScanning();
});

function startQrScanning() {
    hideCropOverlay();
    qrPhase.style.display = '';
    photoPhase.style.display = 'none';
    document.getElementById('qr-reader').innerHTML = '';

    html5QrCode = new Html5Qrcode('qr-reader');
    html5QrCode.start(
        selectedCameraId,
        { fps: 10, qrbox: QR_BOX_SIZE },
        onQrDetected,
        () => { }
    );
    qrStatus.textContent = 'Scanning for QR code...';
}

async function startCamera() {
    qrPhase.style.display = 'none';
    photoPhase.style.display = '';
    photoPreview.style.display = 'none';
    btnPhoto.style.display = '';
    btnDone.style.display = 'none';
    btnRetake.style.display = 'none';
    liveVideo.style.display = 'block';
    photoStatus.textContent = `QR: "${scanned}" — take a photo then press Done.`;

    videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
            deviceId: { exact: selectedCameraId },
            width: { ideal: 3840 },
            height: { ideal: 2160 }
        }
    });
    liveVideo.srcObject = videoStream;

    liveVideo.onloadeddata = () => showCropOverlay();
}

async function onQrDetected(text) {
    await html5QrCode.stop();
    html5QrCode.clear();
    html5QrCode = null;
    if (text.length !== 24) {
        alert('Invalid QR code detected. Please try again.');
        startQrScanning();
        return;
    }

    text = decryptSecureText(text);
    
    qrStatus.textContent = 'Checking for duplicate…';
    try {
        const res = await fetch(`${APPS_SCRIPT_URL}?action=check&qr=${encodeURIComponent(text)}`);
        const json = await res.json();
        console.log('Duplicate check response:', json);
        if (json.exists) {
            await showDuplicateModal(text, json.photo);
            startQrScanning();
            return;
        }
    } catch (err) {
        console.warn('Duplicate check failed, proceeding anyway:', err);
    }

    scanned = text;
    startCamera();
}

async function capturePhoto() {
    const track = videoStream.getVideoTracks()[0];

    if ('ImageCapture' in window) {
        try {
            const imageCapture = new ImageCapture(track);
            const blob = await imageCapture.takePhoto();
            return await createImageBitmap(blob);
        } catch (err) {
            console.warn('ImageCapture.takePhoto() failed, falling back to video frame:', err);
        }
    }

    return await createImageBitmap(liveVideo);
}

function canvasToCompressedJpeg(canvas, targetKB = 30, minQuality = 0) {
    return new Promise((resolve) => {
        let quality = 1;

        function attempt() {
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            const sizeKB = Math.round((dataUrl.length * 3) / 4 / 1024);

            if (sizeKB <= targetKB || quality <= minQuality) {
                resolve({ dataUrl, sizeKB, quality });
            } else {
                quality -= 0.05;
                attempt();
            }
        }

        attempt();
    });
}

btnPhoto.addEventListener('click', async () => {
    btnPhoto.disabled = true;
    photoStatus.textContent = 'Capturing...';

    try {
        const bitmap = await capturePhoto();

        const nativeW = bitmap.width;
        const nativeH = bitmap.height;
        const displayW = liveVideo.clientWidth;
        const displayH = liveVideo.clientHeight;

        const scaleX = nativeW / displayW;
        const scaleY = nativeH / displayH;

        const displayBoxSize = Math.min(displayW, displayH, QR_BOX_SIZE);
        const cropX = Math.round(((displayW - displayBoxSize) / 2) * scaleX);
        const cropY = Math.round(((displayH - displayBoxSize) / 2) * scaleY);
        const cropSize = Math.round(displayBoxSize * scaleX);

        const canvas = document.createElement('canvas');
        canvas.width = cropSize;
        canvas.height = cropSize;
        canvas.getContext('2d').drawImage(bitmap, cropX, cropY, cropSize, cropSize, 0, 0, cropSize, cropSize);
        bitmap.close();

        const { dataUrl, sizeKB, quality } = await canvasToCompressedJpeg(canvas, 30);

        hideCropOverlay();
        photoPreview.src = dataUrl;
        photoPreview.style.display = 'block';
        liveVideo.style.display = 'none';
        btnPhoto.style.display = 'none';
        btnDone.style.display = '';
        btnRetake.style.display = '';

        photoStatus.textContent = `Photo captured — ${sizeKB} KB (quality ${quality.toFixed(2)})`;
        console.log('Photo captured:', sizeKB + 'KB', 'quality:', quality);

    } catch (err) {
        console.error('Photo capture failed:', err);
        photoStatus.textContent = '⚠ Failed to capture photo. Try again.';
    } finally {
        btnPhoto.disabled = false;
    }
});

btnDone.addEventListener('click', async () => {
    btnDone.disabled = true;
    photoStatus.textContent = 'Saving…';

    if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
    liveVideo.srcObject = null;

    try {
        const res = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({
                action: 'submit',
                qr: scanned,
                photo: photoPreview.src
            })
        });
        const json = await res.json();

        if (!json.ok) throw new Error(json.error || 'Unknown error from Apps Script');

        photoStatus.textContent = '✓ Saved!';
        console.log('Submitted row:', scanned);
    } catch (err) {
        console.error('Submit failed:', err);
        alert(`⚠ Failed to save to Google Sheets: ${err.message}`);
    }

    photoPreview.src = '';
    scanned = null;
    btnDone.disabled = false;
    startQrScanning();
});

btnRetake.addEventListener('click', () => {
    startCamera();
});

function decryptSecureText(encryptedText, seed = "tcmscrownandgloryforacause") {
    const binaryString = atob(encryptedText);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = bytes[i] ^ seed.charCodeAt(i % seed.length);
    }
    const decoder = new TextDecoder();
    let result = decoder.decode(bytes);
    return result.replace(/\0/g, '').trim();
}

function showDuplicateModal(qrText, imageData) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 9999;
            background: rgba(0,0,0,0.75);
            display: flex; align-items: center; justify-content: center;
            padding: 16px; box-sizing: border-box;
        `;

        const box = document.createElement('div');
        box.style.cssText = `
            background: #fff; border-radius: 12px; padding: 24px;
            max-width: 360px; width: 100%; text-align: center;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        `;

        const title = document.createElement('p');
        title.style.cssText = 'margin: 0 0 6px; font-size: 1.1em; font-weight: bold; color: #c0392b;';
        title.textContent = '⚠ Already Recorded';

        const sub = document.createElement('p');
        sub.style.cssText = 'margin: 0 0 14px; font-size: 0.9em; color: #555; word-break: break-all;';
        sub.textContent = qrText;

        const img = document.createElement('img');
        img.style.cssText = 'width: 100%; border-radius: 8px; margin-bottom: 16px; background: #eee; min-height: 120px; object-fit: cover;';
        img.alt = 'Previously recorded photo';

        if (imageData) {
            img.src = imageData;
        } else {
            img.style.display = 'none';
        }

        const btn = document.createElement('button');
        btn.textContent = 'OK, Resume Scanning';
        btn.style.cssText = `
            padding: 10px 24px; font-size: 1em; border: none;
            border-radius: 8px; background: #2980b9; color: #fff;
            cursor: pointer; width: 100%;
        `;
        btn.onclick = () => { document.body.removeChild(overlay); resolve(); };

        box.appendChild(title);
        box.appendChild(sub);
        box.appendChild(img);
        box.appendChild(btn);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    });
}