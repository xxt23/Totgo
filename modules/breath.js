/*
 * 板块四 · 潮汐呼吸 (Mindful Breathing)
 * ---------------------------------------------------------------------------
 * 4 层同心半透明圆环，像潮涌一样舒展 / 收拢；屏息相位叠加极轻微的双重脉动。
 *
 * 相位推进完全由 ctx.clock() 的绝对时间驱动：elapsed = clock() - startAt，
 * 不用自增 dt。因此切屏 pause() 时关卡时钟冻结，画面精确停在那一瞬；
 * resume() 后从同一相位平滑继续，不补时、不跳帧、不重启循环。
 *
 * 全程无点击、无惩罚：结算的有效点击率显示「—」、失误为 0。
 * ---------------------------------------------------------------------------
 */
(function (T) {
  'use strict';

  var PATTERNS = {
    tide: [
      { type: 'inhale', ms: 4000 },
      { type: 'exhale', ms: 6000 }
    ],
    box: [
      { type: 'inhale', ms: 4000 },
      { type: 'hold', ms: 4000 },
      { type: 'exhale', ms: 4000 },
      { type: 'hold', ms: 4000 }
    ],
    deep: [
      { type: 'inhale', ms: 4000 },
      { type: 'hold', ms: 7000 },
      { type: 'exhale', ms: 8000 }
    ]
  };
  var LABEL = { inhale: '吸气', hold: '屏息', exhale: '呼气' };
  var PATTERN_TEXT = {
    tide: '潮汐绵长 · 吸 4s · 呼 6s',
    box: '方盒均衡 · 吸 4s · 屏 4s · 呼 4s · 屏 4s',
    deep: '深度宁静 · 吸 4s · 屏 7s · 呼 8s'
  };
  var MIN_SCALE = 0.70;
  var MAX_SCALE = 1.12;

  function ease(t) { return 0.5 - 0.5 * Math.cos(Math.PI * t); }  // 正弦柔和缓动

  function Breath(ctx) {
    this.ctx = ctx;
    this.paused = false;
    this.dead = false;
    this.finished = false;
    this.raf = 0;
    this.elapsed = 0;
    this.cycles = 0;
  }

  Breath.prototype.init = function (root, cfg) {
    this.root = root; this.cfg = cfg;
    this.phases = PATTERNS[cfg.pattern] || PATTERNS.tide;
    this.cycleMs = this.phases.reduce(function (s, p) { return s + p.ms; }, 0);
    this.totalMs = cfg.duration * 60000;
    root.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'breath-wrap';
    var orb = document.createElement('div');
    orb.className = 'breath-orb';
    var rings = '';
    for (var i = 0; i < 4; i++) {
      rings += '<div class="breath-ring" data-layer="' + i + '"></div>';
    }
    orb.innerHTML = rings +
      '<div class="breath-center">' +
        '<div class="breath-phase"></div>' +
        '<div class="breath-count mono"></div>' +
      '</div>';
    wrap.appendChild(orb);
    root.appendChild(wrap);

    this.wrap = wrap;
    this.ringEls = Array.prototype.slice.call(orb.querySelectorAll('.breath-ring'));
    this.phaseEl = orb.querySelector('.breath-phase');
    this.countEl = orb.querySelector('.breath-count');
    this.ctx.setProgress(0);
    this.ctx.setHint(PATTERN_TEXT[cfg.pattern] + ' · ' + cfg.duration + ' 分钟 · 只需看着，不必操作');
  };

  /** 根据绝对已进行毫秒，算出当前相位、相位内进度与剩余毫秒 */
  Breath.prototype.stateAt = function (ms) {
    var pos = ms % this.cycleMs;
    var acc = 0;
    for (var i = 0; i < this.phases.length; i++) {
      var p = this.phases[i];
      if (pos < acc + p.ms) {
        return { phase: p.type, t: (pos - acc) / p.ms, remain: acc + p.ms - pos };
      }
      acc += p.ms;
    }
    var last = this.phases[this.phases.length - 1];
    return { phase: last.type, t: 1, remain: 0 };
  };

  Breath.prototype.render = function (st, ms) {
    var base;
    if (st.phase === 'inhale') {
      base = MIN_SCALE + (MAX_SCALE - MIN_SCALE) * ease(st.t);
    } else if (st.phase === 'exhale') {
      base = MAX_SCALE - (MAX_SCALE - MIN_SCALE) * ease(st.t);
    } else {
      // 屏息：保持舒展，叠加极轻微的双重脉动（心跳质感）
      var sec = ms / 1000;
      var pulse = 0.010 * Math.sin(2 * Math.PI * 1.05 * sec) +
                  0.005 * Math.sin(2 * Math.PI * 2.10 * sec);
      base = MAX_SCALE + pulse;
    }
    this.ringEls.forEach(function (el, i) {
      var layer = 1 + (3 - i) * 0.03;          // 外层舒展更多，潮涌有层次
      el.style.transform = 'scale(' + (base * layer).toFixed(4) + ')';
    });
    this.phaseEl.textContent = LABEL[st.phase];
    this.countEl.textContent = Math.ceil(st.remain / 1000) + 's';
    this.wrap.dataset.phase = st.phase;
  };

  Breath.prototype.tick = function () {
    if (this.paused || this.dead || this.finished) return;
    var ms = this.ctx.clock() - this.startAt;
    this.elapsed = Math.min(ms, this.totalMs);
    this.cycles = Math.floor(this.elapsed / this.cycleMs);
    this.ctx.setProgress(this.elapsed / this.totalMs);
    this.render(this.stateAt(this.elapsed), this.elapsed);

    if (this.elapsed >= this.totalMs) {
      this.finished = true;
      this.ctx.finish('complete');
    }
  };

  Breath.prototype.start = function () {
    this.startAt = this.ctx.clock();
    this.render(this.stateAt(0), 0);           // 首帧前先落定初始相位，不留空白
    var self = this;
    this.raf = requestAnimationFrame(function loop() {
      if (self.dead) return;
      self.tick();
      if (self.dead) return;
      self.raf = requestAnimationFrame(loop);
    });
  };

  Breath.prototype.pause = function () {
    this.paused = true;
    if (this.wrap) this.wrap.classList.add('is-paused');
  };
  Breath.prototype.resume = function () {
    this.paused = false;
    if (this.wrap) this.wrap.classList.remove('is-paused');
  };
  Breath.prototype.getScore = function () {
    return {
      progress: Math.min(1, this.elapsed / this.totalMs),
      summary: '完成 ' + this.cycles + ' 次呼吸循环'
    };
  };
  Breath.prototype.exit = function () {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    if (this.root) this.root.innerHTML = '';
    this.raf = 0; this.wrap = null; this.root = null;
  };

  T.register({
    id: 'breath',
    name: '潮汐呼吸',
    subtitle: 'MINDFUL BREATHING',
    description: '跟随潮涌与脉搏般的视觉节律，一呼一吸，平复思绪。',
    defaultConfig: { pattern: 'tide', duration: 2 },
    configSchema: [
      { key: 'pattern', label: '节律', type: 'seg', options: [
        { value: 'tide', label: '潮汐' },
        { value: 'box', label: '方盒' },
        { value: 'deep', label: '宁静' }
      ] },
      { key: 'duration', label: '时长', type: 'seg', options: [
        { value: 1, label: '1分钟' },
        { value: 2, label: '2分钟' },
        { value: 3, label: '3分钟' }
      ] }
    ],
    describe: function (c) { return PATTERN_TEXT[c.pattern] + ' · ' + c.duration + ' 分钟'; },
    create: function (ctx) { return new Breath(ctx); }
  });
})(window.Totgo);
