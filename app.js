(() => {
  "use strict";

  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const HISTORY_KEY = "textly-ocr-history-v1";
  const $ = (id) => document.getElementById(id);
  const elements = {
    uploadTab: $("uploadTab"),
    cameraTab: $("cameraTab"),
    uploadPanel: $("uploadPanel"),
    cameraPanel: $("cameraPanel"),
    fileInput: $("fileInput"),
    dropzone: $("dropzone"),
    selectedFile: $("selectedFile"),
    fileThumb: $("fileThumb"),
    fileName: $("fileName"),
    fileSize: $("fileSize"),
    removeFile: $("removeFile"),
    extractButton: $("extractButton"),
    startCameraButton: $("startCameraButton"),
    captureButton: $("captureButton"),
    liveScanToggle: $("liveScanToggle"),
    cameraVideo: $("cameraVideo"),
    captureCanvas: $("captureCanvas"),
    cameraPlaceholder: $("cameraPlaceholder"),
    scanFrame: $("scanFrame"),
    cameraLiveIndicator: $("cameraLiveIndicator"),
    copyButton: $("copyButton"),
    resultStatus: $("resultStatus"),
    resultStatusDot: $("resultStatusDot"),
    resultEmpty: $("resultEmpty"),
    processingState: $("processingState"),
    processingTitle: $("processingTitle"),
    processingMessage: $("processingMessage"),
    progressBar: $("progressBar"),
    progressPercent: $("progressPercent"),
    resultText: $("resultText"),
    characterCount: $("characterCount"),
    clearButton: $("clearButton"),
    historyCount: $("historyCount"),
    historyHeadingCount: $("historyHeadingCount"),
    historyList: $("historyList"),
    historyEmpty: $("historyEmpty"),
    clearHistoryButton: $("clearHistoryButton"),
    toast: $("toast"),
  };

  let selectedImage = null;
  let cameraStream = null;
  let workerPromise = null;
  let scanTimer = null;
  let recognizing = false;
  let currentSource = "upload";
  let history = loadHistory();
  let toastTimer;

  function loadHistory() {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(saved) ? saved.filter((item) =>
        item && typeof item.id === "string" && typeof item.text === "string" &&
        typeof item.name === "string" && typeof item.createdAt === "string"
      ) : [];
    } catch (error) {
      console.error("Could not read saved OCR history.", error);
      return [];
    }
  }

  function persistHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (error) {
      console.error("Could not save OCR history.", error);
      showToast("History couldn't be saved. Your browser storage may be full.");
    }
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2800);
  }

  function switchSource(source) {
    currentSource = source;
    const isUpload = source === "upload";
    elements.uploadTab.classList.toggle("active", isUpload);
    elements.cameraTab.classList.toggle("active", !isUpload);
    elements.uploadTab.setAttribute("aria-selected", String(isUpload));
    elements.cameraTab.setAttribute("aria-selected", String(!isUpload));
    elements.uploadPanel.classList.toggle("hidden", !isUpload);
    elements.cameraPanel.classList.toggle("hidden", isUpload);
    if (isUpload) stopCamera();
  }

  function formatBytes(bytes) {
    return bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function chooseImage(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("Choose an image file to extract text.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showToast("This image is over 20 MB. Choose a smaller file.");
      return;
    }
    selectedImage = file;
    elements.fileName.textContent = file.name;
    elements.fileSize.textContent = formatBytes(file.size);
    if (elements.fileThumb.dataset.url) URL.revokeObjectURL(elements.fileThumb.dataset.url);
    const imageUrl = URL.createObjectURL(file);
    elements.fileThumb.style.backgroundImage = `url("${imageUrl}")`;
    elements.fileThumb.dataset.url = imageUrl;
    elements.selectedFile.classList.remove("hidden");
    elements.extractButton.disabled = false;
    elements.resultEmpty.classList.remove("hidden");
    elements.resultText.classList.add("hidden");
    elements.processingState.classList.add("hidden");
    elements.resultStatus.textContent = "Image ready to scan";
    elements.resultStatusDot.className = "result-status-dot";
  }

  function clearSelectedImage() {
    selectedImage = null;
    elements.fileInput.value = "";
    if (elements.fileThumb.dataset.url) URL.revokeObjectURL(elements.fileThumb.dataset.url);
    elements.fileThumb.style.backgroundImage = "";
    delete elements.fileThumb.dataset.url;
    elements.selectedFile.classList.add("hidden");
    elements.extractButton.disabled = true;
  }

  function setProcessing(active, message = "") {
    elements.resultEmpty.classList.toggle("hidden", active || Boolean(elements.resultText.value.trim()));
    elements.processingState.classList.toggle("hidden", !active);
    elements.resultText.classList.toggle("hidden", active || !elements.resultText.value.trim());
    elements.copyButton.disabled = active || !elements.resultText.value.trim();
    elements.clearButton.disabled = active || !elements.resultText.value.trim();
    elements.resultStatusDot.className = `result-status-dot${active ? " working" : ""}`;
    if (active) {
      elements.resultStatus.textContent = "Reading text…";
      elements.processingMessage.textContent = message || "Getting the OCR engine ready";
      elements.progressBar.style.width = "0%";
      elements.progressPercent.textContent = "0%";
    }
  }

  async function getWorker() {
    if (!window.Tesseract) {
      throw new Error("The OCR engine could not be loaded. Check your internet connection and reload the page.");
    }
    if (!workerPromise) {
      workerPromise = window.Tesseract.createWorker("eng", 1, {
        logger: (event) => {
          if (event.status) elements.processingMessage.textContent = event.status;
          if (typeof event.progress === "number") {
            const percent = Math.round(event.progress * 100);
            elements.progressBar.style.width = `${percent}%`;
            elements.progressPercent.textContent = `${percent}%`;
          }
        },
      }).catch((error) => {
        workerPromise = null;
        throw error;
      });
    }
    return workerPromise;
  }

  async function recognizeImage(image, sourceName, { live = false } = {}) {
    if (recognizing) return;
    recognizing = true;
    if (!live) {
      elements.processingTitle.textContent = "Reading your image…";
      setProcessing(true);
    } else {
      elements.resultStatus.textContent = "Live scanning…";
      elements.resultStatusDot.className = "result-status-dot working";
    }
    try {
      const worker = await getWorker();
      if (live && !elements.liveScanToggle.checked) return;
      const { data } = await worker.recognize(image);
      const text = data.text.trim();
      if (!text) {
        if (!live) {
          elements.resultText.value = "";
          elements.resultText.classList.add("hidden");
          elements.resultEmpty.classList.remove("hidden");
          elements.resultEmpty.querySelector("strong").textContent = "No text found";
          elements.resultEmpty.querySelector("span:last-child").textContent = "Try a clearer, well-lit image with readable text.";
          showToast("No text was detected. Try a clearer image.");
        }
      } else if (live) {
        if (text !== elements.resultText.value.trim()) {
          showResult(text, sourceName, false);
          elements.resultStatus.textContent = "Live scan updated";
        }
      } else {
        showResult(text, sourceName, true);
      }
    } catch (error) {
      console.error("OCR recognition failed.", error);
      if (!live) {
        elements.resultText.value = "";
        setProcessing(false);
        elements.resultStatus.textContent = "Scan failed";
        elements.resultStatusDot.className = "result-status-dot";
        showToast(error.message || "Text recognition failed. Please try again.");
      } else {
        elements.resultStatus.textContent = "Live scan error";
        showToast(error.message || "Live text recognition failed.");
        elements.liveScanToggle.checked = false;
        stopLiveScan();
      }
    } finally {
      recognizing = false;
      if (!live && elements.resultStatus.textContent !== "Scan failed") {
        setProcessing(false);
        elements.resultStatus.textContent = elements.resultText.value.trim() ? "Text extracted" : "No text detected";
        elements.resultStatusDot.className = `result-status-dot${elements.resultText.value.trim() ? " ready" : ""}`;
      }
    }
  }

  function showResult(text, sourceName, save) {
    elements.resultText.value = text;
    elements.resultText.classList.remove("hidden");
    elements.resultEmpty.classList.add("hidden");
    elements.processingState.classList.add("hidden");
    elements.copyButton.disabled = false;
    elements.clearButton.disabled = false;
    elements.characterCount.textContent = `${text.length.toLocaleString()} characters`;
    elements.resultStatus.textContent = "Text extracted";
    elements.resultStatusDot.className = "result-status-dot ready";
    if (save) addHistory(text, sourceName);
  }

  function addHistory(text, name) {
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, text, createdAt: new Date().toISOString() };
    history.unshift(item);
    history = history.slice(0, 30);
    persistHistory();
    renderHistory();
  }

  function relativeTime(dateValue) {
    const elapsed = Math.max(0, Date.now() - new Date(dateValue).getTime());
    if (!Number.isFinite(elapsed)) return "Recently";
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days < 7 ? `${days}d ago` : new Date(dateValue).toLocaleDateString();
  }

  function renderHistory() {
    elements.historyCount.textContent = String(history.length);
    elements.historyHeadingCount.textContent = String(history.length);
    elements.historyEmpty.classList.toggle("hidden", history.length > 0);
    elements.clearHistoryButton.classList.toggle("hidden", history.length === 0);
    elements.historyList.querySelectorAll(".history-item").forEach((item) => item.remove());
    const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7V5a1 1 0 0 1 1-1h2m11 0h1a1 1 0 0 1 1 1v2m0 10v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M8 9h8M8 12h8M8 15h5"/></svg>';
    for (const entry of history) {
      const row = document.createElement("article");
      row.className = "history-item";
      const iconBox = document.createElement("span");
      iconBox.className = "history-item-icon";
      iconBox.innerHTML = icon;
      const copy = document.createElement("div");
      copy.className = "history-item-copy";
      const title = document.createElement("strong");
      title.textContent = entry.name;
      const preview = document.createElement("span");
      preview.textContent = entry.text.replace(/\s+/g, " ").slice(0, 100) || "No text";
      copy.append(title, preview);
      const actions = document.createElement("div");
      actions.className = "history-item-actions";
      const time = document.createElement("span");
      time.className = "history-time";
      time.textContent = relativeTime(entry.createdAt);
      const copyButton = document.createElement("button");
      copyButton.className = "history-copy";
      copyButton.type = "button";
      copyButton.setAttribute("aria-label", `Copy text from ${entry.name}`);
      copyButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
      copyButton.addEventListener("click", () => copyText(entry.text));
      actions.append(time, copyButton);
      row.append(iconBox, copy, actions);
      row.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        showResult(entry.text, entry.name, false);
        document.querySelector(".result-column").scrollIntoView({ behavior: "smooth", block: "center" });
      });
      row.setAttribute("tabindex", "0");
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Open scan ${entry.name}`);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          showResult(entry.text, entry.name, false);
        }
      });
      elements.historyList.append(row);
    }
  }

  async function copyText(text) {
    if (!text.trim()) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        elements.resultText.value = text;
        elements.resultText.classList.remove("hidden");
        elements.resultEmpty.classList.add("hidden");
        elements.resultText.focus();
        elements.resultText.select();
        const copied = document.execCommand("copy");
        if (!copied) throw new Error("Clipboard access is unavailable. Select the text and copy it manually.");
      }
      showToast("Text copied to your clipboard.");
    } catch (error) {
      console.error("Clipboard copy failed.", error);
      showToast(error.message || "Couldn't copy text. Check clipboard permissions.");
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast("Camera access requires a supported browser on HTTPS or localhost.");
      return;
    }
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      elements.cameraVideo.srcObject = cameraStream;
      await elements.cameraVideo.play();
      elements.cameraVideo.classList.remove("hidden");
      elements.cameraPlaceholder.classList.add("hidden");
      elements.scanFrame.classList.remove("hidden");
      elements.cameraLiveIndicator.classList.remove("hidden");
      elements.startCameraButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h2l1.2-2h4.6l1.2 2h2A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-9Z"/><circle cx="12" cy="13" r="3.5"/></svg> Stop camera';
      elements.captureButton.disabled = false;
      elements.liveScanToggle.disabled = false;
      elements.startCameraButton.dataset.running = "true";
    } catch (error) {
      console.error("Camera could not be started.", error);
      const detail = error.name === "NotAllowedError"
        ? "Camera permission was denied. Allow access in your browser settings and try again."
        : error.name === "NotFoundError"
          ? "No camera was found on this device."
          : `Couldn't start the camera: ${error.message || "unknown error"}`;
      showToast(detail);
    }
  }

  function stopLiveScan() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    elements.scanFrame.classList.remove("scanning");
  }

  function stopCamera() {
    stopLiveScan();
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    elements.cameraVideo.srcObject = null;
    elements.cameraVideo.classList.add("hidden");
    elements.cameraPlaceholder.classList.remove("hidden");
    elements.scanFrame.classList.add("hidden");
    elements.cameraLiveIndicator.classList.add("hidden");
    elements.captureButton.disabled = true;
    elements.liveScanToggle.disabled = true;
    elements.liveScanToggle.checked = false;
    elements.startCameraButton.dataset.running = "false";
    elements.startCameraButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h2l1.2-2h4.6l1.2 2h2A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-9Z"/><circle cx="12" cy="13" r="3.5"/></svg> Start camera';
  }

  function captureCameraFrame() {
    const video = elements.cameraVideo;
    const canvas = elements.captureCanvas;
    if (!cameraStream || !video.videoWidth) {
      showToast("Wait for the camera preview to be ready, then try again.");
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      showToast("This browser couldn't prepare the camera image for scanning.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    recognizeImage(canvas, "Camera scan", { live: elements.liveScanToggle.checked });
  }

  function toggleLiveScan() {
    if (elements.liveScanToggle.checked) {
      elements.resultStatus.textContent = "Live scanning…";
      elements.scanFrame.classList.add("scanning");
      captureCameraFrame();
      scanTimer = setInterval(() => captureCameraFrame(), 3200);
    } else {
      stopLiveScan();
      elements.resultStatus.textContent = elements.resultText.value.trim() ? "Text extracted" : "Camera ready";
      elements.resultStatusDot.className = `result-status-dot${elements.resultText.value.trim() ? " ready" : ""}`;
    }
  }

  elements.uploadTab.addEventListener("click", () => switchSource("upload"));
  elements.cameraTab.addEventListener("click", () => switchSource("camera"));
  elements.dropzone.addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", (event) => chooseImage(event.target.files[0]));
  elements.dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropzone.classList.add("dragover");
  });
  elements.dropzone.addEventListener("dragleave", () => elements.dropzone.classList.remove("dragover"));
  elements.dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove("dragover");
    chooseImage(event.dataTransfer.files[0]);
  });
  elements.removeFile.addEventListener("click", clearSelectedImage);
  elements.extractButton.addEventListener("click", () => {
    if (selectedImage) recognizeImage(selectedImage, selectedImage.name);
  });
  elements.startCameraButton.addEventListener("click", () => {
    if (cameraStream) stopCamera();
    else startCamera();
  });
  elements.captureButton.addEventListener("click", captureCameraFrame);
  elements.liveScanToggle.addEventListener("change", toggleLiveScan);
  elements.copyButton.addEventListener("click", () => copyText(elements.resultText.value));
  elements.resultText.addEventListener("input", () => {
    const text = elements.resultText.value.trim();
    elements.characterCount.textContent = `${elements.resultText.value.length.toLocaleString()} characters`;
    elements.copyButton.disabled = !text;
    elements.clearButton.disabled = !text;
    elements.resultStatus.textContent = text ? "Edited text" : "No text";
    elements.resultStatusDot.className = `result-status-dot${text ? " ready" : ""}`;
  });
  elements.clearButton.addEventListener("click", () => {
    elements.resultText.value = "";
    elements.resultText.classList.add("hidden");
    elements.resultEmpty.classList.remove("hidden");
    elements.resultEmpty.querySelector("strong").textContent = "Your text will appear here";
    elements.resultEmpty.querySelector("span:last-child").textContent = "Choose an image or use your camera to get started.";
    elements.characterCount.textContent = "0 characters";
    elements.copyButton.disabled = true;
    elements.clearButton.disabled = true;
    elements.resultStatus.textContent = "Waiting for an image";
    elements.resultStatusDot.className = "result-status-dot";
  });
  elements.clearHistoryButton.addEventListener("click", () => {
    history = [];
    persistHistory();
    renderHistory();
  });
  window.addEventListener("pagehide", stopCamera);

  renderHistory();
})();
