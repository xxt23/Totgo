/*
 * 板块二 · 动态舒尔特方格 (Dynamic Schulte Grid)
 * 按升序点击打乱的数字；开启「动态重排」后，每次正确点击都会重新洗牌
 * 剩余数字与剩余格位，并用 transition 平滑位移。
 * 失误惩罚：计数 + 420ms 输入锁定，锁定时间挂在关卡时钟上（挂起时一并冻结）。
 */
(function (T) {
  'use strict';

  var U = T.utils;

  function Schulte(ctx) {
    this.ctx = ctx;
    this.next = 1;
    this.locked = false;
    this.finished = false;
    this.cells = [];
  }

  Schulte.prototype.init = function (root, cfg) {
    this.root = root; this.cfg = cfg;
    this.n = cfg.size; this.total = this.n * this.n;
    root.innerHTML = '';

    var wrap = document.createElement('div'); wrap.className = 'sch-wrap';
    var board = document.createElement('div'); board.className = 'sch-board no-anim';
    wrap.appendChild(board); root.appendChild(wrap);
    this.board = board;

    this.cells = [];
    for (var i = 0; i < this.total; i++) {
      var el = document.createElement('button');
      el.type = 'button'; el.className = 'sch-cell';
      board.appendChild(el);
      this.cells.push({ el: el, slot: i, value: 0, done: false });
    }

    var self = this;
    this.onClick = function (e) {
      var el = e.target.closest ? e.target.closest('.sch-cell') : null;
      if (el) self.pick(parseInt(el.dataset.slot, 10), e.clientX, e.clientY);
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
    this.reshuffle(true);                 // 首次分配：数字与格位一起打乱
    requestAnimationFrame(function () { board.classList.remove('no-anim'); });
    this.ctx.setProgress(0);
    this.ctx.setHint('按 01 → ' + U.pad(this.total) + ' 的顺序点击');
  };

  /** 剩余数字与剩余格位同时洗牌；已完成格保留原位，不再参与 */
  Schulte.prototype.reshuffle = function () {
    var pending = this.cells.filter(function (c) { return !c.done; });
    if (!pending.length) return;
    var slots = U.shuffle(pending.map(function (c) { return c.slot; }));
    var nums = [];
    for (var v = this.next; v <= this.total; v++) nums.push(v);
    nums = U.shuffle(nums);
    pending.forEach(function (c, i) {
      c.slot = slots[i];
      c.value = nums[i];
      c.el.dataset.slot = String(c.slot);
      c.el.textContent = U.pad(c.value);
    });
    this.layout();
  };

  Schulte.prototype.layout = function () {
    if (!this.board) return;
    var W = this.board.clientWidth;
    if (!W) return;
    var gap = U.clamp(Math.round(W * 0.016), 5, 10);
    var size = (W - gap * (this.n - 1)) / this.n;
    this.cells.forEach(function (c) {
      var row = Math.floor(c.slot / this.n), col = c.slot % this.n;
      c.el.style.width = size.toFixed(1) + 'px';
      c.el.style.height = size.toFixed(1) + 'px';
      c.el.style.fontSize = U.clamp(size * 0.3, 14, 30).toFixed(1) + 'px';
      c.el.style.transform = 'translate3d(' + (col * (size + gap)).toFixed(1) + 'px,' +
                             (row * (size + gap)).toFixed(1) + 'px,0)';
    }, this);
  };

  Schulte.prototype.start = function () {
    this.ctx.setHint('下一个 · ' + U.pad(this.next));
  };

  Schulte.prototype.pick = function (slot, x, y) {
    if (this.locked || this.finished || this.paused) return;
    var cell = this.cells.find(function (c) { return c.slot === slot && !c.done; });
    if (!cell) return;

    var ok = cell.value === this.next;
    this.ctx.recordClick(ok);

    if (ok) {
      cell.done = true;
      cell.el.classList.add('is-done');
      cell.el.textContent = '·';
      T.ui.ripple(this.board, x, y, 'hit');
      this.ctx.setProgress(Math.min(1, this.next / this.total));
      this.next++;
      if (this.next > this.total) {
        this.finished = true;
        this.ctx.setHint('全部完成');
        this.ctx.finish('complete');
        return;
      }
      this.ctx.setHint('下一个 · ' + U.pad(this.next));
      if (this.cfg.dynamic) this.reshuffle(false);
    } else {
      this.ctx.addPenalty(1);
      T.ui.ripple(this.board, x, y, 'miss');
      T.ui.shake(cell.el);
      cell.el.classList.add('is-wrong');
      this.locked = true;
      this.board.classList.add('is-locked');
      var self = this;
      this.ctx.after(420, function () {
        cell.el.classList.remove('is-wrong');
        self.locked = false;
        if (self.board) self.board.classList.remove('is-locked');
      });
    }
  };

  Schulte.prototype.pause = function () {
    this.paused = true;
    if (this.board) this.board.classList.add('is-paused');
  };
  Schulte.prototype.resume = function () {
    this.paused = false;
    if (this.board) this.board.classList.remove('is-paused');
  };
  Schulte.prototype.getScore = function () {
    return {
      progress: (this.next - 1) / this.total,
      summary: '数字 ' + (this.next - 1) + '/' + this.total + ' · ' + this.n + '×' + this.n +
               (this.cfg.dynamic ? ' · 动态' : ' · 静态')
    };
  };
  Schulte.prototype.exit = function () {
    if (this.ro) this.ro.disconnect();
    if (this.onResize) window.removeEventListener('resize', this.onResize);
    if (this.board) this.board.removeEventListener('click', this.onClick);
    if (this.root) this.root.innerHTML = '';
    this.board = null; this.root = null;
  };

  T.register({
    id: 'schulte',
    name: '动态舒尔特方格',
    subtitle: 'DYNAMIC SCHULTE GRID',
    description: '在打乱的网格里按升序找回数字。开启动态重排，每点对一个，剩下的都会重新落位。',
    defaultConfig: { size: 4, dynamic: true },
    configSchema: [
      { key: 'size', label: '网格', type: 'seg', options: [3, 4, 5].map(function (v) {
        return { value: v, label: v + '×' + v };
      }) },
      { key: 'dynamic', label: '动态重排', type: 'switch' }
    ],
    describe: function (c) { return c.size + '×' + c.size + ' · ' + (c.dynamic ? '动态重排' : '静态网格'); },
    create: function (ctx) { return new Schulte(ctx); }
  });
})(window.Totgo);
