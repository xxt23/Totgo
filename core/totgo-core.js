/*
 * Totgo · 内核 (v1.1)
 * ---------------------------------------------------------------------------
 * 职责：双层计时器、切屏挂起、模块注册表、关卡生命周期调度、统一结算、
 *       本地训练档案（历史 / 最佳成绩 / 次数）、JSON 备份导出与导入。
 * 不依赖任何第三方库 / 网络资源；普通 <script> 加载，file:// 双击即可运行。
 *
 * 计时口径（v1.1 起）
 *   · 首页不跑表：boot() 时 globalClock 处于 pause() 静止状态，且不启动 rAF。
 *   · 关卡内：openLevel + 模块 start() 后，globalClock 与 levelClock 同步运行，
 *     顶栏显示「今日已完成 + 本关实时」。
 *   · 结算：settle() 冻结关卡时钟，把该局消耗时长一次性累加进
 *     「今日有效训练」与「历史累计训练」。首页只显示已完成的训练总和。
 *
 * 统一关卡接口（LevelModule）—— v1.1 未做任何变更，模块文件保持零改动
 *   def = {
 *     id, name, subtitle, description,
 *     available, slot,                       // slot=true 表示未接入的预留位
 *     defaultConfig, configSchema,          // 难度控件由内核统一渲染
 *     describe(cfg) -> string,              // 可选：稳定难度摘要（用于最佳成绩分档）
 *     create(ctx) -> instance
 *   }
 *   instance = {
 *     init(rootEl, config, ctx),             // 挂载 DOM / 绑定事件
 *     start(),                              // 开始（关卡时钟已启动）
 *     pause(), resume(),                    // 切屏挂起 / 恢复（必须停止自身动画与计时）
 *     exit(),                               // 释放 rAF、监听器、DOM
 *     getScore() -> { progress: 0..1, summary?: string }
 *   }
 *   ctx（内核注入，模块只通过它与外界通信）
 *     clock()                               // 当前关卡毫秒（已扣除挂起时间）
 *     recordClick(effective: boolean)       // 统一上报一次点击，驱动「有效点击率」
 *     addPenalty(n = 1)                     // 统一上报失误惩罚次数
 *     setProgress(0..1)  setHint(text)
 *     after(ms, fn)                         // 挂在关卡时钟上的延时，挂起时一并冻结
 *     finish('complete' | 'quit')
 *     ui.ripple(container, clientX, clientY, 'hit' | 'miss')
 *     ui.shake(el, soft?)
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var STORAGE = {
    total:   'totgo.totalTrainingMs',   // 历史累计训练时长（仅已结算的关卡）
    daily:   'totgo.dailyStats',        // { 'YYYY-MM-DD': ms }
    history: 'totgo.history',           // 最近 100 条训练记录
    best:    'totgo.bestTimes',         // { 'moduleId|难度': { durationMs, ... } }
    counts:  'totgo.moduleCounts',      // { moduleId: 累计练习次数 }
    theme:   'totgo.theme',
    config:  'totgo.config'
  };
  var PREFIX = 'totgo.';
  var HISTORY_LIMIT = 100;
  var HISTORY_SHOW = 10;
  var DAY_LIMIT = 90;
  var LIFECYCLE = ['init', 'start', 'pause', 'resume', 'exit', 'getScore'];

  /* ── 极简工具 ───────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function store(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* 隐私模式降级 */ } }
  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function readNumber(key, dft) { var n = parseFloat(read(key)); return isFinite(n) && n >= 0 ? n : dft; }
  function readJSON(key, dft) { try { return JSON.parse(read(key)) || dft; } catch (e) { return dft; } }
  function pad(n, w) { return String(n).padStart(w || 2, '0'); }

  /** 本地日期键（不用 toISOString，避免 UTC 偏移导致跨日错位） */
  function dayKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /** 历史日志里的 MM-DD HH:mm */
  function stamp(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** 毫秒 → MM:SS.CC（百分秒，精确至 0.01s） */
  function formatTime(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var cs = Math.floor(ms / 10);
    var cc = cs % 100;
    var sec = Math.floor(cs / 100);
    return pad(Math.floor(sec / 60)) + ':' + pad(sec % 60) + '.' + pad(cc);
  }

  /** 按钮的轻反馈：临时换文字，不使用任何浏览器弹窗 */
  function flash(btn, text) {
    if (!btn) return;
    var old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = text;
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(function () { btn.textContent = old; }, 1800);
  }

  /** 收集本机所有 totgo.* 存储项（未来新增 key 自动纳入备份） */
  function collectStorage() {
    var out = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) out[k] = localStorage.getItem(k);
      }
    } catch (e) { /* 隐私模式：导出内存态由 saveAll 兜底 */ }
    return out;
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  /**
   * 单调时钟：只信 performance.now()，不因系统时间调整或帧率抖动而失真。
   * value() = 已完成片段累加 + 当前片段(performance.now() - 锚点)
   * pause() 时把当前片段结算进 accum；切屏挂起即调用 pause/resume。
   */
  function Clock() {
    this.accum = 0;
    this.anchor = null;
    this.active = false;
  }
  Clock.prototype.start = function () {
    this.accum = 0; this.anchor = performance.now(); this.active = true; return this;
  };
  Clock.prototype.pause = function () {
    if (!this.active) return;
    this.accum += performance.now() - this.anchor;
    this.anchor = null; this.active = false;
  };
  Clock.prototype.resume = function () {
    if (this.active) return;
    this.anchor = performance.now(); this.active = true;
  };
  Clock.prototype.value = function () {
    return this.accum + (this.active ? performance.now() - this.anchor : 0);
  };

  /* ── 细腻反馈 ───────────────────────────────────────────── */
  var ui = {
    /** 成功 / 失误的微波纹：挂在容器上，坐标用 clientX/clientY */
    ripple: function (container, clientX, clientY, tone) {
      if (!container) return;
      var r = container.getBoundingClientRect();
      var s = document.createElement('span');
      s.className = 'ripple' + (tone === 'miss' ? ' is-miss' : '');
      s.style.left = (clientX - r.left) + 'px';
      s.style.top = (clientY - r.top) + 'px';
      container.appendChild(s);
      setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 780);
    },
    /** 失误轻晃动：使用独立 translate 属性，不覆盖元素的 transform 定位 */
    shake: function (el, soft) {
      if (!el) return;
      var cls = soft ? 'shake-soft' : 'shake';
      el.classList.remove('shake', 'shake-soft');
      void el.offsetWidth;
      el.classList.add(cls);
      setTimeout(function () { el.classList.remove(cls); }, 360);
    }
  };

  /* ── 插件注册表 ─────────────────────────────────────────── */
  var registry = [];
  function register(def) {
    if (!def || !def.id || !def.name) throw new Error('[Totgo] 模块必须提供 id 与 name');
    if (registry.some(function (m) { return m.id === def.id; })) {
      throw new Error('[Totgo] 模块 id 重复：' + def.id);
    }
    registry.push(Object.assign({
      subtitle: '', description: '', slot: false, available: true,
      configSchema: [], defaultConfig: {}, describe: null
    }, def));
    return def;
  }

  /** 稳定难度摘要：只由配置推导，不含本局成绩，用于最佳成绩分档 */
  function describeConfig(def, cfg) {
    if (typeof def.describe === 'function') return def.describe(cfg);
    var parts = (def.configSchema || []).map(function (f) {
      var opt = (f.options || []).find(function (o) { return o.value === cfg[f.key]; });
      return f.label + ' ' + (opt ? opt.label : (cfg[f.key] ? '开' : '关'));
    });
    return parts.join(' · ') || '标准难度';
  }

  /* ── 发布元信息（唯一来源：版本 v1.0 / 作者·品牌署名 Tot） ────── */
  var VERSION = 'v1.0';
  var AUTHOR = 'Tot';

  /* ── 应用外壳 ───────────────────────────────────────────── */
  var App = {
    totalTrainingMs: 0,          // 历史累计训练时长
    daily: {},                   // 每日有效训练时长
    history: [],                 // 训练记录（最新在前，最多 100 条）
    best: {},                    // 分模块 / 分难度最佳通关耗时
    counts: {},                  // 分模块累计练习次数
    configCache: {},

    levelClock: new Clock(),     // 关卡计时器（ctx.clock() 的唯一数据源）
    globalClock: new Clock(),    // 全局训练跑表：仅关卡内运行，首页静止
    ticker: 0,
    timers: [],
    state: null,
    inst: null,
    inLevel: false,
    settled: false,
    suspended: false,
    clearArmed: false,
    clearTimer: 0,

    /* ── 启动：首页不跑表 ─────────────────────────────────── */
    boot: function () {
      this.loadData();
      document.documentElement.dataset.theme = read(STORAGE.theme) === 'ink' ? 'ink' : 'paper';
      this.globalClock.start();
      this.globalClock.pause();      // 关键：启动即静止，首页绝不空转
      this.levelClock.start();
      this.levelClock.pause();
      this.bind();
      // UI 底部统一展示发布元信息（HTML 中已写静态兜底值）
      if ($('footer-brand')) $('footer-brand').textContent =
        AUTHOR + ' · 纯单机 · 零联网请求 · 数据仅存于本机浏览器';
      if ($('footer-version')) $('footer-version').textContent = VERSION + ' · © ' + AUTHOR;
      this.refreshHome();            // 静态渲染，不启动 rAF
    },

    loadData: function () {
      this.totalTrainingMs = readNumber(STORAGE.total, 0);
      this.daily = readJSON(STORAGE.daily, {});
      if (!this.daily || typeof this.daily !== 'object' || Array.isArray(this.daily)) this.daily = {};
      this.history = readJSON(STORAGE.history, []);
      if (!Array.isArray(this.history)) this.history = [];
      this.best = readJSON(STORAGE.best, {});
      if (!this.best || typeof this.best !== 'object' || Array.isArray(this.best)) this.best = {};
      this.counts = readJSON(STORAGE.counts, {});
      if (!this.counts || typeof this.counts !== 'object' || Array.isArray(this.counts)) this.counts = {};
      this.configCache = readJSON(STORAGE.config, {});
    },

    saveAll: function () {
      store(STORAGE.total, String(this.totalTrainingMs));
      store(STORAGE.daily, JSON.stringify(this.daily));
      store(STORAGE.history, JSON.stringify(this.history));
      store(STORAGE.best, JSON.stringify(this.best));
      store(STORAGE.counts, JSON.stringify(this.counts));
      store(STORAGE.config, JSON.stringify(this.configCache));
      store(STORAGE.theme, document.documentElement.dataset.theme || 'paper');
    },

    /* ── 事件绑定 ─────────────────────────────────────────── */
    bind: function () {
      var self = this;
      $('theme-toggle').addEventListener('click', function () {
        var next = document.documentElement.dataset.theme === 'paper' ? 'ink' : 'paper';
        document.documentElement.dataset.theme = next;
        store(STORAGE.theme, next);
      });
      $('btn-pause').addEventListener('click', function () {
        if (!self.inLevel || self.settled) return;
        if (self.suspended) self.resume(); else self.suspend();
      });
      $('btn-home').addEventListener('click', function () { self.goHome(); });
      $('btn-retry').addEventListener('click', function () { self.retry(); });
      $('btn-resume').addEventListener('click', function () { self.resume(); });

      // 「提前结束」仅允许真实鼠标点击：键盘触发的 click 其 event.detail 为 0
      function mouseOnly(e, fn) { if (e.detail > 0) fn(); }
      $('btn-abort').addEventListener('click', function (e) {
        mouseOnly(e, function () { self.abortTraining(); });
      });
      $('btn-abort-pause').addEventListener('click', function (e) {
        mouseOnly(e, function () { self.abortTraining(); });
      });

      $('btn-export').addEventListener('click', function () { self.exportData(); });
      $('btn-import').addEventListener('click', function () { $('import-file').click(); });
      $('import-file').addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var payload = JSON.parse(String(reader.result));
            if (!payload || payload.app !== 'Totgo' || !payload.data ||
                typeof payload.data !== 'object' || Array.isArray(payload.data)) {
              throw new Error('格式不符');
            }
            self.applyBackup(payload.data);
            flash($('btn-import'), '已导入');
          } catch (err) {
            flash($('btn-import'), '格式不符');
          }
        };
        reader.onerror = function () { flash($('btn-import'), '读取失败'); };
        reader.readAsText(file, 'utf-8');
        e.target.value = '';        // 允许重复导入同一文件
      });

      $('btn-clear-history').addEventListener('click', function () {
        var btn = $('btn-clear-history');
        if (!self.clearArmed) {
          self.clearArmed = true;
          btn.textContent = '再点一次确认清空';
          btn.classList.add('is-armed');
          clearTimeout(self.clearTimer);
          self.clearTimer = setTimeout(function () {
            self.clearArmed = false;
            btn.textContent = '清空记录';
            btn.classList.remove('is-armed');
          }, 4000);
          return;
        }
        clearTimeout(self.clearTimer);
        self.clearArmed = false;
        btn.textContent = '清空记录';
        btn.classList.remove('is-armed');
        self.clearRecords();
      });

      // 只有「关卡进行中」需要用户显式点「继续」；首页与结算界面静默清标志
      function needManualResume() { return self.inLevel && !self.settled; }
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) self.suspend();
        else if (!needManualResume()) self.resume();
      });
      window.addEventListener('blur', function () { self.suspend(); });
      window.addEventListener('focus', function () {
        if (!document.hidden && !needManualResume()) self.resume();
      });
      // Space / Esc 只负责「暂歇 ↔ 继续」，绝不触发结算
      window.addEventListener('keydown', function (e) {
        var k = e.key || '', code = e.code || '';
        var isSpace = k === ' ' || k === 'Spacebar' || code === 'Space';
        var isEsc = k === 'Escape' || k === 'Esc' || code === 'Escape';
        if (!isSpace && !isEsc) return;
        if (!self.inLevel || self.settled) return;   // 首页 / 结算卡片：不拦截
        e.preventDefault();                          // 防空格滚动与焦点按钮二次点击
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        if (self.suspended) self.resume();
        else self.suspend();
      });
    },

    /* ── 首页数据渲染 ─────────────────────────────────────── */
    todayMs: function () { return Number(this.daily[dayKey()]) || 0; },
    totalCount: function () {
      var n = 0;
      Object.keys(this.counts).forEach(function (k) { n += Number(this.counts[k]) || 0; }, this);
      return n;
    },
    bestOf: function (moduleId) {
      var best = null;
      Object.keys(this.best).forEach(function (k) {
        var b = this.best[k];
        if (b && b.moduleId === moduleId && isFinite(b.durationMs)) {
          if (!best || b.durationMs < best.durationMs) best = b;
        }
      }, this);
      return best;
    },

    refreshHome: function () {
      var live = (this.inLevel && !this.settled) ? this.globalClock.value() : 0;
      $('global-time').textContent = formatTime(this.todayMs() + live);
      $('today-time').textContent = formatTime(this.todayMs());
      $('total-time').textContent = formatTime(this.totalTrainingMs);
      $('total-count').textContent = String(this.totalCount());
      this.renderCards();
      this.renderHistory();
    },

    /** 首页卡片 / 难度控件（全部由 configSchema 驱动，新增模块零改动） */
    renderCards: function () {
      var self = this, grid = $('module-grid');
      grid.innerHTML = '';
      registry.forEach(function (def, i) {
        var card = document.createElement('article');
        card.className = 'card' + (def.slot ? ' card-slot' : '');
        var head = document.createElement('div');
        head.className = 'card-top';
        head.innerHTML = '<span class="card-index">' + pad(i + 1) + ' / ' + pad(registry.length) + '</span>' +
                         (def.slot ? '' : '<span class="card-tag">AVAILABLE</span>');
        var h3 = document.createElement('h3'); h3.textContent = def.name;
        card.appendChild(head); card.appendChild(h3);

        if (def.slot) {
          // 预留插槽：仅保留序号与标题，不再渲染徽标、说明或代码字样
        } else {
          var sub = document.createElement('div'); sub.className = 'card-sub'; sub.textContent = def.subtitle;
          var desc = document.createElement('p'); desc.className = 'card-desc'; desc.textContent = def.description;
          card.appendChild(sub); card.appendChild(desc);

          // 一行极简小字：定长放松训练（潮汐呼吸）不适用「最快通关耗时」
          var b = self.bestOf(def.id);
          var stat = document.createElement('div');
          stat.className = 'card-stat mono';
          stat.textContent = def.id === 'breath'
            ? '练习 ' + (Number(self.counts[def.id]) || 0) + ' 次'
            : '最佳 ' + (b ? formatTime(b.durationMs) : '—') +
              ' · 练习 ' + (Number(self.counts[def.id]) || 0) + ' 次';
          card.appendChild(stat);

          var cfgBox = document.createElement('div');
          cfgBox.className = 'cfg';
          var cfg = self.getConfig(def);
          (def.configSchema || []).forEach(function (f) {
            var row = document.createElement('div'); row.className = 'cfg-row';
            var label = document.createElement('span');
            label.className = 'cfg-label'; label.textContent = f.label;
            var group = document.createElement('div'); group.className = 'cfg-group';
            if (f.type === 'switch') {
              var sw = document.createElement('button');
              sw.type = 'button'; sw.className = 'switch' + (cfg[f.key] ? ' is-on' : '');
              sw.textContent = cfg[f.key] ? '开' : '关';
              sw.addEventListener('click', function () {
                self.setConfig(def, f.key, !self.getConfig(def)[f.key]);
                var v = !!self.getConfig(def)[f.key];
                sw.textContent = v ? '开' : '关';
                sw.classList.toggle('is-on', v);
              });
              group.appendChild(sw);
            } else {
              (f.options || []).forEach(function (o) {
                var b2 = document.createElement('button');
                b2.type = 'button';
                b2.className = 'seg' + (cfg[f.key] === o.value ? ' is-on' : '');
                b2.textContent = o.label;
                b2.addEventListener('click', function () {
                  self.setConfig(def, f.key, o.value);
                  Array.prototype.forEach.call(group.children, function (x) { x.classList.remove('is-on'); });
                  b2.classList.add('is-on');
                });
                group.appendChild(b2);
              });
            }
            row.appendChild(label); row.appendChild(group); cfgBox.appendChild(row);
          });
          var enter = document.createElement('button');
          enter.type = 'button'; enter.className = 'enter-btn';
          enter.innerHTML = '<span>进入练习</span><span class="arrow">→</span>';
          enter.addEventListener('click', function () { self.openLevel(def); });
          card.appendChild(cfgBox); card.appendChild(enter);
        }
        grid.appendChild(card);
      });
    },

    /** 近期训练日志：最近 10 条，等宽表格 */
    renderHistory: function () {
      var tbody = $('history-body'), table = $('history-table'), empty = $('history-empty');
      tbody.innerHTML = '';
      var list = this.history.slice(0, HISTORY_SHOW);
      table.hidden = list.length === 0;
      empty.hidden = list.length > 0;
      list.forEach(function (r) {
        var tr = document.createElement('tr');
        function td(text, cls, title) {
          var d = document.createElement('td');
          if (cls) d.className = cls;
          d.textContent = text;
          if (title) d.title = title;
          tr.appendChild(d);
        }
        td(stamp(r.timestamp), 'col-time mono');
        td(r.moduleName || '—', 'col-name');
        td(r.difficultySummary || '—', 'col-diff', r.difficultySummary || '');
        var s = document.createElement('td');
        var badge = document.createElement('span');
        badge.className = 'state ' + (r.reason === 'complete' ? 'state-done' : 'state-quit');
        badge.textContent = r.reason === 'complete' ? '完成' : '提前结束';
        s.appendChild(badge); tr.appendChild(s);
        td(formatTime(r.durationMs), 'mono');
        td(r.accuracy == null ? '—' : (r.accuracy * 100).toFixed(1) + '%', 'mono');
        tbody.appendChild(tr);
      });
    },

    clearRecords: function () {
      this.history = []; this.best = {}; this.counts = {};
      store(STORAGE.history, '[]');
      store(STORAGE.best, '{}');
      store(STORAGE.counts, '{}');
      this.refreshHome();              // 累计时长与今日时长保留
    },

    /* ── 备份：导出 / 导入 ────────────────────────────────── */
    exportData: function () {
      this.saveAll();
      var payload = {
        app: 'Totgo', version: 1,
        exportedAt: new Date().toISOString(),
        data: collectStorage()
      };
      download('totgo-backup-' + dayKey().replace(/-/g, '') + '.json', JSON.stringify(payload, null, 2));
      flash($('btn-export'), '已导出');
    },

    applyBackup: function (data) {
      // 关卡进行中先静默收束（不结算、不落档），避免残留时钟污染导入后的档案
      if (this.inLevel) this.goHome();
      try {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(PREFIX) === 0) keys.push(k);
        }
        keys.forEach(function (key) { try { localStorage.removeItem(key); } catch (e) { /* 忽略 */ } });
      } catch (e) { /* 隐私模式：仅覆盖写入 */ }
      Object.keys(data).forEach(function (k) {
        if (k.indexOf(PREFIX) !== 0) return;
        var v = data[k];
        store(k, typeof v === 'string' ? v : JSON.stringify(v));
      });
      this.loadData();
      document.documentElement.dataset.theme = read(STORAGE.theme) === 'ink' ? 'ink' : 'paper';
      this.globalClock.start(); this.globalClock.pause();
      this.refreshHome();             // 立即刷新首页状态
    },

    /* ── rAF：只在关卡内运行，首页零空转 ─────────────────── */
    startTicker: function () {
      if (this.ticker) return;
      var self = this;
      this.ticker = requestAnimationFrame(function loop() {
        if (!self.ticker) return;
        self.tick();
        if (!self.ticker) return;
        self.ticker = requestAnimationFrame(loop);
      });
    },
    stopTicker: function () {
      if (this.ticker) cancelAnimationFrame(this.ticker);
      this.ticker = 0;
    },
    tick: function () {
      if (this.inLevel && !this.settled) {
        $('level-time').textContent = formatTime(this.levelClock.value());
        $('global-time').textContent = formatTime(this.todayMs() + this.globalClock.value());
      }
      if (this.timers.length) {
        var now = this.levelClock.value();
        var due = [], keep = [];
        this.timers.forEach(function (t) { (t.at <= now ? due : keep).push(t); });
        this.timers = keep;
        due.forEach(function (t) { try { t.fn(); } catch (e) { console.error('[Totgo] after() 回调异常', e); } });
      }
    },

    getConfig: function (def) {
      return Object.assign({}, def.defaultConfig || {}, this.configCache[def.id] || {});
    },
    setConfig: function (def, key, val) {
      var c = Object.assign({}, this.configCache[def.id] || {});
      c[key] = val; this.configCache[def.id] = c;
      store(STORAGE.config, JSON.stringify(this.configCache));
    },

    /* ── 关卡调度 ─────────────────────────────────────────── */
    makeContext: function () {
      var self = this;
      return {
        clock: function () { return self.levelClock.value(); },
        formatTime: formatTime,
        recordClick: function (effective) {
          if (!self.state) return;
          self.state.clicks++;
          if (effective) self.state.effective++;
          self.updateStat();
        },
        addPenalty: function (n) {
          if (!self.state) return;
          self.state.penalties += (n || 1); self.updateStat();
        },
        setProgress: function (p) {
          if (!self.state) return;
          self.state.progress = clamp(Number(p) || 0, 0, 1);
          $('level-progress-fill').style.width = (self.state.progress * 100).toFixed(1) + '%';
        },
        setHint: function (t) { $('level-hint').textContent = t; },
        after: function (ms, fn) { self.timers.push({ at: self.levelClock.value() + ms, fn: fn }); },
        finish: function (reason) { self.settle(reason || 'complete'); },
        ui: ui,
        ripple: ui.ripple,
        shake: ui.shake
      };
    },

    openLevel: function (def) {
      if (def.slot || this.inLevel) return;
      var cfg = this.getConfig(def);
      this.inLevel = true; this.settled = false;
      this.state = { def: def, cfg: cfg, clicks: 0, effective: 0, penalties: 0, progress: 0 };
      this.timers = [];

      $('view-home').hidden = true;
      $('view-level').hidden = false;
      $('level-index').textContent = pad(registry.indexOf(def) + 1);
      $('level-name').textContent = def.name;
      $('level-hint').textContent = '准备';
      // 仅声明了 keyHint 的板块（当前为色词判断）显示实体键位提示
      $('level-keyhint').hidden = !def.keyHint;
      $('level-keyhint').textContent = def.keyHint || '';
      $('level-time').textContent = '00:00.00';
      $('level-progress-fill').style.width = '0%';
      this.updateStat();

      this.levelClock.start();
      var ctx = this.makeContext();
      try {
        this.inst = def.create(ctx);
        var inst = this.inst || {};
        LIFECYCLE.forEach(function (k) {
          if (typeof inst[k] !== 'function') console.warn('[Totgo] ' + def.id + ' 缺少生命周期 ' + k);
        });
        this.inst.init($('level-stage'), cfg, ctx);
        this.inst.start();
      } catch (err) {
        console.error('[Totgo] 模块加载失败', err);
        $('level-hint').textContent = '模块加载失败：' + err.message;
      }
      // 模块 start() 已触发：全局训练跑表与关卡时钟同步运行
      this.globalClock.start();
      $('global-time').textContent = formatTime(this.todayMs() + this.globalClock.value());
      this.startTicker();
      if (this.suspended) {
        this.levelClock.pause();
        this.globalClock.pause();
        this.call('pause');
        $('suspend-overlay').hidden = false;   // 极端边界：首页挂起期间进入关卡
        $('view-level').classList.add('is-frozen');
      }
    },

    updateStat: function () {
      if (!this.state) return;
      var s = this.state;
      $('level-stat').textContent = '有效 ' + s.effective + '/' + s.clicks + ' · 失误 ' + s.penalties;
    },

    call: function (name) {
      var args = Array.prototype.slice.call(arguments, 1);
      var f = this.inst && this.inst[name];
      if (typeof f === 'function') {
        try { return f.apply(this.inst, args); }
        catch (e) { console.error('[Totgo] ' + name + '() 异常', e); }
      }
    },

    /** 通关与主动退出走同一条结算路径：冻结时长 → 累加 → 落档 → 卡片 */
    settle: function (reason) {
      if (!this.inLevel || this.settled) return;
      this.settled = true;
      var score = this.call('getScore') || {};
      var p = typeof score.progress === 'number' ? score.progress : this.state.progress;
      p = clamp(Number(p) || 0, 0, 1);
      var elapsed = this.levelClock.value();       // 本局冻结消耗时长

      this.levelClock.pause();
      this.globalClock.pause();
      this.stopTicker();
      this.timers = [];
      this.call('exit');
      this.inst = null;
      $('suspend-overlay').hidden = true;
      $('view-level').classList.remove('is-frozen');

      /* 1) 时长累加：只统计真实训练，不含首页停留 */
      this.totalTrainingMs += elapsed;
      var today = dayKey();
      this.daily[today] = (Number(this.daily[today]) || 0) + elapsed;
      var days = Object.keys(this.daily).sort();
      if (days.length > DAY_LIMIT) {
        days.slice(0, days.length - DAY_LIMIT).forEach(function (k) { delete this.daily[k]; }, this);
      }
      store(STORAGE.total, String(this.totalTrainingMs));
      store(STORAGE.daily, JSON.stringify(this.daily));

      /* 2) 训练记录 */
      var acc = this.state.clicks ? this.state.effective / this.state.clicks : null;
      var moduleId = this.state.def.id;
      var diff = describeConfig(this.state.def, this.state.cfg);
      var now = Date.now();
      var record = {
        id: now + '-' + Math.random().toString(36).slice(2, 7),
        moduleId: moduleId,
        moduleName: this.state.def.name,
        difficultySummary: diff,
        reason: reason,                       // 'complete' | 'quit'
        durationMs: elapsed,
        accuracy: acc,                        // 0..1，无点击为 null
        penalties: this.state.penalties,
        progress: p,                          // 0..1
        timestamp: now
      };
      this.history.unshift(record);
      this.history = this.history.slice(0, HISTORY_LIMIT);
      store(STORAGE.history, JSON.stringify(this.history));

      /* 3) 累计练习次数 */
      this.counts[moduleId] = (Number(this.counts[moduleId]) || 0) + 1;
      store(STORAGE.counts, JSON.stringify(this.counts));

      /* 4) 最佳通关耗时（仅通关、按模块 + 稳定难度分档） */
      if (reason === 'complete') {
        var key = moduleId + '|' + diff;
        var prev = this.best[key];
        if (!prev || !isFinite(prev.durationMs) || elapsed < prev.durationMs) {
          this.best[key] = {
            moduleId: moduleId, difficultySummary: diff,
            durationMs: elapsed, accuracy: acc, timestamp: now
          };
          store(STORAGE.best, JSON.stringify(this.best));
        }
      }

      /* 5) 沉浸式结算卡片：通关暖褐实线 / 提前结束冷灰虚线，明显区分 */
      var aborted = reason === 'quit';
      var card = $('settle-card');
      card.classList.toggle('is-complete', !aborted);
      card.classList.toggle('is-aborted', aborted);
      $('settle-kicker').textContent = aborted ? '中断 / EARLY EXIT' : 'SESSION · 完成结算';
      $('settle-title').textContent = aborted ? '提前结束' : '完成';
      $('settle-sub').textContent = aborted
        ? '训练已中断 · 本次记录已归档' : '这一段注意力，已经走完了。';
      $('settle-time').textContent = formatTime(elapsed);
      $('settle-acc').textContent = acc == null ? '—' : (acc * 100).toFixed(1) + '%';
      $('settle-penalty').textContent = String(this.state.penalties);
      $('settle-progress').textContent = Math.round(p * 100) + '%';
      $('settle-module').textContent = this.state.def.name;
      $('settle-detail').textContent = score.summary || diff;
      $('btn-retry').hidden = !aborted;
      $('btn-home').textContent = aborted ? '返回首页' : '回到案前';
      $('settle-overlay').hidden = false;
      this.refreshHome();
      // 不主动 focus 按钮，避免结算期间空格误触
    },

    /** 提前结束：唯一的 quit 入口，仅由鼠标点击到达 */
    abortTraining: function () {
      if (!this.inLevel || this.settled) return;
      // 防手滑：进关不足 3 秒且毫无进度 → 静默退回首页，不弹卡、不落档
      if (this.levelClock.value() < 3000 && (this.state.progress || 0) <= 0) {
        this.goHome();
        return;
      }
      this.settle('quit');
    },

    /** 再试一次：沿用同一难度立即重开本关 */
    retry: function () {
      var def = this.state && this.state.def;
      this.goHome();
      if (def) this.openLevel(def);
    },

    goHome: function () {
      $('settle-overlay').hidden = true;
      $('suspend-overlay').hidden = true;
      $('view-level').classList.remove('is-frozen');
      $('view-level').hidden = true;
      $('view-home').hidden = false;
      $('level-stage').innerHTML = '';
      this.stopTicker();
      this.levelClock.pause();
      this.globalClock.pause();
      this.globalClock.start(); this.globalClock.pause();   // 归零且静止
      this.timers = [];
      if (this.suspended) this.resume();
      this.inLevel = false; this.settled = false; this.state = null; this.inst = null;
      this.refreshHome();
    },

    /* ── 切屏挂起：时间与画面一并静止 ─────────────────────── */
    suspend: function () {
      if (this.suspended) return;
      this.suspended = true;
      if (this.inLevel && !this.settled) {
        this.levelClock.pause();
        this.globalClock.pause();
        this.call('pause');
        $('suspend-overlay').hidden = false;
        $('view-level').classList.add('is-frozen');   // 防作弊：暂停期间模糊关卡内容
      }
      // 首页没有任何运行中的时钟，无需动作
    },
    resume: function () {
      if (!this.suspended) return;
      this.suspended = false;
      if (this.inLevel && !this.settled) {
        this.levelClock.resume();
        this.globalClock.resume();
        this.call('resume');
      }
      $('suspend-overlay').hidden = true;
      $('view-level').classList.remove('is-frozen');
    }
  };

  global.Totgo = {
    version: VERSION,
    author: AUTHOR,
    register: register,
    boot: function () { App.boot(); },
    ui: ui,
    utils: { Clock: Clock, formatTime: formatTime, shuffle: shuffle, clamp: clamp, pad: pad },
    Clock: Clock, formatTime: formatTime, shuffle: shuffle, clamp: clamp, pad: pad,
    get modules() { return registry.slice(); }
  };
})(window);
