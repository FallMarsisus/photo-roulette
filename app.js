// ==========================================
// CONFIGURATION & ÉTAT GLOBAL
// ==========================================
const PEER_PREFIX = "libreroulette-";
const PHOTOS_PER_PLAYER = 5;
const MAX_IMAGE_DIMENSION = 720; // Garde les fichiers sous ~50Ko pour WebRTC
const JPEG_QUALITY = 0.6;
const ROUND_TIME_MS = 5000;

let peer = null;
let isHost = false;
let myId = null;
let myName = "";
let roomCode = "";
let hostConn = null; // Utilisé côté client

// État géré par l'Hôte uniquement
let hostState = {
  connections: {}, // peerId -> DataConnection
  players: {},     // peerId -> { id, name, score, ready, photoCount }
  photoPool: [],   // [{ ownerId, ownerName, dataUrl }]
  gameRounds: [],
  currentRoundIndex: -1,
  roundStartTime: 0,
  roundAnswers: {}, // peerId -> { guessedOwnerId, timeMs }
  readyClientsForRound: new Set(),
  roundTimer: null
};

// État local pour l'interface
let localPlayersList = [];
let hasGuessedThisRound = false;
let currentSelectedGuess = null;
let clientTimerInterval = null;

// ==========================================
// INITIALISATION & AUTO-FILL URL
// ==========================================
window.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get("room");
  if (roomFromUrl) {
    document.getElementById("room-code-input").value = roomFromUrl;
  }

  const savedName = localStorage.getItem("pr_username");
  if (savedName) {
    document.getElementById("username-input").value = savedName;
  }

  document.getElementById("btn-create").addEventListener("click", startAsHost);
  document.getElementById("btn-join").addEventListener("click", startAsClient);
  document.getElementById("photo-input").addEventListener("change", handlePhotoSelection);
  document.getElementById("btn-start-game").addEventListener("click", hostStartGame);
  document.getElementById("btn-replay").addEventListener("click", hostReturnToLobby);
});

// ==========================================
// WAKE LOCK (Empêche la mise en veille)
// ==========================================
async function requestWakeLock() {
  if ("wakeLock" in navigator) {
    try {
      await navigator.wakeLock.request("screen");
    } catch (e) {
      console.warn("WakeLock non accordé :", e);
    }
  }
}

function setStatus(text) {
  document.getElementById("connection-status").textContent = text;
}

function showScreen(screenId) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");
}

// ==========================================
// 1. LOGIQUE HÔTE (SERVEUR DANS LE NAVIGATEUR)
// ==========================================
function startAsHost() {
  myName = document.getElementById("username-input").value.trim() || "Host";
  localStorage.setItem("pr_username", myName);
  roomCode = Math.floor(1000 + Math.random() * 9000).toString();
  isHost = true;

  setStatus("Création du salon...");
  requestWakeLock();

  peer = new Peer(PEER_PREFIX + roomCode);

  peer.on("open", (id) => {
    myId = id;
    setStatus("Hosting");
    document.getElementById("host-warning").classList.remove("hidden");
    document.getElementById("host-controls").classList.remove("hidden");

    // Enregistrer l'hôte comme joueur
    hostState.players[myId] = {
      id: myId,
      name: myName + " 👑",
      score: 0,
      ready: false,
      photoCount: 0
    };

    setupLobbyUI(roomCode);
    broadcastLobbyState();
  });

  peer.on("connection", (conn) => {
    conn.on("open", () => {
      hostState.connections[conn.peer] = conn;
    });

    conn.on("data", (data) => {
      handleHostIncomingData(conn.peer, data);
    });

    conn.on("close", () => {
      delete hostState.connections[conn.peer];
      delete hostState.players[conn.peer];
      hostState.photoPool = hostState.photoPool.filter((p) => p.ownerId !== conn.peer);
      broadcastLobbyState();
    });
  });

  peer.on("error", (err) => {
    alert("P2P Error: " + err.type);
    setStatus("Error");
  });
}

function handleHostIncomingData(peerId, data) {
  switch (data.type) {
    case "JOIN":
      hostState.players[peerId] = {
        id: peerId,
        name: data.name,
        score: 0,
        ready: false,
        photoCount: 0
      };
      broadcastLobbyState();
      break;

    case "UPLOAD_PHOTOS":
      hostState.photoPool = hostState.photoPool.filter((p) => p.ownerId !== peerId);
      data.photos.forEach((dataUrl) => {
        hostState.photoPool.push({
          ownerId: peerId,
          ownerName: hostState.players[peerId]?.name || "Player",
          dataUrl
        });
      });
      if (hostState.players[peerId]) {
        hostState.players[peerId].ready = true;
        hostState.players[peerId].photoCount = data.photos.length;
      }
      broadcastLobbyState();
      break;

    case "CLIENT_IMAGE_LOADED":
      hostState.readyClientsForRound.add(peerId);
      checkAllClientsReadyToRevealPhoto();
      break;

    case "SUBMIT_GUESS":
      if (!hostState.roundAnswers[peerId]) {
        const elapsed = Date.now() - hostState.roundStartTime;
        hostState.roundAnswers[peerId] = {
          guessedOwnerId: data.guessedOwnerId,
          timeMs: elapsed
        };
        if (Object.keys(hostState.roundAnswers).length >= Object.keys(hostState.players).length) {
          clearTimeout(hostState.roundTimer);
          hostEndRound();
        }
      }
      break;
  }
}

function broadcast(payload) {
  Object.values(hostState.connections).forEach((conn) => {
    if (conn.open) conn.send(payload);
  });
  handleClientIncomingData(payload);
}

function broadcastLobbyState() {
  const playersArray = Object.values(hostState.players);
  broadcast({
    type: "LOBBY_STATE",
    players: playersArray,
    totalPhotos: hostState.photoPool.length
  });

  // Activer ou non le bouton de lancement
  const allReady = playersArray.length >= 1 && playersArray.every((p) => p.ready);
  const startBtn = document.getElementById("btn-start-game");
  startBtn.disabled = !allReady;
  startBtn.textContent = allReady
    ? `Start game with (${hostState.photoPool.length} photos.)`
    : "Waiting for pictures...";
}

// ==========================================
// 2. LOGIQUE CLIENT
// ==========================================
function startAsClient() {
  myName = document.getElementById("username-input").value.trim() || "Joueur";
  localStorage.setItem("pr_username", myName);
  roomCode = document.getElementById("room-code-input").value.trim();

  if (roomCode.length !== 4) {
    alert("Entre un code de salon à 4 chiffres.");
    return;
  }

  isHost = false;
  setStatus("Connecting to room " + roomCode + "...");
  requestWakeLock();

  peer = new Peer();

  peer.on("open", (id) => {
    myId = id;
    hostConn = peer.connect(PEER_PREFIX + roomCode, { reliable: true });

    hostConn.on("open", () => {
      setStatus("Connecté au salon " + roomCode);
      setupLobbyUI(roomCode);
      hostConn.send({ type: "JOIN", name: myName });
    });

    hostConn.on("data", (data) => {
      handleClientIncomingData(data);
    });

    hostConn.on("close", () => {
      alert("The host left, game is over.");
      window.location.reload();
    });
  });

  peer.on("error", () => {
    alert("Impossible de trouver le salon " + roomCode);
    setStatus("Erreur");
  });
}

function sendToHost(payload) {
  if (isHost) {
    handleHostIncomingData(myId, payload);
  } else if (hostConn && hostConn.open) {
    hostConn.send(payload);
  }
}

// ==========================================
// 3. SÉLECTION ALÉATOIRE & COMPRESSION CLIENT
// ==========================================
async function handlePhotoSelection(event) {
  const files = Array.from(event.target.files);
  if (files.length === 0) return;

  const statusText = document.getElementById("photo-status-text");
  const dropzone = document.getElementById("dropzone-label");
  statusText.textContent = "Sending...";

  // Mélange de Fisher-Yates et sélection de N photos au hasard
  for (let i = files.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [files[i], files[j]] = [files[j], files[i]];
  }
  const pickedFiles = files.slice(0, PHOTOS_PER_PLAYER);

  try {
    const compressedDataUrls = [];
    for (const file of pickedFiles) {
      const dataUrl = await compressImageFile(file);
      compressedDataUrls.push(dataUrl);
    }

    sendToHost({
      type: "UPLOAD_PHOTOS",
      photos: compressedDataUrls
    });

    dropzone.classList.add("done");
    statusText.textContent = `✅ ${compressedDataUrls.length} pictures sent ! (Click to change)`;
  } catch (err) {
    console.error(err);
    statusText.textContent = "❌ Error, unsupported format, try again.";
  }
}

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let { width, height } = img;

        if (width > height && width > MAX_IMAGE_DIMENSION) {
          height = Math.round((height * MAX_IMAGE_DIMENSION) / width);
          width = MAX_IMAGE_DIMENSION;
        } else if (height > MAX_IMAGE_DIMENSION) {
          width = Math.round((width * MAX_IMAGE_DIMENSION) / height);
          height = MAX_IMAGE_DIMENSION;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        // Convertit automatiquement tout (y compris HEIC décodé par Safari) en JPEG léger
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ==========================================
// 4. DÉROULEMENT DE LA PARTIE (SYNCHRO HÔTE)
// ==========================================
function hostStartGame() {
  if (hostState.photoPool.length === 0) return;

  const requestedRounds = parseInt(document.getElementById("rounds-input").value, 10) || 10;

  // Remise à zéro des scores
  Object.values(hostState.players).forEach((p) => (p.score = 0));

  // Mélanger le pool de photos
  const shuffled = [...hostState.photoPool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  hostState.gameRounds = shuffled.slice(0, requestedRounds);
  hostState.currentRoundIndex = -1;

  hostNextRound();
}

function hostNextRound() {
  hostState.currentRoundIndex++;
  if (hostState.currentRoundIndex >= hostState.gameRounds.length) {
    broadcast({
      type: "GAME_OVER",
      players: Object.values(hostState.players)
    });
    return;
  }

  const roundData = hostState.gameRounds[hostState.currentRoundIndex];
  hostState.roundAnswers = {};
  hostState.readyClientsForRound = new Set();

  // Étape 1 : Précharger l'image chez tous les joueurs avant de lancer le chrono
  broadcast({
    type: "PREPARE_ROUND",
    roundNumber: hostState.currentRoundIndex + 1,
    totalRounds: hostState.gameRounds.length,
    photoDataUrl: roundData.dataUrl,
    players: Object.values(hostState.players)
  });

  // Sécurité : si un téléphone met plus de 2.5s à accuser réception, on lance quand même
  clearTimeout(hostState.roundTimer);
  hostState.roundTimer = setTimeout(() => {
    triggerRoundGo();
  }, 2500);
}

function checkAllClientsReadyToRevealPhoto() {
  const totalPlayers = Object.keys(hostState.players).length;
  if (hostState.readyClientsForRound.size >= totalPlayers) {
    clearTimeout(hostState.roundTimer);
    triggerRoundGo();
  }
}

function triggerRoundGo() {
  hostState.roundStartTime = Date.now();
  broadcast({
    type: "START_ROUND_TIMER",
    durationMs: ROUND_TIME_MS
  });

  clearTimeout(hostState.roundTimer);
  hostState.roundTimer = setTimeout(() => {
    hostEndRound();
  }, ROUND_TIME_MS);
}

function hostEndRound() {
  const currentPhoto = hostState.gameRounds[hostState.currentRoundIndex];

  // Calcul des points selon la vitesse de réponse
  Object.entries(hostState.roundAnswers).forEach(([peerId, answer]) => {
    if (answer.guessedOwnerId === currentPhoto.ownerId && hostState.players[peerId]) {
      const timeRatio = Math.max(0, 1 - answer.timeMs / ROUND_TIME_MS);
      const points = Math.round(500 + 500 * timeRatio);
      hostState.players[peerId].score += points;
    }
  });

  broadcast({
    type: "ROUND_REVEAL",
    ownerId: currentPhoto.ownerId,
    ownerName: currentPhoto.ownerName,
    players: Object.values(hostState.players)
  });

  setTimeout(() => {
    hostNextRound();
  }, 3800);
}

function hostReturnToLobby() {
  broadcast({ type: "BACK_TO_LOBBY" });
  broadcastLobbyState();
}

// ==========================================
// 5. MISE À JOUR DE L'INTERFACE (CLIENT & HÔTE)
// ==========================================
function setupLobbyUI(code) {
  showScreen("screen-lobby");
  document.getElementById("display-room-code").textContent = code;

  const qrContainer = document.getElementById("qrcode-container");
  qrContainer.innerHTML = "";
  const joinUrl = `${window.location.origin}${window.location.pathname}?room=${code}`;
  new QRCode(qrContainer, {
    text: joinUrl,
    width: 84,
    height: 84
  });
}

function handleClientIncomingData(data) {
  switch (data.type) {
    case "LOBBY_STATE":
      localPlayersList = data.players;
      document.getElementById("player-count").textContent = data.players.length;
      const listEl = document.getElementById("player-list");
      listEl.innerHTML = "";
      data.players.forEach((p) => {
        const li = document.createElement("li");
        li.className = "player-item";
        li.innerHTML = `
          <span>${p.name}</span>
          <span class="ready-badge ${p.ready ? "yes" : "no"}">
            ${p.ready ? `Ready (${p.photoCount} 📸)` : "Choosing..."}
          </span>
        `;
        listEl.appendChild(li);
      });
      break;

    case "PREPARE_ROUND":
      showScreen("screen-game");
      hasGuessedThisRound = false;
      currentSelectedGuess = null;
      localPlayersList = data.players;

      document.getElementById("round-indicator").textContent =
        `Manche ${data.roundNumber} / ${data.totalRounds}`;
      document.getElementById("reveal-banner").classList.add("hidden");
      document.getElementById("guess-prompt").textContent = ""; // a qui appartient cette photo ?

      const img = document.getElementById("game-photo");
      const loader = document.getElementById("photo-loader");
      img.classList.add("hidden");
      loader.classList.remove("hidden");

      renderGuessButtons(data.players);

      img.onload = () => {
        sendToHost({ type: "CLIENT_IMAGE_LOADED" });
      };
      img.src = data.photoDataUrl;
      break;

    case "START_ROUND_TIMER":
      document.getElementById("photo-loader").classList.add("hidden");
      document.getElementById("game-photo").classList.remove("hidden");
      startVisualTimer(data.durationMs);
      break;

    case "ROUND_REVEAL":
      clearInterval(clientTimerInterval);
      const banner = document.getElementById("reveal-banner");
      banner.textContent = `📸 ${data.ownerName} !`;
      banner.classList.remove("hidden");

      document.querySelectorAll(".guess-btn").forEach((btn) => {
        const pid = btn.dataset.playerId;
        if (pid === data.ownerId) {
          btn.classList.add("correct");
        } else if (pid === currentSelectedGuess) {
          btn.classList.add("wrong");
        }
      });
      break;

    case "GAME_OVER":
      clearInterval(clientTimerInterval);
      showScreen("screen-results");
      const sorted = [...data.players].sort((a, b) => b.score - a.score);
      const lb = document.getElementById("leaderboard-list");
      lb.innerHTML = "";
      sorted.forEach((p, idx) => {
        const li = document.createElement("li");
        li.className = "player-item";
        const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `#${idx + 1}`;
        li.innerHTML = `
          <span><strong>${medal} ${p.name}</strong></span>
          <span>${p.score} pts</span>
        `;
        lb.appendChild(li);
      });
      if (isHost) {
        document.getElementById("btn-replay").classList.remove("hidden");
      }
      break;

    case "BACK_TO_LOBBY":
      showScreen("screen-lobby");
      break;
  }
}

function renderGuessButtons(players) {
  const container = document.getElementById("guess-buttons");
  container.innerHTML = "";
  players.forEach((p) => {
    const btn = document.createElement("button");
    btn.className = "guess-btn";
    btn.textContent = p.name;
    btn.dataset.playerId = p.id;
    btn.addEventListener("click", () => {
      if (hasGuessedThisRound) return;
      hasGuessedThisRound = true;
      currentSelectedGuess = p.id;
      btn.classList.add("selected");
      document.getElementById("guess-prompt").textContent = "Answer submitted! Waiting for results...";
      sendToHost({
        type: "SUBMIT_GUESS",
        guessedOwnerId: p.id
      });
    });
    container.appendChild(btn);
  });
}

function startVisualTimer(durationMs) {
  clearInterval(clientTimerInterval);
  const start = Date.now();
  const bar = document.getElementById("timer-bar");
  const display = document.getElementById("timer-display");

  clientTimerInterval = setInterval(() => {
    const elapsed = Date.now() - start;
    const remaining = Math.max(0, durationMs - elapsed);
    const pct = (remaining / durationMs) * 100;
    bar.style.width = `${pct}%`;
    display.textContent = `${(remaining / 1000).toFixed(1)}s`;

    if (remaining <= 0) {
      clearInterval(clientTimerInterval);
    }
  }, 50);
}
