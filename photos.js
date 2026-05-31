(function () {
   const TOTAL = 1444; // 0.jpg through 1443.jpg
   const canvas = document.getElementById('photo-canvas');
   const ctx = canvas.getContext('2d');

   // Shuffled pool so we cycle all photos before repeating
   const pool = Array.from({ length: TOTAL }, (_, i) => i);
   for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
   }
   let poolPos = 0;
   function nextIndex() {
      const idx = pool[poolPos % pool.length];
      poolPos++;
      return idx;
   }

   const cache = new Map();
   const CACHE_MAX = 80;

   function getUrl(i) {
      return chrome.runtime.getURL('photos/' + i + '.jpg');
   }

   async function getBitmap(i) {
      if (cache.has(i)) return cache.get(i);
      const resp = await fetch(getUrl(i));
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(i, bmp);
      return bmp;
   }

   async function prewarm(n) {
      const picks = [];
      for (let i = 0; i < n; i++) picks.push(nextIndex());
      await Promise.allSettled(picks.map(getBitmap));
      return picks;
   }

   let tiles = [];
   let speedVal = 1, densityVal = 14, sizeVar = 3, angleDeg = 0, raf;

   // ── Hover state ──
   // Use window-level tracking so pointer-events:none on the canvas doesn't block us.
   // Coordinates are already in viewport space, which matches canvas (top-left origin).
   let mouseX = -9999, mouseY = -9999;
   let hoveredTile = null;

   window.addEventListener('mousemove', e => {
      mouseX = e.clientX;
      mouseY = e.clientY;
   });
   window.addEventListener('mouseleave', () => {
      mouseX = -9999;
      mouseY = -9999;
   });

   function resize() { canvas.width = innerWidth; canvas.height = innerHeight; }
   window.addEventListener('resize', () => { resize(); respawnAll(); });
   resize();

   function rand(a, b) { return a + Math.random() * (b - a); }

   function makeTileData(bmp, spread) {
      const d = Math.random();
      const sz = 80 + d * (80 * sizeVar - 80);
      const w = sz * Math.max(0.8, Math.min(1.8, bmp.width / bmp.height));
      const h = sz;
      return {
         bmp, w, h, depth: d,
         x: rand(-w, canvas.width + w * 0.5),
         y: spread ? rand(-h, canvas.height + h) : -h - 10,
         speed: (0.25 + d * 2.0) * speedVal,
         alpha: 0.3 + d * 0.7,
         // Hover animation state
         hoverScale: 1,      // current rendered scale (lerps toward target)
         hoverAlpha: null,   // null = use base alpha; set during hover
         loading: false
      };
   }

   async function respawnTop(t) {
      if (t.loading) return;
      t.loading = true;
      const idx = nextIndex();
      try {
         const bmp = await getBitmap(idx);
         const d = Math.random();
         const sz = 80 + d * (80 * sizeVar - 80);
         t.bmp = bmp; t.depth = d;
         t.w = sz * Math.max(0.8, Math.min(1.8, bmp.width / bmp.height)); t.h = sz;
         t.x = rand(-t.w, canvas.width + t.w); t.y = -t.h - 10;
         t.speed = (0.25 + d * 2.0) * speedVal; t.alpha = 0.3 + d * 0.7;
         t.hoverScale = 1; t.hoverAlpha = null;
      } catch { }
      t.loading = false;
   }

   async function respawnAll() {
      cancelAnimationFrame(raf);
      tiles = [];
      hoveredTile = null;
      const initial = await prewarm(Math.min(densityVal, 20));
      for (let i = 0; i < densityVal; i++) {
         const idx = initial[i % initial.length];
         const bmp = cache.get(idx);
         if (bmp) tiles.push(makeTileData(bmp, true));
      }
      loop();
      for (let i = 0; i < 20; i++) getBitmap(nextIndex());
   }

   function drawRounded(bmp, x, y, w, h, r, a) {
      ctx.save(); ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath(); ctx.clip();
      ctx.drawImage(bmp, x, y, w, h); ctx.restore();
   }



   const LERP_IN = 0.08;   // zoom-in speed  (lower = slower/smoother)
   const LERP_OUT = 0.06;   // zoom-out speed
   const SCALE_TARGET = 1.5;
   const SPEED_HOVER_FACTOR = 0.15;  // tiles move at 15% speed while any tile is hovered

   let hasRevealed = false;
   function loop() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const ar = angleDeg * Math.PI / 180;
      const sorted = [...tiles].sort((a, b) => a.depth - b.depth);

      // ── Pass 1: advance positions, compute draw rects, detect hover ──
      // We do hit-testing BEFORE deciding anyHovered so speed applies this frame.
      hoveredTile = null;
      for (const t of sorted) {
         // Use previous hoverScale for hit-test (stable, matches what user sees)
         const scaledW = t.w * t.hoverScale;
         const scaledH = t.h * t.hoverScale;
         const ox = t.x - (scaledW - t.w) / 2;
         const oy = t.y - (scaledH - t.h) / 2;
         // Store draw coords on tile so pass 2 can reuse them
         t._ox = ox; t._oy = oy; t._sw = scaledW; t._sh = scaledH;
         if (mouseX >= ox && mouseX <= ox + scaledW &&
            mouseY >= oy && mouseY <= oy + scaledH) {
            hoveredTile = t; // topmost (last in sorted order) wins
         }
      }

      const anyHovered = hoveredTile !== null;
      const speedMult = anyHovered ? SPEED_HOVER_FACTOR : 1;

      // ── Pass 2: update animation state + move ──
      for (const t of sorted) {
         const isHovered = t === hoveredTile;
         const lerpFactor = isHovered ? LERP_IN : LERP_OUT;

         // Lerp scale
         const scaleTarget = isHovered ? SCALE_TARGET : 1;
         t.hoverScale += (scaleTarget - t.hoverScale) * lerpFactor;

         // Lerp alpha
         if (t.hoverAlpha === null) t.hoverAlpha = t.alpha;
         const alphaTarget = isHovered ? 1.0 : t.alpha;
         t.hoverAlpha += (alphaTarget - t.hoverAlpha) * lerpFactor;
         if (!isHovered && Math.abs(t.hoverAlpha - t.alpha) < 0.005) t.hoverAlpha = null;

         // Move
         t.x += Math.sin(ar) * t.speed * 0.5 * speedMult;
         t.y += Math.cos(ar) * t.speed * 0.5 * speedMult;

         if (t.y > canvas.height + t.h + 10 ||
            (angleDeg > 20 && t.x > canvas.width + t.w + 10) ||
            (angleDeg < -20 && t.x < -t.w * 2)) respawnTop(t);
      }

      // ── Pass 3: draw — hovered tile always on top ──
      const drawOrder = anyHovered
         ? [...sorted.filter(t => t !== hoveredTile), hoveredTile]
         : sorted;

      for (const t of drawOrder) {
         const scaledW = t.w * t.hoverScale;
         const scaledH = t.h * t.hoverScale;
         const ox = t.x - (scaledW - t.w) / 2;
         const oy = t.y - (scaledH - t.h) / 2;
         const drawAlpha = t.hoverAlpha !== null ? t.hoverAlpha : t.alpha;
         drawRounded(t.bmp, ox, oy, scaledW, scaledH, 10 * t.hoverScale, drawAlpha);
      }

      if (!hasRevealed && tiles.length > 0) {
         hasRevealed = true;
         requestAnimationFrame(() => { canvas.style.opacity = '1'; });
      }
      raf = requestAnimationFrame(loop);
   }

   // Settings panel
   const settingsBtn = document.getElementById('settings-btn');
   const panel = document.getElementById('photo-controls');
   settingsBtn.addEventListener('click', e => { e.stopPropagation(); panel.classList.toggle('open'); });
   document.addEventListener('click', e => { if (!panel.contains(e.target) && e.target !== settingsBtn) panel.classList.remove('open'); });

   chrome.storage.local.get(['speed', 'density', 'sizevar', 'angle'], r => {
      if (r.speed !== undefined) { speedVal = r.speed; document.getElementById('ctrl-speed').value = r.speed; document.getElementById('val-speed').textContent = parseFloat(r.speed).toFixed(1); }
      if (r.density !== undefined) { densityVal = Math.round(r.density); document.getElementById('ctrl-density').value = r.density; document.getElementById('val-density').textContent = Math.round(r.density); }
      if (r.sizevar !== undefined) { sizeVar = r.sizevar; document.getElementById('ctrl-sizevar').value = r.sizevar; document.getElementById('val-sizevar').textContent = parseFloat(r.sizevar).toFixed(1); }
      if (r.angle !== undefined) { angleDeg = r.angle; document.getElementById('ctrl-angle').value = r.angle; document.getElementById('val-angle').textContent = Math.round(r.angle) + '°'; }
      respawnAll();
   });

   function bindSlider(id, valId, setter, fmt) {
      document.getElementById(id).addEventListener('input', function () {
         const v = parseFloat(this.value); setter(v);
         document.getElementById(valId).textContent = fmt(v);
         chrome.storage.local.set({ [id.replace('ctrl-', '')]: v });
      });
   }
   bindSlider('ctrl-speed', 'val-speed', v => { speedVal = v; }, v => v.toFixed(1));
   bindSlider('ctrl-density', 'val-density', v => { densityVal = Math.round(v); respawnAll(); }, v => Math.round(v));
   bindSlider('ctrl-sizevar', 'val-sizevar', v => { sizeVar = v; }, v => v.toFixed(1));
   bindSlider('ctrl-angle', 'val-angle', v => { angleDeg = v; }, v => Math.round(v) + '°');
})();