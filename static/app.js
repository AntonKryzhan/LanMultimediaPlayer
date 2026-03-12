(() => {
  const role = document.body?.dataset?.role || "client";

  const $ = (id) => document.getElementById(id);

  function logAppend(el, line) {
    if (!el) return;
    const t = el.textContent || "";
    el.textContent = (t ? (t + "\n") : "") + line;
    el.scrollTop = el.scrollHeight;
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }

  // Lazy-load video previews so they don't spam downloads (can break uploads / UI).
  let _videoPreviewIO = null;
  function observeVideoPreview(v) {
    if (!v || v.tagName !== "VIDEO") return;

    const dataSrc = v.dataset ? v.dataset.src : null;
    if (!dataSrc) return;

    if (!("IntersectionObserver" in window)) {
      v.src = dataSrc;
      return;
    }

    if (!_videoPreviewIO) {
      _videoPreviewIO = new IntersectionObserver((entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target;
          const src = el.dataset ? el.dataset.src : null;
          if (src && !el.src) {
            el.src = src;
            try { el.load(); } catch {}
          }
          try { obs.unobserve(el); } catch {}
        }
      }, { root: null, rootMargin: "200px 0px", threshold: 0.01 });
    }

    try { _videoPreviewIO.observe(v); } catch {}
  }

  class TimeSync {
    constructor(sendFn) {
      this.sendFn = sendFn;
      this.offsetMs = 0;
      this._pending = new Map();
    }

    onPong(msg) {
      const t0 = msg.t0;
      const serverMs = msg.serverMs;
      if (!Number.isFinite(t0) || !Number.isFinite(serverMs)) return;
      const t1 = performance.now();
      const estClientAtServerSend = (t0 + t1) / 2;
      const offset = serverMs - (Date.now() - (performance.now() - estClientAtServerSend));
      if (!Number.isFinite(offset)) return;
      const rec = this._pending.get(t0);
      if (!rec) return;
      this._pending.delete(t0);
      rec.resolve({ rtt: (t1 - t0), offset });
    }

    async sync(rounds = 5) {
      let best = null;
      for (let i = 0; i < rounds; i++) {
        const t0 = performance.now();
        const p = new Promise((resolve) => this._pending.set(t0, { resolve }));
        this.sendFn({ type: "ping", t0 });
        const res = await Promise.race([p, sleep(800).then(() => null)]);
        if (res && Number.isFinite(res.rtt) && Number.isFinite(res.offset)) {
          if (!best || res.rtt < best.rtt) best = res;
        }
        await sleep(80);
      }
      if (best) this.offsetMs = best.offset;
      return this.offsetMs;
    }

    serverNowMs() {
      return Date.now() + this.offsetMs;
    }
  }

  class WsClient {
    constructor() {
      this.ws = null;
      this.onMessage = () => {};
      this.onStatus = () => {};
      this.queue = [];
      this.connected = false;
    }

    connect() {
      const ws = new WebSocket(wsUrl());
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.onStatus("open");
        while (this.queue.length) ws.send(this.queue.shift());
        this.send({ type: "hello", role });
      };

      ws.onclose = () => {
        this.connected = false;
        this.onStatus("closed");
        setTimeout(() => this.connect(), 800);
      };

      ws.onerror = () => {
        this.onStatus("error");
      };

      ws.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg !== "object") return;
        this.onMessage(msg);
      };
    }

    send(obj) {
      const s = JSON.stringify(obj);
      if (this.ws && this.connected) this.ws.send(s);
      else this.queue.push(s);
    }
  }

  function buildAdmin() {
    const wsStatus = $("wsStatus");
    const peersEl = $("peers");
    const playStateEl = $("playState");
    const uploadLog = $("uploadLog");
    const errors = $("errors");

    const fileInput = $("fileInput");
    const refreshMediaBtn = $("refreshMedia");
    const mediaListEl = $("mediaList");

    const playlistListEl = $("playlistList");
    const savePlaylistBtn = $("savePlaylist");
    const playBtn = $("playBtn");
    const stopBtn = $("stopBtn");
    const fsHintBtn = $("fsHintBtn");
    const fsHintClearBtn = $("fsHintClearBtn");

    const ws = new WsClient();
    const ts = new TimeSync((m) => ws.send(m));

    let mediaItems = [];
    let playlist = [];
    let playlistDirty = false;
    let playing = false;

    function markDirty() {
      playlistDirty = true;
    }

    function setWsPill(t) {
      if (!wsStatus) return;
      wsStatus.textContent = `WS: ${t}`;
    }

    function setPeers(p) {
      if (!peersEl) return;
      const c = p?.clients ?? 0;
      const a = p?.admins ?? 0;
      peersEl.textContent = `clients: ${c} | admins: ${a}`;
    }

    function setPlayState() {
      if (!playStateEl) return;
      playStateEl.textContent = playing ? "playing" : "stopped";
    }

    function escapeHtml(s) {
      return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function cryptoRandomId() {
      if (crypto?.randomUUID) return crypto.randomUUID();
      return Math.random().toString(16).slice(2) + Date.now().toString(16);
    }

    function makePreviewEl(type, url) {
      if (type === "video") {
        const v = document.createElement("video");
        v.className = "thumb";
        v.muted = true;
        v.playsInline = true;
        v.preload = "none";
        v.controls = false;
        v.disablePictureInPicture = true;

        const armLoad = () => {
          if (v.src) return;
          v.src = url;
          try { v.load(); } catch {}
        };
        v.addEventListener("pointerenter", armLoad, { once: true });
        v.addEventListener("focus", armLoad, { once: true });

        v.addEventListener("loadedmetadata", () => {
          try { v.currentTime = 0.1; } catch {}
        }, { once: true });
        return v;
      }

      const img = document.createElement("img");
      img.className = "thumb";
      img.src = url;
      img.loading = "lazy";
      img.decoding = "async";
      return img;
    }

    function renderMedia() {
      if (!mediaListEl) return;
      mediaListEl.innerHTML = "";
      for (const it of mediaItems) {
        const card = document.createElement("div");
        card.className = "card";

        const previewType = (it.type === "video") ? "video" : "image";
        card.appendChild(makePreviewEl(previewType, it.url));

        const title = document.createElement("div");
        title.className = "cardTitle";
        title.innerHTML = `<div class="cardName">${escapeHtml(it.name)}</div><div class="pill">${it.type}</div>`;
        card.appendChild(title);

        const meta = document.createElement("div");
        meta.className = "cardMeta";
        if (it.type === "deck") {
          const cnt = it.count ?? (Array.isArray(it.slides) ? it.slides.length : 0);
          meta.textContent = `${cnt} slides • ${fmtBytes(it.size)} • ${it.url}`;
        } else {
          meta.textContent = `${fmtBytes(it.size)} • ${it.url}`;
        }
        card.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "cardActions";

        if (it.type === "deck") {
          const addBtn = document.createElement("button");
          addBtn.className = "btn";
          addBtn.textContent = "В плейлист (слайды)";
          addBtn.onclick = () => {
            const slides = Array.isArray(it.slides) ? it.slides : [];
            slides.forEach((u, si) => {
              playlist.push({
                id: cryptoRandomId(),
                type: "image",
                url: u,
                name: `${it.name} — ${si + 1}`,
                durationMs: 5000,
              });
            });
            markDirty();
            renderPlaylist();
          };
          actions.appendChild(addBtn);
        } else {
          const addBtn = document.createElement("button");
          addBtn.className = "btn";
          addBtn.textContent = "В плейлист";
          addBtn.onclick = () => {
            const item = {
              id: cryptoRandomId(),
              type: it.type,
              url: it.url,
              name: it.name,
            };
            if (it.type === "image") item.durationMs = 5000;
            playlist.push(item);
            markDirty();
            renderPlaylist();
          };
          actions.appendChild(addBtn);
        }

        card.appendChild(actions);
        mediaListEl.appendChild(card);
      }
    }

    function renderPlaylist() {
      if (!playlistListEl) return;
      playlistListEl.innerHTML = "";
      playlist.forEach((it, idx) => {
        const card = document.createElement("div");
        card.className = "card";

        const previewType = (it.type === "video") ? "video" : "image";
        card.appendChild(makePreviewEl(previewType, it.url));

        const title = document.createElement("div");
        title.className = "cardTitle";
        title.innerHTML = `<div class="cardName">${escapeHtml(it.name || it.url)}</div><div class="pill">${it.type}</div>`;
        card.appendChild(title);

        const meta = document.createElement("div");
        meta.className = "cardMeta";
        meta.textContent = it.url;
        card.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "cardActions";

        if (it.type === "image") {
          const label = document.createElement("span");
          label.className = "pill";
          label.textContent = "сек:";
          actions.appendChild(label);

          const inp = document.createElement("input");
          inp.className = "input";
          inp.type = "number";
          inp.min = "0.25";
          inp.max = "600";
          inp.step = "0.25";
          inp.value = ((it.durationMs ?? 5000) / 1000).toString();
          inp.onchange = () => {
            const v = parseFloat(inp.value);
            if (Number.isFinite(v)) {
              it.durationMs = Math.max(250, Math.min(Math.round(v * 1000), 600000));
              markDirty();
            }
          };
          actions.appendChild(inp);
        } else {
          const vtag = document.createElement("span");
          vtag.className = "pill";
          vtag.textContent = "video: до конца";
          actions.appendChild(vtag);
        }

        const up = document.createElement("button");
        up.className = "btn";
        up.textContent = "↑";
        up.onclick = () => {
          if (idx <= 0) return;
          const t = playlist[idx - 1];
          playlist[idx - 1] = playlist[idx];
          playlist[idx] = t;
          markDirty();
          renderPlaylist();
        };

        const down = document.createElement("button");
        down.className = "btn";
        down.textContent = "↓";
        down.onclick = () => {
          if (idx >= playlist.length - 1) return;
          const t = playlist[idx + 1];
          playlist[idx + 1] = playlist[idx];
          playlist[idx] = t;
          markDirty();
          renderPlaylist();
        };

        const del = document.createElement("button");
        del.className = "btn danger";
        del.textContent = "Удалить";
        del.onclick = () => {
          playlist.splice(idx, 1);
          markDirty();
          renderPlaylist();
        };

        actions.appendChild(up);
        actions.appendChild(down);
        actions.appendChild(del);

        card.appendChild(actions);
        playlistListEl.appendChild(card);
      });
    }

    async function refreshMedia() {
      const res = await fetch("/api/media");
      const j = await res.json();
      if (j.ok) {
        mediaItems = j.items || [];
        renderMedia();
      }
    }

    async function uploadFiles(files) {
      for (const f of files) {
        logAppend(uploadLog, `upload: ${f.name} (${fmtBytes(f.size)})`);
        const fd = new FormData();
        fd.append("file", f);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const j = await res.json();
        if (j.ok) {
          logAppend(uploadLog, `ok: ${j.item.name} -> ${j.item.url}`);
        } else {
          logAppend(uploadLog, `err: ${j.error || "upload failed"}`);
        }
      }
      await refreshMedia();
    }

    ws.onStatus = (s) => setWsPill(s);

    ws.onMessage = async (msg) => {
      if (msg.type === "pong") {
        ts.onPong(msg);
        return;
      }
      if (msg.type === "error") {
        logAppend(errors, msg.message || "error");
        return;
      }
      if (msg.type === "state") {
        setPeers(msg.peers);
        playing = !!msg.playing;
        setPlayState();
        if (Array.isArray(msg.playlist) && !playlistDirty) {
          playlist = msg.playlist.slice();
          renderPlaylist();
        }
        return;
      }
    };

    if (fileInput) {
      fileInput.addEventListener("change", async () => {
        const files = Array.from(fileInput.files || []);
        fileInput.value = "";
        if (files.length) await uploadFiles(files);
      });
    }

    if (refreshMediaBtn) refreshMediaBtn.onclick = () => refreshMedia();

    if (savePlaylistBtn) {
      savePlaylistBtn.onclick = () => {
        ws.send({ type: "set_playlist", playlist });
        playlistDirty = false;
        logAppend(uploadLog, "playlist: sent");
      };
    }

    if (playBtn) {
      playBtn.onclick = async () => {
        await ts.sync(5);
        ws.send({ type: "play", startDelayMs: 1500 });
      };
    }

    if (stopBtn) stopBtn.onclick = () => ws.send({ type: "stop" });

    if (fsHintBtn) fsHintBtn.onclick = () => ws.send({ type: "hint_fullscreen" });

    if (fsHintClearBtn) fsHintClearBtn.onclick = () => ws.send({ type: "clear_overlay" });

    ws.connect();
    refreshMedia();
    renderPlaylist();
  }

  function buildClient() {
    const overlay = $("overlay");
    const overlaySmall = $("overlaySmall");
    const enableBtn = $("enableBtn");

    const hudWs = $("hudWs");
    const hudState = $("hudState");

    const img = $("img");
    const vid = $("vid");
    const stage = $("stage");

    const ws = new WsClient();
    const ts = new TimeSync((m) => ws.send(m));

    let enabled = false;

    let playlist = [];
    let playing = false;
    let playId = "";
    let startAtServerMs = null;

    let timer = null;
    let idx = 0;
    let started = false;

    let overlayReason = "init"; // init | hint | error | none

    function setWs(s) {
      if (overlaySmall) overlaySmall.textContent = `WS: ${s}`;
      if (hudWs) hudWs.textContent = `WS: ${s}`;
    }

    function setState() {
      if (hudState) hudState.textContent = playing ? "playing" : "stopped";
    }

    function showOverlay(show, text, reason) {
      if (reason) overlayReason = reason;
      if (!overlay) return;
      overlay.style.display = show ? "flex" : "none";
      if (text && overlaySmall) overlaySmall.textContent = text;
      if (!show && overlayReason !== "init") overlayReason = "none";
    }

    function stopPlayback() {
      playing = false;
      started = false;
      startAtServerMs = null;
      idx = 0;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try { vid.pause(); } catch {}
      hideAll();
      setState();
      if (!enabled) showOverlay(true, null, "init");
    }

    function hideAll() {
      if (img) img.classList.add("hidden");
      if (vid) vid.classList.add("hidden");
    }

    function showImage(url) {
      if (!img) return;
      if (vid) {
        try { vid.pause(); } catch {}
        vid.classList.add("hidden");
      }
      img.src = url;
      img.classList.remove("hidden");
    }

    async function showVideo(url) {
      if (!vid) return;
      if (img) img.classList.add("hidden");
      vid.src = url;
      vid.classList.remove("hidden");

      vid.muted = false;
      try {
        await vid.play();
        return true;
      } catch (e1) {
        try {
          vid.muted = true;
          await vid.play();
          return true;
        } catch (e2) {
          showOverlay(true, "Автовоспроизведение заблокировано. Нажми кнопку Enable ещё раз.", "error");
          return false;
        }
      }
    }

    function nextItem() {
      if (!playing || !playlist.length) return;
      idx = (idx + 1) % playlist.length;
      playIndex(idx);
    }

    function playIndex(i) {
      if (!playing || !playlist.length) return;
      if (timer) { clearTimeout(timer); timer = null; }

      const it = playlist[i];
      if (!it) return;

      if (it.type === "image") {
        showImage(it.url);
        const d = Number.isFinite(it.durationMs) ? it.durationMs : 5000;
        timer = setTimeout(() => nextItem(), Math.max(250, d));
      } else {
        showVideo(it.url).then((ok) => {
          if (!ok) return;
        });
      }
    }

    function scheduleStart() {
      if (!playing || !startAtServerMs || !playlist.length) return;

      ts.sync(5).then(() => {
        const serverNow = ts.serverNowMs();
        const delay = Math.max(0, startAtServerMs - serverNow);

        if (timer) { clearTimeout(timer); timer = null; }
        hideAll();

        timer = setTimeout(() => {
          started = true;
          idx = 0;
          showOverlay(false);
          setState();
          playIndex(0);
        }, delay);
      });
    }

    function onHintFullscreen() {
      if (!enabled) return;
      showOverlay(true, "Админ просит fullscreen. Нажми Enable (или F11).", "hint");
    }

    async function enable() {
      enabled = true;

      try {
        if (stage && stage.requestFullscreen) await stage.requestFullscreen();
      } catch {}

      try {
        if (vid) {
          vid.muted = true;
          vid.src = "";
        }
      } catch {}

      showOverlay(false);
      setState();

      if (playing && startAtServerMs) scheduleStart();
    }

    if (enableBtn) enableBtn.onclick = () => enable();

    if (vid) {
      vid.addEventListener("ended", () => nextItem());
      vid.addEventListener("error", () => nextItem());
    }

    ws.onStatus = (s) => setWs(s);

    ws.onMessage = (msg) => {
      if (msg.type === "pong") {
        ts.onPong(msg);
        return;
      }
      if (msg.type === "hint_fullscreen") {
        onHintFullscreen();
        return;
      }
      if (msg.type === "clear_overlay") {
        if (overlayReason === "hint") showOverlay(false);
        return;
      }
      if (msg.type === "error") {
        showOverlay(true, msg.message || "error", "error");
        return;
      }
      if (msg.type === "state") {
        const newPlaylist = Array.isArray(msg.playlist) ? msg.playlist : [];
        const newPlaying = !!msg.playing;
        const newPlayId = msg.playId || "";
        const newStart = Number.isFinite(msg.startAtServerMs) ? msg.startAtServerMs : null;

        const playChanged = newPlayId && newPlayId !== playId;

        if (!newPlaying) {
          playlist = newPlaylist;
          playId = "";
          startAtServerMs = null;
          stopPlayback();
          if (enabled) showOverlay(false);
          return;
        }

        if (playChanged || !playing) {
          playlist = newPlaylist;
          playing = true;
          playId = newPlayId;
          startAtServerMs = newStart;
          started = false;
          idx = 0;
          setState();

          if (!enabled) {
            showOverlay(true, "Идёт воспроизведение. Нажми Enable, чтобы разрешить autoplay/fullscreen.", "init");
          } else {
            scheduleStart();
          }
          return;
        }

        playing = true;
        setState();
      }
    };

    ws.connect();
    setState();
    showOverlay(true, null, "init");
  }

  if (role === "admin") buildAdmin();
  else buildClient();
})();
