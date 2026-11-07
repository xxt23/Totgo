/*
 * 板块三 · 色词判断 (Stroop / Color–Word Interference)
 * ---------------------------------------------------------------------------
 * 每轮随机抽两个不同颜色：一个作「字义」（写出来的词），一个作「字色」
 * （词实际渲染的颜色）。玩家要在两个纯文字按钮里选出「字色」对应的那个。
 * 干扰项从「既非字义、也非字色」的其余颜色中抽取，两个选项都不含字义，
 * 杜绝「排除与题目文字同名按钮」的字面作弊。
 * 左右位置每题 50% 随机对调；A / D（静默兼容 ← / →）直接触发对应按钮。
 *
 * 所有时间都挂在内核关卡时钟上：限时倒计时读 ctx.clock()，
 * 失误锁定 / 按压反馈用 ctx.after()，切屏挂起时一并冻结。
 * ---------------------------------------------------------------------------
 */
(function (T) {
  'use strict';

  var U = T.utils;

  // 低饱和禅意六色。颜色值由 style.css 的 --sw-* 变量按主题提供，
  // 因此关卡中切换纸白 / 墨黑主题时颜色会自动跟随，无需重建 DOM。
  var COLORS = [
    { key: 'red', name: '红色' },
    { key: 'yellow', name: '黄色' },
    { key: 'blue', name: '蓝色' },
    { key: 'green', name: '绿色' },
    { key: 'purple', name: '紫色' },
    { key: 'orange', name: '橙色' }
  ];
  var PACE_MS = { free: 0, focus: 2500, tight: 1500 };
  var PACE_TEXT = { free: '自在', focus: '单题 2.5s', tight: '单题 1.5s' };
  var LOCK_MS = 350;

  function Stroop(ctx) {
    this.ctx = ctx;
    this.paused = false;
    this.locked = false;
    this.finished = false;
    this.dead = false;
    this.index = 0;
    this.correct = 0;
    this.raf = 0;
  }

  Stroop.prototype.init = function (root, cfg) {
    this.root = root; this.cfg = cfg;
    this.total = cfg.rounds;
    this.limit = PACE_MS[cfg.pace] || 0;
    root.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'stroop-wrap';
    wrap.innerHTML =
      '<div class="stroop-stage">' +
        '<div class="stroop-word"></div>' +
        '<div class="stroop-timer" hidden><i></i></div>' +
      '</div>' +
      '<div class="stroop-options">' +
        '<button type="button" class="stroop-opt" data-side="left">' +
          '<span class="stroop-key mono">[A]</span><span class="stroop-label"></span>' +
        '</button>' +
        '<button type="button" class="stroop-opt" data-side="right">' +
          '<span class="stroop-key mono">[D]</span><span class="stroop-label"></span>' +
        '</button>' +
      '</div>';
    root.appendChild(wrap);
    this.wrap = wrap;
    this.wordEl = wrap.querySelector('.stroop-word');
    this.timerEl = wrap.querySelector('.stroop-timer');
    this.timerBar = wrap.querySelector('.stroop-timer i');
    this.btns = {
      left: wrap.querySelector('.stroop-opt[data-side="left"]'),
      right: wrap.querySelector('.stroop-opt[data-side="right"]')
    };

    var self = this;
    this.onClick = function (e) {
      var b = e.target.closest ? e.target.closest('.stroop-opt') : null;
      if (b) self.choose(b.dataset.side, e.clientX, e.clientY, false);
    };
    wrap.addEventListener('click', this.onClick);

    this.onKey = function (e) {
      if (e.repeat) return;                       // 过滤长按连发
      var key = (e.key || '').toLowerCase();
      var code = e.code || '';
      var isLeft = key === 'a' || code === 'KeyA' || key === 'arrowleft' || code === 'ArrowLeft';
      var isRight = key === 'd' || code === 'KeyD' || key === 'arrowright' || code === 'ArrowRight';
      if (!isLeft && !isRight) return;
      if (key.indexOf('arrow') === 0 || code.indexOf('Arrow') === 0) e.preventDefault();
      self.choose(isLeft ? 'left' : 'right', null, null, true);
    };
    window.addEventListener('keydown', this.onKey);
  };

  Stroop.prototype.next = function () {
    if (this.finished || this.dead) return;
    this.index++;
    if (this.index > this.total) {
      this.finished = true;
      this.ctx.finish('complete');
      return;
    }

    var pair = U.shuffle(COLORS).slice(0, 2);
    var meaning = pair[0];                       // 字义：写出来的词
    var ink = pair[1];                          // 字色：实际渲染色，也是正确答案
    this.answer = ink.key;

    this.wordEl.textContent = meaning.name;
    this.wordEl.style.color = 'var(--sw-' + ink.key + ')';

    // 防作弊：干扰项候选池严格剔除「字义」与「字色」。
    // 旧实现把字义本身当干扰项，玩家只需排除与题目文字同名的按钮就能作答，
    // 根本不必看清字色；这里改为从剩余 4 色中随机抽取，两个选项都不等于字义。
    var pool = COLORS.filter(function (c) {
      return c.key !== meaning.key && c.key !== ink.key;
    });
    var distractor = U.shuffle(pool)[0];

    var flip = Math.random() < 0.5;             // 左右 50% 随机对调
    this.options = {
      left: flip ? ink : distractor,
      right: flip ? distractor : ink
    };
    var self = this;
    ['left', 'right'].forEach(function (side) {
      var b = self.btns[side];
      b.querySelector('.stroop-label').textContent = self.options[side].name;
      b.classList.remove('is-wrong', 'is-right');
    });

    this.locked = false;
    this.deadline = this.limit ? this.ctx.clock() + this.limit : 0;
    this.timerEl.hidden = !this.limit;
    if (this.limit) this.timerBar.style.transform = 'scaleX(1)';
    this.ctx.setProgress((this.index - 1) / this.total);
    this.ctx.setHint('第 ' + this.index + ' / ' + this.total + ' 题 · 选出文字实际的颜色' +
                     (this.limit ? ' · ' + PACE_TEXT[this.cfg.pace] : ''));
  };

  Stroop.prototype.tick = function () {
    if (this.paused || this.locked || this.finished || !this.limit || !this.deadline) return;
    var now = this.ctx.clock();
    var left = Math.max(0, this.deadline - now);
    this.timerBar.style.transform = 'scaleX(' + (left / this.limit).toFixed(4) + ')';
    if (left <= 0) this.timeout();
  };

  Stroop.prototype.timeout = function () {
    if (this.locked || this.finished || this.dead) return;
    this.locked = true;
    this.ctx.addPenalty(1);                     // 超时记一次失误，不计入点击率
    var r = this.wordEl.getBoundingClientRect();
    T.ui.ripple(this.wrap, r.left + r.width / 2, r.top + r.height / 2, 'miss');
    T.ui.shake(this.wordEl);
    this.ctx.setHint('超时 · 记一次失误');
    var self = this;
    this.ctx.after(LOCK_MS, function () { if (!self.dead) self.next(); });
  };

  Stroop.prototype.choose = function (side, x, y, fromKey) {
    if (this.paused || this.locked || this.finished || this.dead) return;
    var btn = this.btns[side];
    var opt = this.options ? this.options[side] : null;
    if (!btn || !opt) return;

    // 键盘触发时，对应按钮给出一次轻量按下态
    if (fromKey) {
      btn.classList.add('is-active');
      var that = this;
      this.ctx.after(140, function () { if (btn) btn.classList.remove('is-active'); });
    }

    var r = btn.getBoundingClientRect();
    var cx = x == null ? r.left + r.width / 2 : x;
    var cy = y == null ? r.top + r.height / 2 : y;
    var ok = opt.key === this.answer;
    this.ctx.recordClick(ok);

    if (ok) {
      this.correct++;
      T.ui.ripple(this.wrap, cx, cy, 'hit');
      this.ctx.setProgress(this.index / this.total);
      this.next();                              // 答对无缝切题
    } else {
      this.locked = true;
      this.ctx.addPenalty(1);
      T.ui.ripple(this.wrap, cx, cy, 'miss');
      T.ui.shake(btn);
      T.ui.shake(this.wordEl, true);
      btn.classList.add('is-wrong');
      this.ctx.setHint('被字面意思带走了 · 稍等');
      var self = this;
      this.ctx.after(LOCK_MS, function () { if (!self.dead) self.next(); });
    }
  };

  Stroop.prototype.start = function () {
    this.next();
    var self = this;
    this.raf = requestAnimationFrame(function loop() {
      if (self.dead) return;
      self.tick();
      if (self.dead) return;
      self.raf = requestAnimationFrame(loop);
    });
  };

  Stroop.prototype.pause = function () {
    this.paused = true;
    if (this.wrap) this.wrap.classList.add('is-paused');
  };
  Stroop.prototype.resume = function () {
    this.paused = false;
    if (this.wrap) this.wrap.classList.remove('is-paused');
  };
  Stroop.prototype.getScore = function () {
    return {
      progress: this.correct / this.total,
      summary: '答对 ' + this.correct + '/' + this.total + ' 题'
    };
  };
  Stroop.prototype.exit = function () {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);   // 必须完整解绑
    if (this.wrap) this.wrap.removeEventListener('click', this.onClick);
    if (this.root) this.root.innerHTML = '';
    this.raf = 0; this.wrap = null; this.root = null;
  };

  T.register({
    id: 'stroop',
    name: '色词判断',
    subtitle: 'COLOR-WORD INTERFERENCE',
    description: '字义与字色不一致时，看清文字真正的颜色。',
    keyHint: '看清文字真正的颜色 · 选择 / A · D',   // 仅本板块需要实体按键提示
    defaultConfig: { rounds: 25, pace: 'free' },
    configSchema: [
      { key: 'rounds', label: '题数', type: 'seg', options: [15, 25, 40].map(function (v) {
        return { value: v, label: String(v) };
      }) },
      { key: 'pace', label: '节奏', type: 'seg', options: [
        { value: 'free', label: '自在' },
        { value: 'focus', label: '2.5s' },
        { value: 'tight', label: '1.5s' }
      ] }
    ],
    describe: function (c) { return c.rounds + ' 题 · ' + PACE_TEXT[c.pace]; },
    create: function (ctx) { return new Stroop(ctx); }
  });
})(window.Totgo);
