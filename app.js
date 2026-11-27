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
const REGISTERED_ITEMS_KEY = "findrone_registered_visual_items_v1";

const NOTIFY_REPEAT_COUNT = 10; // 通知音は2回目以降は10回検出ごと

let isSearching = false;
let searchTimer = null;
let isRequestInFlight = false;
let isUpdatingTarget = false; // サーバーへ新しい物体名を送信・反映中のフラグ
let targetUpdateSafetyTimer = null;
let lastSaveTime = 0;
let currentFinalizedKeyword = "";
let hasAutoConnected = false;

// 事前登録アイテム管理
// { id, name, samples: [ { dataUrl, box2d: [ymin, xmin, ymax, xmax] | null } ] }
let registeredItems = [];
let draftSamples = [];
let activeDraftIndex = -1;
let selectedVisualItem = null;
let cropDragStart = null;
let cropCurrentRect = null;

// 通知（アプリ内トースト＆Web Audio通知音）用
let isNotificationEnabled = false;
let notifySoundStateByObject = {}; // { [objectName]: { hasPlayedOnce, count } }
let audioCtx = null;

// 物体名ごとの履歴データ: { [labelName]: [ { id, dataUrl, foundTime }, ... ] }
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

function setStatus(text, color = "#a2759e") {
  if (statusEl) {
    statusEl.innerText = text;
    statusEl.style.color = color;
  }
}

function setConnectionStatus(text, color = "#8c7388") {
  const connStatus = document.getElementById("connectionStatus");
  if (connStatus) {
    connStatus.innerText = text;
    connStatus.style.color = color;
  }
}

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

  if (toastTextEl) toastTextEl.innerText = "";
  if (toastEl) toastEl.style.display = "none";
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

  const fallbackName = selectedVisualItem ? selectedVisualItem.name : currentFinalizedKeyword;
  const targetKey = (fallbackName || "").trim().toLowerCase();
  const matched = detections.filter((det) => {
    if (!targetKey) return true;
    const label = String(det.label || "").trim().toLowerCase();
    return label === targetKey || label.includes(targetKey);
  });
  const targetDetections = matched.length > 0 ? matched : detections;
  const count = targetDetections.length;
  const primary = targetDetections[0];
  const objectName = (primary.label || fallbackName || "未分類").trim();
  const confText = primary.confidence !== undefined ? ` (${primary.confidence})` : "";

  toastTextEl.innerText = `🎉「${objectName}」を発見しました！${confText}`;
  toastEl.style.display = "flex";

  if (count > 0) {
    badge.innerText = `×${count}`;
    badge.style.display = "inline-block";
  } else {
    badge.innerText = "×0";
    badge.style.display = "none";
  }
}

function clearBoundingBoxCanvas() {
  if (ctx && canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  hideFoundBannerAndBadge();
}

function updateNotificationUi() {
  const toggleBtn = document.getElementById("notifyToggleBtn");
  if (toggleBtn) {
    toggleBtn.innerText = isNotificationEnabled ? "ON" : "OFF";
    toggleBtn.classList.toggle("is-on", isNotificationEnabled);
  }
}

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

  const fallback = selectedVisualItem ? selectedVisualItem.name : currentFinalizedKeyword;
  const key = (objectName || fallback || "未分類").trim();
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
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));

  const targetTab = document.getElementById(`${tabName}Tab`);
  const targetNav = document.getElementById(`nav-${tabName}`);
  if (targetTab) targetTab.classList.add("active");
  if (targetNav) targetNav.classList.add("active");

  if (tabName === "register") {
    renderRegisteredList();
    renderDraftThumbs();
    syncCropStageWithActiveDraft();
  }
};

// ================= 事前登録・見本枠指定 =================
function loadRegisteredItems() {
  try {
    const raw = localStorage.getItem(REGISTERED_ITEMS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        registeredItems = parsed;
      }
    }
  } catch (err) {
    console.warn("登録アイテムの読み込みに失敗:", err);
  }
}

function persistRegisteredItems() {
  try {
    localStorage.setItem(REGISTERED_ITEMS_KEY, JSON.stringify(registeredItems));
  } catch (err) {
    console.warn("登録アイテムの保存に失敗:", err);
    alert("保存容量の上限に達しました。不要な登録アイテムを減らしてください。");
  }
}

window.triggerRegisterCamera = function () {
  document.getElementById("registerCameraInput")?.click();
};

window.triggerRegisterGallery = function () {
  document.getElementById("registerGalleryInput")?.click();
};

function compressImageFileToDataUrl(file, maxSide = 640, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

window.handleRegisterFiles = async function (fileList) {
  if (!fileList || fileList.length === 0) return;
  const files = Array.from(fileList).slice(0, 6 - draftSamples.length);
  for (const f of files) {
    try {
      const dataUrl = await compressImageFileToDataUrl(f);
      draftSamples.push({ dataUrl, box2d: null });
      activeDraftIndex = draftSamples.length - 1;
    } catch (err) {
      console.warn("見本画像の読み込み失敗:", err);
    }
  }
  renderDraftThumbs();
  syncCropStageWithActiveDraft();
};

function renderDraftThumbs() {
  const row = document.getElementById("draftThumbsRow");
  if (!row) return;
  row.innerHTML = "";
  draftSamples.forEach((s, idx) => {
    const div = document.createElement("div");
    div.className = "draft-thumb" + (idx === activeDraftIndex ? " is-selected" : "");
    div.onclick = () => {
      activeDraftIndex = idx;
      renderDraftThumbs();
      syncCropStageWithActiveDraft();
    };
    const img = document.createElement("img");
    img.src = s.dataUrl;
    div.appendChild(img);
    row.appendChild(div);
  });
}

function syncCropStageWithActiveDraft() {
  const stage = document.getElementById("cropStage");
  const img = document.getElementById("cropPreviewImg");
  const cCanvas = document.getElementById("cropCanvas");
  if (!stage || !img || !cCanvas) return;

  if (activeDraftIndex < 0 || !draftSamples[activeDraftIndex]) {
    stage.style.display = "none";
    cropCurrentRect = null;
    return;
  }

  stage.style.display = "block";
  img.onload = () => {
    cCanvas.width = stage.clientWidth;
    cCanvas.height = stage.clientHeight;
    drawCropOverlay(draftSamples[activeDraftIndex].box2d);
  };
  img.src = draftSamples[activeDraftIndex].dataUrl;
}

function drawCropOverlay(box2d) {
  const cCanvas = document.getElementById("cropCanvas");
  if (!cCanvas) return;
  const cCtx = cCanvas.getContext("2d");
  cCtx.clearRect(0, 0, cCanvas.width, cCanvas.height);
  if (!box2d) return;

  const [ymin, xmin, ymax, xmax] = box2d;
  const x = (xmin / 1000) * cCanvas.width;
  const y = (ymin / 1000) * cCanvas.height;
  const w = ((xmax - xmin) / 1000) * cCanvas.width;
  const h = ((ymax - ymin) / 1000) * cCanvas.height;

  cCtx.strokeStyle = "#00b884";
  cCtx.lineWidth = 3;
  cCtx.strokeRect(x, y, w, h);
  cCtx.fillStyle = "rgba(0, 184, 132, 0.16)";
  cCtx.fillRect(x, y, w, h);
}

window.resetCropBox = function () {
  if (activeDraftIndex >= 0 && draftSamples[activeDraftIndex]) {
    draftSamples[activeDraftIndex].box2d = null;
  }
  cropCurrentRect = null;
  drawCropOverlay(null);
};

function initCropCanvasEvents() {
  const cCanvas = document.getElementById("cropCanvas");
  const stage = document.getElementById("cropStage");
  if (!cCanvas) return;

  const preventLongPressMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  cCanvas.addEventListener("contextmenu", preventLongPressMenu);
  if (stage) {
    stage.addEventListener("contextmenu", preventLongPressMenu);
  }

  const getPos = (e) => {
    const rect = cCanvas.getBoundingClientRect();
    const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    const clientX = touch ? touch.clientX : e.clientX;
    const clientY = touch ? touch.clientY : e.clientY;
    return {
      x: Math.max(0, Math.min(rect.width, clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, clientY - rect.top)),
      w: rect.width,
      h: rect.height,
    };
  };

  const onDown = (e) => {
    if (activeDraftIndex < 0) return;
    if (e.cancelable) e.preventDefault();
    cCanvas.width = cCanvas.clientWidth;
    cCanvas.height = cCanvas.clientHeight;
    cropDragStart = getPos(e);
  };

  const onMove = (e) => {
    if (!cropDragStart || activeDraftIndex < 0) return;
    if (e.cancelable) e.preventDefault();
    const pos = getPos(e);
    const x1 = Math.min(cropDragStart.x, pos.x);
    const y1 = Math.min(cropDragStart.y, pos.y);
    const x2 = Math.max(cropDragStart.x, pos.x);
    const y2 = Math.max(cropDragStart.y, pos.y);
    cropCurrentRect = [
      Math.round((y1 / pos.h) * 1000),
      Math.round((x1 / pos.w) * 1000),
      Math.round((y2 / pos.h) * 1000),
      Math.round((x2 / pos.w) * 1000),
    ];
    drawCropOverlay(cropCurrentRect);
  };

  const onUp = () => {
    if (!cropDragStart) return;
    cropDragStart = null;
    if (cropCurrentRect && activeDraftIndex >= 0) {
      const [ymin, xmin, ymax, xmax] = cropCurrentRect;
      if (xmax - xmin > 40 && ymax - ymin > 40) {
        draftSamples[activeDraftIndex].box2d = cropCurrentRect;
      }
    }
    cropCurrentRect = null;
  };

  cCanvas.addEventListener("mousedown", onDown);
  cCanvas.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  cCanvas.addEventListener("touchstart", onDown, { passive: false });
  cCanvas.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("touchend", onUp);
}

window.saveRegisteredObject = function () {
  const nameInput = document.getElementById("registerNameInput");
  const name = nameInput ? nameInput.value.trim() : "";
  if (!name) {
    alert("持ち物の名前を入力してください！");
    return;
  }
  if (draftSamples.length === 0) {
    alert("見本写真を1枚以上追加してください！");
    return;
  }

  registeredItems.unshift({
    id: `item_${Date.now()}`,
    name: name,
    samples: draftSamples.map((s) => ({ dataUrl: s.dataUrl, box2d: s.box2d })),
  });
  persistRegisteredItems();

  draftSamples = [];
  activeDraftIndex = -1;
  if (nameInput) nameInput.value = "";
  renderDraftThumbs();
  syncCropStageWithActiveDraft();
  renderRegisteredList();
  alert(`「${name}」を登録しました！`);
};

function renderRegisteredList() {
  const listEl = document.getElementById("registeredList");
  const statusLabel = document.getElementById("registerStatus");
  if (!listEl) return;

  if (statusLabel) {
    statusLabel.innerText =
      registeredItems.length > 0
        ? `登録済み: ${registeredItems.length}件`
        : "登録済みアイテムはありません";
  }

  listEl.innerHTML = "";
  registeredItems.forEach((item) => {
    const card = document.createElement("div");
    card.className = "registered-item-card";

    const thumb = document.createElement("img");
    thumb.className = "registered-item-thumb";
    thumb.src = item.samples[0]?.dataUrl || "";

    const info = document.createElement("div");
    info.className = "registered-item-info";

    const title = document.createElement("div");
    title.className = "registered-item-name";
    title.innerText = item.name;

    const meta = document.createElement("div");
    meta.className = "registered-item-meta";
    const boxedCount = item.samples.filter((s) => Array.isArray(s.box2d)).length;
    meta.innerText = `見本 ${item.samples.length}枚（枠指定 ${boxedCount}枚）`;

    info.appendChild(title);
    info.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "registered-item-actions";

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "btn-use-item";
    useBtn.innerText = "探す";
    useBtn.onclick = () => selectRegisteredItemForSearch(item.id);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-del-item";
    delBtn.innerText = "✕";
    delBtn.onclick = () => deleteRegisteredItem(item.id);

    actions.appendChild(useBtn);
    actions.appendChild(delBtn);

    card.appendChild(thumb);
    card.appendChild(info);
    card.appendChild(actions);
    listEl.appendChild(card);
  });
}

function deleteRegisteredItem(id) {
  registeredItems = registeredItems.filter((it) => it.id !== id);
  if (selectedVisualItem && selectedVisualItem.id === id) {
    clearSelectedVisualItem();
  }
  persistRegisteredItems();
  renderRegisteredList();
}

function updateActiveVisualBanner() {
  const banner = document.getElementById("activeVisualBanner");
  const label = document.getElementById("activeVisualLabel");
  if (!banner || !label) return;
  if (selectedVisualItem) {
    banner.style.display = "flex";
    label.innerText = `🖼️ 見本で探索: ${selectedVisualItem.name} (${selectedVisualItem.samples.length}枚)`;
  } else {
    banner.style.display = "none";
    label.innerText = "";
  }
}

window.clearSelectedVisualItem = function () {
  selectedVisualItem = null;
  updateActiveVisualBanner();
};

function selectRegisteredItemForSearch(id) {
  const found = registeredItems.find((it) => it.id === id);
  if (!found) return;
  selectedVisualItem = found;
  currentFinalizedKeyword = found.name;
  const inputElement = document.getElementById("targetObject");
  if (inputElement) inputElement.value = found.name;
  updateActiveVisualBanner();
  goToTab("search");
  setStatus(`🎯 見本「${found.name}」を選択しました`, "#247a5d");
}

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

    if (savedUrl && serverIpInput) serverIpInput.value = savedUrl;
    if (savedId && pcIdInput) pcIdInput.value = savedId;
    if (savedNotifyEnabled === "true") {
      isNotificationEnabled = true;
    }
  } catch (err) {
    console.warn("設定の初期化に失敗:", err);
  }

  loadRegisteredItems();
  renderRegisteredList();
  updateActiveVisualBanner();
  initCropCanvasEvents();
  updateNotificationUi();
  hideFoundBannerAndBadge();
  updateUnreadPhotosBadge();
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

    setConnectionStatus("設定を保存しました。接続処理を実行中...", "#2e7d63");
    if (rawId) {
      window.connectToPC();
    }
    alert("設定を保存しました！次回からも自動接続されます");
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
      setStatus(`ステータス: 探索中... (${currentFinalizedKeyword})`, "#247a5d");
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
    alert("IPアドレスまたはURLを入力してください！");
    return;
  }
  try {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, url);
  } catch (e) {}
  setConnectionStatus("サーバーURLを保存しました", "#2e7d63");
  alert("サーバーのアドレスを登録しました");
};

window.connectToPC = function () {
  const pcIdInput = document.getElementById("pcIdInput");
  const pcId = pcIdInput ? pcIdInput.value.trim() : "";
  if (!pcId) {
    alert("PCのIDを入力してください！");
    return;
  }
  if (!peer) {
    alert("PeerJSの読み込みに失敗しました。");
    return;
  }

  setStatus("ステータス: PCに接続中...", "#b57c18");
  setConnectionStatus("ステータス: PCに接続中...", "#b57c18");

  if (conn) {
    try {
      conn.close();
    } catch (e) {}
  }

  conn = peer.connect(pcId);
  conn.on("open", () => {
    setStatus("ステータス: PC接続完了 ✅", "#247a5d");
    setConnectionStatus("ステータス: 接続完了 ✅", "#2e7d63");
    if (startButton) {
      startButton.disabled = false;
      if (isSearching) {
        startButton.innerText = "探索終了";
        startButton.classList.add("active-stop");
      } else {
        startButton.innerText = "探索開始";
        startButton.classList.remove("active-stop");
      }
    }
  });

  conn.on("error", (err) => {
    console.error("Peer接続エラー:", err);
    setStatus("エラー: PCとの接続に失敗しました", "#c94a63");
    setConnectionStatus("ステータス: 接続に失敗しました ✕", "#c94a63");
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
      btn.innerHTML = `<i class="bi bi-x-circle-fill"></i> QRスキャン停止`;
      btn.classList.add("active-stop");
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
            btn.innerHTML = `<i class="bi bi-qr-code-scan"></i> QRコードカメラ起動`;
            btn.classList.remove("active-stop");
          }
          readerContainer.style.display = "none";
          setStatus("✅ IDを取得しました！設定保存か接続を押してください", "#247a5d");
          setConnectionStatus("✅ IDを取得しました！「この設定で保存」または「接続」を押してください", "#2e7d63");
        },
        () => {}
      );
    } catch (err) {
      console.error(err);
      isScanning = false;
      if (btn) {
        btn.innerHTML = `<i class="bi bi-qr-code-scan"></i> QRコードカメラ起動`;
        btn.classList.remove("active-stop");
      }
      readerContainer.style.display = "none";
    }
  } else {
    isScanning = false;
    if (btn) {
      btn.innerHTML = `<i class="bi bi-qr-code-scan"></i> QRコードカメラ起動`;
      btn.classList.remove("active-stop");
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
    alert("探すものを入力してください！");
    return;
  }

  // 登録アイテムの名前と同じまま「決定」を押した場合は、登録名と視覚プロンプトを維持する
  if (selectedVisualItem && keyword === selectedVisualItem.name) {
    currentFinalizedKeyword = selectedVisualItem.name;
    updateActiveVisualBanner();
    if (isSearching) {
      setStatus(`🖼️ 見本「${currentFinalizedKeyword}」をYOLOEで探索中...`, "#247a5d");
    } else {
      setStatus(`🎯 見本「${currentFinalizedKeyword}」を設定しました`, "#247a5d");
    }
    return;
  }

  // 別の言葉に変更された場合は見本モードを解除してテキスト検索へ切り替え
  if (selectedVisualItem && keyword !== selectedVisualItem.name) {
    selectedVisualItem = null;
    updateActiveVisualBanner();
  }

  if (!rawServerInput) {
    alert("サーバーのURLまたはIPアドレスを入力してください！");
    goToTab("setting");
    if (serverIpInput) serverIpInput.focus();
    return;
  }

  beginTargetLoadingState();

  const baseUrl = buildBaseUrl(rawServerInput);
  setStatus("🔄 サーバーで翻訳中...", "#b57c18");

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

    if (isSearching) {
      setStatus(`🔍 「${currentFinalizedKeyword}」を探索中... (変更適用)`, "#247a5d");
    } else {
      setStatus(`🎯 「${keyword}」➔ 英語: [${currentFinalizedKeyword}] に設定しました`, "#247a5d");
    }
  } catch (err) {
    console.error(err);
    currentFinalizedKeyword = keyword;
    setStatus(`⚠️ 翻訳に失敗しました（「${currentFinalizedKeyword}」を使用）`, "#c94a63");
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
      alert("サーバーのURLを設定画面で入力してください！");
      goToTab("setting");
      return;
    }
    if (!inputVal && !currentFinalizedKeyword && !selectedVisualItem) {
      alert("探すものを入力するか、登録した持ち物を選んでください！");
      if (inputElement) inputElement.focus();
      return;
    }
    if (!conn || !conn.open) {
      alert("先にPCと接続してください！");
      goToTab("setting");
      return;
    }

    if (selectedVisualItem) {
      // 入力欄が空または登録名と同じなら登録名を維持
      if (!inputVal || inputVal === selectedVisualItem.name) {
        currentFinalizedKeyword = selectedVisualItem.name;
        if (inputElement) inputElement.value = selectedVisualItem.name;
      } else {
        selectedVisualItem = null;
        updateActiveVisualBanner();
        await window.updateTarget();
      }
    } else if (inputVal) {
      await window.updateTarget();
    }

    resetFoundNotifyState();

    conn.send({
      action: "start",
      keyword: currentFinalizedKeyword,
      smartphoneId: peer ? peer.id : "",
    });

    isSearching = true;
    if (startButton) {
      startButton.innerText = "探索終了";
      startButton.classList.add("active-stop");
    }
    setStatus(
      selectedVisualItem
        ? `🖼️ 見本「${selectedVisualItem.name}」をYOLOEで探索中...`
        : `🔍 「${currentFinalizedKeyword}」をYOLOEで探索中...`,
      "#247a5d"
    );

    searchTimer = setInterval(async () => {
      if (!isSearching || isUpdatingTarget || isRequestInFlight || !video || video.videoWidth === 0) return;
      await sendFrameToPC(serverIpInput ? serverIpInput.value.trim() : "", currentFinalizedKeyword);
    }, 500);
  } else {
    isSearching = false;
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

    if (startButton) {
      startButton.innerText = "探索開始";
      startButton.classList.remove("active-stop");
    }
    setStatus("ステータス: 停止しました", "#8c7388");
  }
};

window.stopDetection = () => isSearching && window.startDetection();

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
}

// ================= サーバーへ画像送信 ＆ 検出 =================
async function sendFrameToPC(serverInput, keyword) {
  if (isUpdatingTarget || (!keyword && !selectedVisualItem)) return;
  isRequestInFlight = true;
  const requestedKeyword = selectedVisualItem ? selectedVisualItem.name : keyword;
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

    if (selectedVisualItem && Array.isArray(selectedVisualItem.samples) && selectedVisualItem.samples.length > 0) {
      const sample = selectedVisualItem.samples[0];
      const refBlob = await dataUrlToBlob(sample.dataUrl);
      formData.append("mode", "visual");
      formData.append("ref_image", refBlob, "ref.jpg");
      if (Array.isArray(sample.box2d)) {
        formData.append("ref_box_2d", JSON.stringify(sample.box2d));
      }
    } else {
      formData.append("mode", "text");
    }

    const response = await fetch(`${baseUrl}/detect`, {
      method: "POST",
      headers: { "ngrok-skip-browser-warning": "true" },
      body: formData,
    });

    if (!response.ok) throw new Error("サーバー応答エラー");

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

    ctx.strokeStyle = "#00e676";
    ctx.lineWidth = 3.5;
    ctx.strokeRect(x, y, w, h);

    const labelText = `${det.label} (${det.confidence})`;
    ctx.font = "bold 13px sans-serif";
    const textWidth = ctx.measureText(labelText).width;
    const badgeW = Math.max(w, textWidth + 12);
    const badgeH = 22;
    const badgeY = y > badgeH + 2 ? y - badgeH - 2 : y + 2;

    ctx.fillStyle = "rgba(181, 242, 214, 0.92)";
    ctx.fillRect(x, badgeY, badgeW, badgeH);

    ctx.fillStyle = "#1f4d3d";
    ctx.fillText(labelText, x + 6, badgeY + 15);

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
              previewTime.innerText = `🕒 発見時刻: ${photo.foundTime}`;
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

  if (titleEl) titleEl.innerText = "📂 発見した物体一覧";
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
