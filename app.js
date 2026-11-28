const video = document.getElementById("video");
const canvas = document.getElementById("outputCanvas");
const ctx = canvas ? canvas.getContext("2d") : null;
const statusEl = document.getElementById("status");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton"); // ダミー

const SERVER_URL_STORAGE_KEY = "findrone_colab_server_url";
const CAMERA_ID_STORAGE_KEY = "findrone_colab_camera_id";
const AUTO_CONNECT_KEY = "findrone_colab_auto_connect";
const NOTIFY_ENABLED_KEY = "findrone_notify_enabled";
const ALWAYS_CAMERA_KEY = "findrone_always_show_camera";

const NOTIFY_REPEAT_COUNT = 10;

let isSearching = false;
let searchTimer = null;
let isRequestInFlight = false;
let isUpdatingTarget = false;
let targetUpdateSafetyTimer = null;
let lastSaveTime = 0;
let currentFinalizedKeyword = "";
let latestDetectedObjectName = "";
let hasAutoConnected = false;

// カメラ表示状態（true = 表示中 / 閉じるボタン表示, false = 閉じ中 / カメラを起動ボタン表示）
let isCameraViewOpen = true;
let isAlwaysCameraEnabled = true;

// 通知（アプリ内トースト＆Web Audio通知音）用
let isNotificationEnabled = false;
let notifySoundStateByObject = {};
let audioCtx = null;

// 物体名ごとの履歴データ
let historyByObject = {};
let selectedObjectFolder = null;
let unreadPhotosCount = 0;

function formatFoundTime(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${min}:${ss}`;
}

function setStatus(text, color = "#766587") {
  if (statusEl) {
    statusEl.innerText = text;
    statusEl.style.color = color;
  }
}

function setConnectionStatus(text, color = "#766587") {
  const connStatus = document.getElementById("connectionStatus");
  if (connStatus) {
    connStatus.innerText = text;
    connStatus.style.color = color;
  }
}

function syncSearchVisualState() {
  const cameraCard = document.getElementById("cameraCard");
  if (cameraCard) cameraCard.classList.toggle("is-searching", isSearching);

  if (startButton) {
    if (isSearching) {
      startButton.innerHTML = `<i class="bi bi-stop-fill"></i><span>探索終了</span>`;
      startButton.classList.add("is-stop");
    } else {
      startButton.innerHTML = `<i class="bi bi-play-fill"></i><span>探索開始</span>`;
      startButton.classList.remove("is-stop");
    }
  }
}

function syncCameraViewUi() {
  const overlay = document.getElementById("cameraClosedOverlay");
  const toggleBtn = document.getElementById("cameraToggleBtn");

  if (video) {
    video.style.opacity = isCameraViewOpen ? "1" : "0";
  }
  if (canvas) {
    canvas.style.opacity = isCameraViewOpen ? "1" : "0";
  }
  if (overlay) {
    overlay.style.display = isCameraViewOpen ? "none" : "flex";
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle("is-camera-open", isCameraViewOpen);
    toggleBtn.innerHTML = isCameraViewOpen
      ? `<i class="bi bi-camera-video-off"></i><span>閉じる</span>`
      : `<i class="bi bi-camera-video-fill"></i><span>カメラを起動</span>`;
  }
}

window.toggleCameraView = function () {
  isCameraViewOpen = !isCameraViewOpen;
  syncCameraViewUi();
};

function syncAlwaysCameraUi() {
  const onBtn = document.getElementById("alwaysCamOnBtn");
  const offBtn = document.getElementById("alwaysCamOffBtn");
  if (onBtn) onBtn.classList.toggle("is-selected", isAlwaysCameraEnabled);
  if (offBtn) offBtn.classList.toggle("is-selected", !isAlwaysCameraEnabled);
}

window.setAlwaysCameraEnabled = function (enabled) {
  isAlwaysCameraEnabled = Boolean(enabled);
  syncAlwaysCameraUi();
};

window.toggleAlwaysCameraSetting = function () {
  isAlwaysCameraEnabled = !isAlwaysCameraEnabled;
  syncAlwaysCameraUi();
};

function updateUnreadPhotosBadge() {
  const badge = document.getElementById("unreadPhotosBadge");
  if (!badge) return;

  if (unreadPhotosCount > 0) {
    badge.innerText = unreadPhotosCount > 99 ? "99+" : String(unreadPhotosCount);
    badge.style.display = "inline-block";
  } else {
    badge.innerText = "0";
    badge.style.display = "none";
  }
}

function hideFoundBannerAndBadge() {
  const toastEl = document.getElementById("foundToast");
  const toastTextEl = document.getElementById("foundToastText");
  const badge = document.getElementById("detectedCountBadge");

  latestDetectedObjectName = "";
  if (toastTextEl) toastTextEl.innerText = "";
  if (toastEl) {
    toastEl.style.display = "flex";
    toastEl.classList.remove("is-visible");
  }
  if (badge) {
    badge.innerText = "×0";
    badge.style.display = "none";
  }
}

function updateBannerAndCount(detections) {
  const toastEl = document.getElementById("foundToast");
  const toastTextEl = document.getElementById("foundToastText");
  const badge = document.getElementById("detectedCountBadge");
  if (!toastEl || !toastTextEl || !badge) return;

  if (isUpdatingTarget || !Array.isArray(detections) || detections.length === 0) {
    hideFoundBannerAndBadge();
    return;
  }

  const primary = detections[0];
  const objectName = String(primary.label || currentFinalizedKeyword || "未分類").trim();
  const confText = primary.confidence !== undefined ? ` (${primary.confidence})` : "";
  const count = detections.length;

  latestDetectedObjectName = objectName;
  toastTextEl.innerText = `「${objectName}」を発見しました${confText}`;
  toastEl.style.display = "flex";
  toastEl.classList.add("is-visible");

  if (count > 0) {
    badge.innerText = `×${count}`;
    badge.style.display = "inline-block";
  } else {
    badge.innerText = "×0";
    badge.style.display = "none";
  }
}

window.openFoundObjectFolder = function () {
  unreadPhotosCount = 0;
  updateUnreadPhotosBadge();
  const targetFolder =
    latestDetectedObjectName && historyByObject[latestDetectedObjectName]
      ? latestDetectedObjectName
      : null;
  selectedObjectFolder = targetFolder;
  renderHistoryModal();
  const modal = document.getElementById("historyFolderModal");
  if (modal) modal.style.display = "flex";
};

function clearBoundingBoxCanvas() {
  if (ctx && canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  hideFoundBannerAndBadge();
}

function updateNotificationUi() {
  const onBtn = document.getElementById("notifyOnBtn");
  const offBtn = document.getElementById("notifyOffBtn");
  if (onBtn) onBtn.classList.toggle("is-selected", isNotificationEnabled);
  if (offBtn) offBtn.classList.toggle("is-selected", !isNotificationEnabled);
}

window.setNotificationEnabled = function (enabled) {
  isNotificationEnabled = Boolean(enabled);
  if (isNotificationEnabled) unlockAudioContext();
  updateNotificationUi();
};

window.toggleNotificationSetting = function () {
  if (isNotificationEnabled) {
    isNotificationEnabled = false;
  } else {
    isNotificationEnabled = true;
    unlockAudioContext();
  }
  updateNotificationUi();
};

function resetFoundNotifyState() {
  notifySoundStateByObject = {};
}

function unlockAudioContext() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
  } catch (err) {
    console.warn("AudioContextの初期化に失敗:", err);
  }
}

function playFoundSound() {
  if (!isNotificationEnabled) return;
  try {
    unlockAudioContext();
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    const notes = [
      { freq: 1046.50, start: 0.0, duration: 0.09 },
      { freq: 1046.50, start: 0.15, duration: 0.12 },
    ];

    notes.forEach((n) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(n.freq, now + n.start);

      gain.gain.setValueAtTime(0.001, now + n.start);
      gain.gain.linearRampToValueAtTime(0.22, now + n.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.start + n.duration);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start(now + n.start);
      osc.stop(now + n.start + n.duration + 0.02);
    });
  } catch (err) {
    console.warn("通知音の再生に失敗:", err);
  }
}

function tryPlaySoundForObject(objectName) {
  if (!isNotificationEnabled) return;

  const key = (objectName || currentFinalizedKeyword || "未分類").trim();
  if (!notifySoundStateByObject[key]) {
    notifySoundStateByObject[key] = { hasPlayedOnce: false, count: 0 };
  }

  const state = notifySoundStateByObject[key];
  if (!state.hasPlayedOnce) {
    state.hasPlayedOnce = true;
    state.count = 0;
    playFoundSound();
    return;
  }

  state.count += 1;
  if (state.count < NOTIFY_REPEAT_COUNT) return;
  state.count = 0;
  playFoundSound();
}

function beginTargetLoadingState() {
  isUpdatingTarget = true;
  clearBoundingBoxCanvas();
  if (targetUpdateSafetyTimer) {
    clearTimeout(targetUpdateSafetyTimer);
  }
  targetUpdateSafetyTimer = setTimeout(() => {
    isUpdatingTarget = false;
  }, 10000);
}

function endTargetLoadingState() {
  isUpdatingTarget = false;
  if (targetUpdateSafetyTimer) {
    clearTimeout(targetUpdateSafetyTimer);
    targetUpdateSafetyTimer = null;
  }
  clearBoundingBoxCanvas();
}

window.goToTab = function (tabName) {
  document.querySelectorAll(".tab-content").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((el) => el.classList.remove("active"));

  const targetTab = document.getElementById(`${tabName}Tab`);
  const targetNav = document.getElementById(`nav-${tabName}`);
  if (targetTab) targetTab.classList.add("active");
  if (targetNav) targetNav.classList.add("active");

  if (tabName === "search") {
    isCameraViewOpen = isAlwaysCameraEnabled;
    syncCameraViewUi();
  }
};

function buildBaseUrl(rawInput) {
  let cleaned = (rawInput || "").trim().replace(/\/+$/, "");
  if (!cleaned) return "";
  if (/^https?:\/\//i.test(cleaned)) {
    return cleaned;
  }
  return `http://${cleaned}:5000`;
}

function initSavedSettings() {
  const serverIpInput = document.getElementById("serverIp");
  const pcIdInput = document.getElementById("pcIdInput");

  try {
    const savedUrl = localStorage.getItem(SERVER_URL_STORAGE_KEY);
    const savedId = localStorage.getItem(CAMERA_ID_STORAGE_KEY);
    const savedNotifyEnabled = localStorage.getItem(NOTIFY_ENABLED_KEY);
    const savedAlwaysCamera = localStorage.getItem(ALWAYS_CAMERA_KEY);

    if (savedUrl && serverIpInput) serverIpInput.value = savedUrl;
    if (savedId && pcIdInput) pcIdInput.value = savedId;
    if (savedNotifyEnabled === "true") {
      isNotificationEnabled = true;
    }
    if (savedAlwaysCamera !== null) {
      isAlwaysCameraEnabled = savedAlwaysCamera === "true";
    }
  } catch (err) {
    console.warn("設定の初期化に失敗:", err);
  }

  isCameraViewOpen = isAlwaysCameraEnabled;
  updateNotificationUi();
  syncAlwaysCameraUi();
  syncCameraViewUi();
  hideFoundBannerAndBadge();
  updateUnreadPhotosBadge();
  syncSearchVisualState();
}

function tryAutoConnectIfNeeded() {
  if (hasAutoConnected) return;
  try {
    const savedUrl = (localStorage.getItem(SERVER_URL_STORAGE_KEY) || "").trim();
    const savedId = (localStorage.getItem(CAMERA_ID_STORAGE_KEY) || "").trim();
    const shouldAuto = localStorage.getItem(AUTO_CONNECT_KEY) === "true";

    if (shouldAuto && savedUrl && savedId) {
      hasAutoConnected = true;
      window.connectToPC();
    }
  } catch (err) {
    console.warn("自動接続判定に失敗:", err);
  }
}

window.saveAllSettings = function () {
  const serverIpInput = document.getElementById("serverIp");
  const pcIdInput = document.getElementById("pcIdInput");

  const rawUrl = serverIpInput ? serverIpInput.value.trim() : "";
  const rawId = pcIdInput ? pcIdInput.value.trim() : "";

  try {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, rawUrl);
    localStorage.setItem(CAMERA_ID_STORAGE_KEY, rawId);
    localStorage.setItem(AUTO_CONNECT_KEY, "true");
    localStorage.setItem(NOTIFY_ENABLED_KEY, String(isNotificationEnabled));
    localStorage.setItem(ALWAYS_CAMERA_KEY, String(isAlwaysCameraEnabled));

    isCameraViewOpen = isAlwaysCameraEnabled;
    syncCameraViewUi();

    setConnectionStatus("設定を保存しました。接続処理を実行中...", "#047857");
    if (rawId) {
      window.connectToPC();
    }
    alert("設定を保存しました！");
  } catch (err) {
    console.warn("保存に失敗:", err);
    alert("保存中にエラーが発生しました。");
  }
};

const peer = typeof Peer !== "undefined" ? new Peer() : null;
let conn = null;
let webcamRunning = false;
let html5QrCode = null;

if (peer) {
  peer.on("open", (id) => {
    console.log("スマホ側 Peer ID:", id);
    tryAutoConnectIfNeeded();
  });

  peer.on("call", (call) => {
    call.answer();
    call.on("stream", (remoteStream) => {
      if (video) {
        video.srcObject = remoteStream;
      }
      webcamRunning = true;
      setStatus(`ステータス: 探索中... (${currentFinalizedKeyword})`, "#047857");
    });
  });

  peer.on("error", (err) => {
    console.error("Peerインスタンスエラー:", err);
  });
}

window.connectToServerOnly = function () {
  const serverIpInput = document.getElementById("serverIp");
  const url = serverIpInput ? serverIpInput.value.trim() : "";
  if (!url) {
    alert("サーバIDを入力してください！");
    return;
  }
  try {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, url);
  } catch (e) {}
  setConnectionStatus("サーバIDを保存しました", "#047857");
  alert("サーバIDを登録しました");
};

window.connectToPC = function () {
  const pcIdInput = document.getElementById("pcIdInput");
  const pcId = pcIdInput ? pcIdInput.value.trim() : "";
  if (!pcId) {
    alert("カメラIDを入力してください！");
    return;
  }
  if (!peer) {
    alert("PeerJSの読み込みに失敗しました。");
    return;
  }

  setStatus("ステータス: カメラに接続中...", "#b45309");
  setConnectionStatus("ステータス: カメラに接続中...", "#b45309");

  if (conn) {
    try {
      conn.close();
    } catch (e) {}
  }

  conn = peer.connect(pcId);
  conn.on("open", () => {
    setStatus("ステータス: 接続完了", "#047857");
    setConnectionStatus("ステータス: 接続完了", "#047857");
    if (startButton) {
      startButton.disabled = false;
    }
    syncSearchVisualState();
  });

  conn.on("error", (err) => {
    console.error("Peer接続エラー:", err);
    setStatus("エラー: 接続に失敗しました", "#e11d48");
    setConnectionStatus("ステータス: 接続に失敗しました", "#e11d48");
  });
};

let isScanning = false;
window.toggleQrScanner = async function () {
  const btn = document.getElementById("btn-qr");
  const readerContainer = document.getElementById("qr-reader");
  if (!readerContainer) return;

  if (!isScanning) {
    if (typeof Html5Qrcode === "undefined") {
      alert("QRライブラリの読み込みに失敗しました。");
      return;
    }

    readerContainer.style.display = "block";
    if (btn) {
      btn.innerHTML = `<i class="bi bi-stop-circle-fill"></i><span>停止</span>`;
      btn.classList.add("is-stop");
    }
    isScanning = true;

    try {
      if (!html5QrCode) {
        html5QrCode = new Html5Qrcode("qr-reader");
      } else if (html5QrCode.isScanning) {
        await html5QrCode.stop();
      }

      await html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 170, height: 170 }, aspectRatio: 1.0 },
        async (decodedText) => {
          const pcIdInput = document.getElementById("pcIdInput");
          if (pcIdInput) pcIdInput.value = decodedText.trim();

          if (html5QrCode && html5QrCode.isScanning) {
            try {
              await html5QrCode.stop();
            } catch (e) {}
          }
          isScanning = false;
          if (btn) {
            btn.innerHTML = `<i class="bi bi-qr-code-scan"></i><span>QRコード読み取り</span>`;
            btn.classList.remove("is-stop");
          }
          readerContainer.style.display = "none";
          setStatus("IDを取得しました。設定を保存するか接続を押してください", "#047857");
          setConnectionStatus("IDを取得しました。「設定を保存」または「接続」を押してください", "#047857");
        },
        () => {}
      );
    } catch (err) {
      console.error(err);
      isScanning = false;
      if (btn) {
        btn.innerHTML = `<i class="bi bi-qr-code-scan"></i><span>QRコード読み取り</span>`;
        btn.classList.remove("is-stop");
      }
      readerContainer.style.display = "none";
    }
  } else {
    isScanning = false;
    if (btn) {
      btn.innerHTML = `<i class="bi bi-qr-code-scan"></i><span>QRコード読み取り</span>`;
      btn.classList.remove("is-stop");
    }
    if (html5QrCode && html5QrCode.isScanning) {
      html5QrCode
        .stop()
        .then(() => {
          readerContainer.style.display = "none";
        })
        .catch(() => {
          readerContainer.style.display = "none";
        });
    } else {
      readerContainer.style.display = "none";
    }
  }
};

window.startQrScanner = () => !isScanning && window.toggleQrScanner();
window.stopQrScanner = () => isScanning && window.toggleQrScanner();

// ================= 検索ワード翻訳（決定ボタン） =================
window.updateTarget = async function () {
  if (isNotificationEnabled) unlockAudioContext();
  const serverIpInput = document.getElementById("serverIp");
  const inputElement = document.getElementById("targetObject");
  const rawServerInput = serverIpInput ? serverIpInput.value.trim() : "";
  const keyword = inputElement ? inputElement.value.trim() : "";

  if (!keyword) {
    alert("探す物体を入力してください！");
    return;
  }

  if (!rawServerInput) {
    alert("サーバIDを設定画面で入力してください！");
    goToTab("setting");
    if (serverIpInput) serverIpInput.focus();
    return;
  }

  beginTargetLoadingState();

  const baseUrl = buildBaseUrl(rawServerInput);
  setStatus("サーバで変換中...", "#b45309");

  try {
    const response = await fetch(`${baseUrl}/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({ keyword: keyword }),
    });

    if (!response.ok) throw new Error("翻訳エラー");

    const data = await response.json();
    const translatedWord = (data.translated || keyword).trim();

    if (inputElement) inputElement.value = translatedWord;
    currentFinalizedKeyword = translatedWord;
    syncSearchVisualState();

    if (isSearching) {
      setStatus(`「${currentFinalizedKeyword}」を探索中...`, "#047857");
    } else {
      setStatus(`「${keyword}」→ [${currentFinalizedKeyword}] に設定しました`, "#047857");
    }
  } catch (err) {
    console.error(err);
    currentFinalizedKeyword = keyword;
    syncSearchVisualState();
    setStatus(`変換に失敗しました（「${currentFinalizedKeyword}」を使用）`, "#e11d48");
  } finally {
    endTargetLoadingState();
  }
};

// ================= 探索スタート・ストップ =================
window.startDetection = async function () {
  if (isNotificationEnabled) unlockAudioContext();
  if (!isSearching) {
    const serverIpInput = document.getElementById("serverIp");
    const inputElement = document.getElementById("targetObject");
    const rawServerInput = serverIpInput ? serverIpInput.value.trim() : "";
    const inputVal = inputElement ? inputElement.value.trim() : "";

    if (!rawServerInput) {
      alert("サーバIDを設定画面で入力してください！");
      goToTab("setting");
      return;
    }
    if (!inputVal && !currentFinalizedKeyword) {
      alert("探す物体を入力してください！");
      if (inputElement) inputElement.focus();
      return;
    }
    if (!conn || !conn.open) {
      alert("先に設定画面から接続してください！");
      goToTab("setting");
      return;
    }

    if (inputVal) {
      await window.updateTarget();
    }

    resetFoundNotifyState();

    conn.send({
      action: "start",
      keyword: currentFinalizedKeyword,
      smartphoneId: peer ? peer.id : "",
    });

    isSearching = true;
    isCameraViewOpen = true;
    syncCameraViewUi();
    syncSearchVisualState();
    setStatus(`「${currentFinalizedKeyword}」を探索中...`, "#047857");

    searchTimer = setInterval(async () => {
      if (!isSearching || isUpdatingTarget || isRequestInFlight || !video || video.videoWidth === 0) return;
      await sendFrameToPC(serverIpInput ? serverIpInput.value.trim() : "", currentFinalizedKeyword);
    }, 500);
  } else {
    isSearching = false;
    syncSearchVisualState();
    clearInterval(searchTimer);
    resetFoundNotifyState();
    endTargetLoadingState();

    if (conn && conn.open) conn.send({ action: "stop" });

    webcamRunning = false;
    if (video && video.srcObject) {
      video.srcObject.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    clearBoundingBoxCanvas();

    setStatus("ステータス: 停止しました", "#766587");
  }
};

window.stopDetection = () => isSearching && window.startDetection();

// ================= サーバへ画像送信 ＆ 検出 =================
async function sendFrameToPC(serverInput, keyword) {
  if (isUpdatingTarget || !keyword) return;
  isRequestInFlight = true;
  const requestedKeyword = keyword;
  try {
    const baseUrl = buildBaseUrl(serverInput);
    if (!baseUrl || !video || !video.videoWidth || !video.videoHeight) {
      return;
    }

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = 320;
    tempCanvas.height = Math.round(video.videoHeight * (320 / video.videoWidth));
    const tCtx = tempCanvas.getContext("2d");
    tCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);

    const blob = await new Promise((resolve) =>
      tempCanvas.toBlob(resolve, "image/jpeg", 0.6)
    );
    if (!blob) {
      return;
    }

    if (isUpdatingTarget || requestedKeyword !== currentFinalizedKeyword) {
      clearBoundingBoxCanvas();
      return;
    }

    const formData = new FormData();
    formData.append("image", blob, "frame.jpg");
    formData.append("keyword", requestedKeyword);

    const response = await fetch(`${baseUrl}/detect`, {
      method: "POST",
      headers: { "ngrok-skip-browser-warning": "true" },
      body: formData,
    });

    if (!response.ok) throw new Error("サーバ応答エラー");

    const data = await response.json();

    if (isUpdatingTarget || requestedKeyword !== currentFinalizedKeyword) {
      clearBoundingBoxCanvas();
      return;
    }

    drawDetections(data.detections);
  } catch (err) {
    console.error(err);
  } finally {
    isRequestInFlight = false;
  }
}

// ================= 検出枠の描画 ＆ 履歴保存 =================
function drawDetections(detections) {
  if (!canvas || !ctx || !video) return;
  if (!video.videoWidth || !video.videoHeight) return;

  const viewWidth = video.clientWidth || canvas.clientWidth;
  const viewHeight = video.clientHeight || canvas.clientHeight;
  if (!viewWidth || !viewHeight) return;

  canvas.width = viewWidth;
  canvas.height = viewHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (isUpdatingTarget) {
    hideFoundBannerAndBadge();
    return;
  }

  if (!detections || detections.length === 0) {
    hideFoundBannerAndBadge();
    return;
  }

  updateBannerAndCount(detections);

  const videoRatio = video.videoWidth / video.videoHeight;
  const viewRatio = viewWidth / viewHeight;

  let renderWidth, renderHeight, offsetX, offsetY;
  if (viewRatio > videoRatio) {
    renderWidth = viewWidth;
    renderHeight = viewWidth / videoRatio;
    offsetX = 0;
    offsetY = (viewHeight - renderHeight) / 2;
  } else {
    renderHeight = viewHeight;
    renderWidth = viewHeight * videoRatio;
    offsetX = (viewWidth - renderWidth) / 2;
    offsetY = 0;
  }

  detections.forEach((det) => {
    const [ymin, xmin, ymax, xmax] = det.box_2d;

    const x = offsetX + (xmin / 1000) * renderWidth;
    const y = offsetY + (ymin / 1000) * renderHeight;
    const w = ((xmax - xmin) / 1000) * renderWidth;
    const h = ((ymax - ymin) / 1000) * renderHeight;

    ctx.strokeStyle = "#10b981";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);

    const labelText = `${det.label} (${det.confidence})`;
    ctx.font = "bold 12px sans-serif";
    const textWidth = ctx.measureText(labelText).width;
    const badgeW = Math.max(w, textWidth + 12);
    const badgeH = 20;
    const badgeY = y > badgeH + 3 ? y - badgeH - 3 : y + 3;

    ctx.fillStyle = "rgba(16, 185, 129, 0.92)";
    ctx.fillRect(x, badgeY, badgeW, badgeH);

    ctx.fillStyle = "#ffffff";
    ctx.fillText(labelText, x + 6, badgeY + 14);

    const objectName = (det.label || currentFinalizedKeyword || "未分類").trim();
    tryPlaySoundForObject(objectName);
  });

  const now = Date.now();
  if (now - lastSaveTime > 3000) {
    detections.forEach((det) => {
      const [ymin, xmin, ymax, xmax] = det.box_2d;
      const objectName = (det.label || currentFinalizedKeyword || "未分類").trim();
      saveFoundImage(
        {
          x: (xmin / 1000) * video.videoWidth,
          y: (ymin / 1000) * video.videoHeight,
          width: ((xmax - xmin) / 1000) * video.videoWidth,
          height: ((ymax - ymin) / 1000) * video.videoHeight,
        },
        objectName
      );
    });
    lastSaveTime = now;
  }
}

// ================= 発見履歴・フォルダ機能 =================
function renderHistoryModal() {
  const gallery = document.getElementById("imageGallery");
  const titleEl = document.getElementById("historyModalTitle");
  const backBtn = document.getElementById("backToFoldersBtn");
  if (!gallery) return;

  gallery.innerHTML = "";

  if (selectedObjectFolder) {
    if (titleEl) titleEl.innerText = `📁 ${selectedObjectFolder}`;
    if (backBtn) backBtn.style.display = "inline-flex";

    const photos = historyByObject[selectedObjectFolder] || [];
    if (photos.length === 0) {
      gallery.innerHTML = `<div class="empty-history-msg">この物体の写真はありません</div>`;
      return;
    }

    const grid = document.createElement("div");
    grid.className = "photo-grid";

    photos.forEach((photo) => {
      const item = document.createElement("div");
      item.className = "photo-item";

      const thumbBox = document.createElement("div");
      thumbBox.className = "photo-thumb-box";

      const img = document.createElement("img");
      img.src = photo.dataUrl;
      img.onclick = () => {
        const modal = document.getElementById("imagePreviewModal");
        const previewImg = document.getElementById("previewImage");
        const previewTime = document.getElementById("previewFoundTime");
        if (modal && previewImg) {
          previewImg.src = photo.dataUrl;
          if (previewTime) {
            if (photo.foundTime) {
              previewTime.innerText = `発見時刻: ${photo.foundTime}`;
              previewTime.style.display = "inline-block";
            } else {
              previewTime.innerText = "";
              previewTime.style.display = "none";
            }
          }
          modal.style.display = "flex";
        }
      };

      const delBtn = document.createElement("button");
      delBtn.className = "corner-delete-btn";
      delBtn.innerText = "✕";
      delBtn.title = "この写真を削除";
      delBtn.onclick = (e) => {
        e.stopPropagation();
        deleteSinglePhoto(selectedObjectFolder, photo.id);
      };

      thumbBox.appendChild(img);
      thumbBox.appendChild(delBtn);

      const timeLabel = document.createElement("div");
      timeLabel.className = "photo-time-label";
      timeLabel.innerText = photo.foundTime || "----/--/-- --:--:--";

      item.appendChild(thumbBox);
      item.appendChild(timeLabel);
      grid.appendChild(item);
    });

    gallery.appendChild(grid);
    return;
  }

  if (titleEl) titleEl.innerText = "📂 発見履歴";
  if (backBtn) backBtn.style.display = "none";

  const objectNames = Object.keys(historyByObject).filter(
    (name) => Array.isArray(historyByObject[name]) && historyByObject[name].length > 0
  );

  if (objectNames.length === 0) {
    gallery.innerHTML = `<div class="empty-history-msg">まだ発見した物体の履歴はありません</div>`;
    return;
  }

  const folderGrid = document.createElement("div");
  folderGrid.className = "folder-list-grid";

  objectNames.forEach((objName) => {
    const photos = historyByObject[objName];
    const latestPhoto = photos[0];

    const card = document.createElement("div");
    card.className = "folder-card";
    card.onclick = () => {
      selectedObjectFolder = objName;
      renderHistoryModal();
    };

    const delFolderBtn = document.createElement("button");
    delFolderBtn.className = "corner-delete-btn";
    delFolderBtn.innerText = "✕";
    delFolderBtn.title = `${objName} の写真をすべて削除`;
    delFolderBtn.onclick = (e) => {
      e.stopPropagation();
      deleteObjectFolder(objName);
    };

    const thumb = document.createElement("img");
    thumb.className = "folder-thumb";
    thumb.src = latestPhoto.dataUrl;

    const nameLabel = document.createElement("div");
    nameLabel.className = "folder-name";
    nameLabel.innerText = objName;

    const countLabel = document.createElement("div");
    countLabel.className = "folder-count";
    countLabel.innerText = `${photos.length}枚`;

    card.appendChild(delFolderBtn);
    card.appendChild(thumb);
    card.appendChild(nameLabel);
    card.appendChild(countLabel);
    folderGrid.appendChild(card);
  });

  gallery.appendChild(folderGrid);
}

function deleteSinglePhoto(objName, photoId) {
  if (!historyByObject[objName]) return;
  historyByObject[objName] = historyByObject[objName].filter((p) => p.id !== photoId);
  if (historyByObject[objName].length === 0) {
    delete historyByObject[objName];
    selectedObjectFolder = null;
  }
  renderHistoryModal();
}

function deleteObjectFolder(objName) {
  if (!historyByObject[objName]) return;
  delete historyByObject[objName];
  if (selectedObjectFolder === objName) {
    selectedObjectFolder = null;
  }
  renderHistoryModal();
}

window.backToFolderList = function () {
  selectedObjectFolder = null;
  renderHistoryModal();
};

window.openHistoryFolder = function () {
  unreadPhotosCount = 0;
  updateUnreadPhotosBadge();
  selectedObjectFolder = null;
  renderHistoryModal();
  const modal = document.getElementById("historyFolderModal");
  if (modal) modal.style.display = "flex";
};

window.closeHistoryFolder = function () {
  selectedObjectFolder = null;
  const modal = document.getElementById("historyFolderModal");
  if (modal) modal.style.display = "none";
};

window.clearGallery = function () {
  historyByObject = {};
  selectedObjectFolder = null;
  unreadPhotosCount = 0;
  updateUnreadPhotosBadge();
  renderHistoryModal();
};

function addGalleryThumbnail(dataUrl, objectName = "未分類") {
  const key = (objectName || "未分類").trim();
  if (!historyByObject[key]) {
    historyByObject[key] = [];
  }
  historyByObject[key].unshift({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    dataUrl: dataUrl,
    foundTime: formatFoundTime(new Date()),
  });

  const modal = document.getElementById("historyFolderModal");
  const isModalOpen = modal && modal.style.display === "flex";
  if (isModalOpen) {
    unreadPhotosCount = 0;
    updateUnreadPhotosBadge();
    renderHistoryModal();
  } else {
    unreadPhotosCount += 1;
    updateUnreadPhotosBadge();
  }
}

window.closePreview = function () {
  const modal = document.getElementById("imagePreviewModal");
  if (modal) modal.style.display = "none";
};

function saveFoundImage(bbox, objectName = "未分類") {
  if (!video || !video.videoWidth || !video.videoHeight || bbox.width <= 0 || bbox.height <= 0) return;

  const sx = Math.max(0, Math.min(video.videoWidth, bbox.x));
  const sy = Math.max(0, Math.min(video.videoHeight, bbox.y));
  const sw = Math.max(1, Math.min(video.videoWidth - sx, bbox.width));
  const sh = Math.max(1, Math.min(video.videoHeight - sy, bbox.height));

  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = sw;
  tempCanvas.height = sh;
  tempCanvas.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  addGalleryThumbnail(tempCanvas.toDataURL("image/jpeg"), objectName);
}

// 保存データ読み込み
initSavedSettings();
