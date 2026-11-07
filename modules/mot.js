/*
 * 板块一 · 多目标视觉追踪 (Multiple Object Tracking / MOT)
 * 阶段机：cue 高亮 → fade 褪回同色 → move 平滑物理移动 → select 圈选 → reveal 回看
 * 全部阶段由同一个 rAF 循环按 dt 推进；暂停时 dt 不累加，切屏挂起不失真。
 */
(function (T) {
  'use strict';

  var U = T.utils;
  var SPEED = { slow: 34, mid: 58, fast: 88 };   // px / s

  function scatter(count, W, H, size) {
    var cols = Math.ceil(Math.sqrt(count * W / Math.max(H, 1)));
    var rows = Math.ceil(count / cols);
    var cw = W / cols, ch = H / rows, slots = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        slots.push({
          x: c * cw + Math.random() * Math.max(0, cw - size),
          y: r * ch + Math.random() * Math.max(0, ch - size)
        });
      }
    }
    return U.shuffle(slots).slice(0, count);
  }

  function MOT(ctx) {
    this.ctx = ctx;
    this.raf = 0;
    this.dead = false;
    this.last = 0;
    this.phase = 'idle';
    this.phaseT = 0;
    this.paused = false;
    this.round = 0;
    this.correct = 0;
    this.selected = 0;
    this.balls = [];
  }

  MOT.prototype.init = function (root, cfg) {
    this.root = root; this.cfg = cfg;
    root.innerHTML = '';
    var board = document.createElement('div');
    board.className = 'mot-board';
    root.appendChild(board);
    this.board = board;

    this.balls = [];
    for (var i = 0; i < cfg.balls; i++) {
      var el = document.createElement('div');
      el.className = 'mot-ball';
      el.dataset.id = String(i);
      board.appendChild(el);
      this.balls.push({ el: el, x: 0, y: 0, vx: 0, vy: 0, target: false, state: 'idle' });
    }
    var note = document.createElement('div');
    note.className = 'mot-note';
    board.appendChild(note);
    this.note = note;

    var self = this;
    this.onClick = function (e) {
      var el = e.target.closest ? e.target.closest('.mot-ball') : null;
      if (el) self.pick(parseInt(el.dataset.id, 10), e.clientX, e.clientY);
    };
    board.addEventListener('click', this.onClick);

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(function () { self.layout(); });
      this.ro.observe(board);
    } else {
      this.onResize = function () { self.layout(); };
      window.addEventListener('resize', this.onResize);
    }
    this.layout();
    this.totalTargets = cfg.targets * cfg.rounds;
  };

  MOT.prototype.layout = function () {
    if (!this.board) return;
    var W = this.board.clientWidth, H = this.board.clientHeight;
    if (!W || !H) return;
    this.W = W; this.H = H;
    this.size = U.clamp(Math.round(Math.min(W, H) / 13), 22, 34);
    var self = this;
    this.balls.forEach(function (b) {
      b.el.style.width = self.size + 'px';
      b.el.style.height = self.size + 'px';
      b.x = U.clamp(b.x, 0, W - self.size);
      b.y = U.clamp(b.y, 0, H - self.size);
      self.paint(b);
    });
  };

  MOT.prototype.paint = function (b) {
    b.el.style.transform = 'translate3d(' + b.x.toFixed(1) + 'px,' + b.y.toFixed(1) + 'px,0)';
  };

  MOT.prototype.start = function () {
    this.round = 0; this.correct = 0;
    this.newRound();
    this.last = this.ctx.clock();
    var self = this;
    this.raf = requestAnimationFrame(function loop() {
      if (self.dead) return;
      self.loop();                  // loop 内可能触发通关结算 → exit() 置 dead
      if (self.dead) return;        // 结算后不再调度下一帧，避免僵尸循环
      self.raf = requestAnimationFrame(loop);
    });
  };

  MOT.prototype.newRound = function () {
    this.round++;
    this.selected = 0;
    var cfg = this.cfg;
    var ids = U.shuffle(this.balls.map(function (_, i) { return i; }));
    var targets = ids.slice(0, cfg.targets);
    var self = this;
    var pos = scatter(cfg.balls, this.W || 600, this.H || 400, this.size || 28);
    var v = SPEED[cfg.speed] || SPEED.mid;

    this.balls.forEach(function (b, i) {
      b.target = targets.indexOf(i) !== -1;
      b.state = 'idle';
      b.x = pos[i].x; b.y = pos[i].y;
      var ang = Math.random() * Math.PI * 2;
      var sp = v * (0.85 + Math.random() * 0.3);
      b.vx = Math.cos(ang) * sp; b.vy = Math.sin(ang) * sp;
      b.el.className = 'mot-ball' + (b.target ? ' is-target' : '');
      self.paint(b);
    });

    this.phase = 'cue'; this.phaseT = 0;
    this.ctx.setHint('第 ' + this.round + ' / ' + cfg.rounds + ' 轮 · 记住高亮的 ' + cfg.targets + ' 颗');
    this.setNote('记住它们');
    this.ctx.setProgress(this.correct / this.totalTargets);
  };

  MOT.prototype.setNote = function (text) {
    this.note.textContent = text;
    this.note.classList.add('is-on');
  };

  MOT.prototype.enterFade = function () {
    this.phase = 'fade'; this.phaseT = 0;
    // 先恢复同色并保持静止，颜色过渡结束后才开始移动
    this.balls.forEach(function (b) { b.el.className = 'mot-ball'; });
    this.setNote('颜色褪去 · 只用眼睛跟住');
    this.ctx.setHint('追踪中 · 保持视线');
  };

  MOT.prototype.enterMove = function () {
    this.phase = 'move'; this.phaseT = 0;
    this.setNote('跟住它们');
    this.ctx.setHint('追踪中 · ' + this.cfg.seconds + ' 秒');
  };

  MOT.prototype.step = function (dt) {
    var W = this.W, H = this.H, s = this.size, self = this;
    this.balls.forEach(function (b) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x <= 0) { b.x = 0; b.vx = Math.abs(b.vx); }
      if (b.y <= 0) { b.y = 0; b.vy = Math.abs(b.vy); }
      if (b.x >= W - s) { b.x = W - s; b.vx = -Math.abs(b.vx); }
      if (b.y >= H - s) { b.y = H - s; b.vy = -Math.abs(b.vy); }
    });
    // 轻互斥：避免小球叠在一起，让运动始终可读
    var minD = s + 8;
    for (var i = 0; i < this.balls.length; i++) {
      for (var j = i + 1; j < this.balls.length; j++) {
        var a = this.balls[i], b = this.balls[j];
        var dx = b.x - a.x, dy = b.y - a.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 0.001;
        if (d < minD) {
          var ux = dx / d, uy = dy / d, push = (minD - d) / 2;
          a.x -= ux * push; a.y -= uy * push;
          b.x += ux * push; b.y += uy * push;
          var va = a.vx * ux + a.vy * uy, vb = b.vx * ux + b.vy * uy;
          if (va > vb) {
            a.vx += (vb - va) * ux; a.vy += (vb - va) * uy;
            b.vx += (va - vb) * ux; b.vy += (va - vb) * uy;
          }
        }
      }
    }
    this.balls.forEach(function (b) {
      b.x = U.clamp(b.x, 0, W - s); b.y = U.clamp(b.y, 0, H - s);
      self.paint(b);
    });
  };

  MOT.prototype.enterSelect = function () {
    this.phase = 'select'; this.phaseT = 0;
    this.balls.forEach(function (b) { b.el.classList.add('is-selectable'); });
    this.setNote('请圈选 ' + this.cfg.targets + ' 颗');
    this.ctx.setHint('圈选阶段 · 点击你认出的目标球');
  };

  MOT.prototype.pick = function (i, x, y) {
    if (this.phase !== 'select' || this.paused) return;
    var b = this.balls[i];
    if (!b || b.state !== 'idle') return;
    this.selected++;
    var ok = b.target;
    b.state = ok ? 'correct' : 'wrong';
    b.el.classList.remove('is-selectable');
    b.el.classList.add(ok ? 'is-correct' : 'is-wrong');
    this.ctx.recordClick(ok);
    if (ok) {
      this.correct++;
      T.ui.ripple(this.board, x, y, 'hit');
    } else {
      this.ctx.addPenalty(1);
      T.ui.ripple(this.board, x, y, 'miss');
      T.ui.shake(b.el);
      T.ui.shake(this.board, true);
    }
    this.ctx.setProgress(this.correct / this.totalTargets);
    if (this.selected >= this.cfg.targets) this.enterReveal();
  };

  MOT.prototype.enterReveal = function () {
    this.phase = 'reveal'; this.phaseT = 0;
    var hit = 0;
    this.balls.forEach(function (b) {
      b.el.classList.remove('is-selectable');
      if (b.state === 'correct') hit++;
      if (b.target && b.state === 'idle') b.el.classList.add('is-missed'); // 漏选
    });
    this.setNote('本轮 ' + hit + ' / ' + this.cfg.targets + ' 颗');
    this.ctx.setHint('回看 · 虚线圈为漏选的目标');
  };

  /**
   * 阶段时间直接取关卡时钟（与结算的「消耗时长」同源）。
   * 挂起时关卡时钟静止，阶段机随之静止，恢复后不跳帧、不补时。
   */
  MOT.prototype.loop = function () {
    var now = this.ctx.clock();
    var dt = Math.max(0, now - this.last);
    this.last = now;
    if (this.paused) return;
    this.phaseT += dt;
    if (this.phase === 'cue') {
      if (this.phaseT >= 1600) this.enterFade();
    } else if (this.phase === 'fade') {
      if (this.phaseT >= 550) this.enterMove();
    } else if (this.phase === 'move') {
      this.step(Math.min(dt, 50) / 1000);   // 仅物理步长限幅，阶段时长不打折
      if (this.phaseT >= this.cfg.seconds * 1000) this.enterSelect();
    } else if (this.phase === 'reveal') {
      if (this.phaseT >= 1400) {
        if (this.round >= this.cfg.rounds) this.ctx.finish('complete');
        else this.newRound();
      }
    }
  };

  MOT.prototype.pause = function () {
    this.paused = true;
    if (this.board) this.board.classList.add('is-paused');
  };
  MOT.prototype.resume = function () {
    this.paused = false;
    this.last = this.ctx.clock();
    if (this.board) this.board.classList.remove('is-paused');
  };
  MOT.prototype.getScore = function () {
    return {
      progress: this.correct / this.totalTargets,
      summary: '目标 ' + this.correct + '/' + this.totalTargets + ' 颗 · ' + this.cfg.rounds + ' 轮'
    };
  };
  MOT.prototype.exit = function () {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    if (this.ro) this.ro.disconnect();
    if (this.onResize) window.removeEventListener('resize', this.onResize);
    if (this.board) this.board.removeEventListener('click', this.onClick);
    if (this.root) this.root.innerHTML = '';
    this.raf = 0; this.board = null;
  };

  T.register({
    id: 'mot',
    name: '多目标视觉追踪',
    subtitle: 'MULTIPLE OBJECT TRACKING',
    description: '记住高亮的小球。它们褪回同色后开始流动，停下时，把它们一一圈出来。',
    defaultConfig: { targets: 3, balls: 8, seconds: 5, rounds: 3, speed: 'mid' },
    configSchema: [
      { key: 'targets', label: '目标数', type: 'seg', options: [2, 3, 4, 5].map(function (v) { return { value: v, label: String(v) }; }) },
      { key: 'balls', label: '球总数', type: 'seg', options: [6, 8, 10, 12].map(function (v) { return { value: v, label: String(v) }; }) },
      { key: 'seconds', label: '追踪时长', type: 'seg', options: [3, 5, 8].map(function (v) { return { value: v, label: v + 's' }; }) },
      { key: 'rounds', label: '轮数', type: 'seg', options: [2, 3, 5].map(function (v) { return { value: v, label: String(v) }; }) },
      { key: 'speed', label: '流动速度', type: 'seg', options: [
        { value: 'slow', label: '缓' }, { value: 'mid', label: '中' }, { value: 'fast', label: '快' }
      ] }
    ],
    describe: function (c) {
      var s = { slow: '缓', mid: '中', fast: '快' }[c.speed] || '中';
      return c.targets + ' 目标 · ' + c.balls + ' 球 · ' + c.seconds + 's · ' + c.rounds + ' 轮 · ' + s + '速';
    },
    create: function (ctx) { return new MOT(ctx); }
  });
})(window.Totgo);
