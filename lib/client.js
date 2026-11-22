/**
 * dsh-token-ring —— 客户端半边：DSH 设置 → 用量
 *
 * 三个环，每段都能指：
 *   悬停 → 环心就地换成那一段的数字
 *   点击 → 锁定，再点一次解锁（触屏也能用）
 *
 *   ① token 构成（缓存读 / 未缓存输入 / 输出 / 缓存写）
 *   ② 花费 vs 缓存省下（绿=真花掉的，灰=缓存替你省的）
 *   ③ 模型占比
 *
 * 只读 /dsh-token-ring/api/stats，不写任何东西。
 */

window.__ModuleLoader__.load({
  id: 'dsh-token-ring',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useState } = React

    const API = '/dsh-token-ring/api'
    const NS = 'token-ring'

    // ---------------------------------------------------------------- 配色
    const COLORS = {
      cacheRead: '#38bdf8',
      input: '#6366f1',
      output: '#f472b6',
      cacheWrite: '#fbbf24',
      cost: '#22c55e',
      saved: 'rgba(127,127,127,.42)',
    }
    const MODEL_PALETTE = [
      '#38bdf8',
      '#a78bfa',
      '#f472b6',
      '#34d399',
      '#fbbf24',
      '#fb7185',
      '#22d3ee',
      '#c084fc',
    ]

    // ---------------------------------------------------------------- 样式
    const CSS_TAG = 'dsh-token-ring/section.css'
    const CSS = [
      '.dtr{display:flex;flex-direction:column;gap:18px;max-width:790px;font-size:13px;color:var(--dsw-alias-label-primary);line-height:1.5}',

      // 头部
      '.dtr-head{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}',
      '.dtr-head-main{flex:1;min-width:190px}',
      '.dtr-h1{margin:0;font-size:17px;font-weight:600;letter-spacing:.2px;line-height:24px}',
      '.dtr-sub{margin:5px 0 0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-tertiary)}',

      // 范围切换
      '.dtr-range{display:inline-flex;padding:2.5px;gap:2px;border-radius:10px;background:rgba(127,127,127,.1);flex:none}',
      '.dtr-range button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:1;padding:6.5px 11px;border-radius:7.5px;cursor:pointer;transition:background .16s,color .16s,transform .16s;white-space:nowrap}',
      '.dtr-range button:hover{color:var(--dsw-alias-label-primary);background:rgba(127,127,127,.1)}',
      '.dtr-range button:active{transform:scale(.96)}',
      '.dtr-range button[data-on="1"]{background:linear-gradient(160deg,rgba(127,127,127,.28),rgba(127,127,127,.2));color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.1),inset 0 1px 0 rgba(255,255,255,.06)}',

      // 三个环
      '.dtr-rings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px}',
      '.dtr-card{position:relative;display:flex;flex-direction:column;align-items:center;gap:12px;padding:17px 13px 15px;border-radius:16px;',
      'background:linear-gradient(163deg,rgba(127,127,127,.075),rgba(127,127,127,.028));',
      'border:1px solid rgba(127,127,127,.11);min-width:0;transition:border-color .2s,box-shadow .28s,transform .32s cubic-bezier(.34,1.56,.64,1)}',
      '.dtr-card:hover{border-color:rgba(127,127,127,.2);box-shadow:0 4px 16px rgba(0,0,0,.08);transform:translateY(-2.5px)}',
      '.dtr-card-h{font-size:10.5px;letter-spacing:.7px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:uppercase}',
      // 范围标签：跟在卡片标题后面，小一号、不抢眼，但能立刻解释两边数字为什么对不上
      '.dtr-card-h-tag{margin-left:6px;font-size:9.5px;font-weight:500;letter-spacing:.2px;text-transform:none;opacity:.85}',

      // 环形
      '.dtr-ring{position:relative;display:flex;align-items:center;justify-content:center;flex:none}',
      '.dtr-svg{display:block;overflow:visible;animation:dtr-in .52s cubic-bezier(.34,1.56,.64,1) both}',
      '@keyframes dtr-in{0%{transform:scale(.84) rotate(-7deg);opacity:0}60%{transform:scale(1.03) rotate(1deg);opacity:1}100%{transform:scale(1) rotate(0)}}',
      '.dtr-seg{pointer-events:stroke;cursor:pointer;transition:stroke-width .34s cubic-bezier(.34,1.56,.64,1),opacity .2s ease,filter .22s ease}',
      '.dtr-seg[data-dim="1"]{opacity:.26}',
      '.dtr-seg[data-hot="1"]{filter:drop-shadow(0 0 7px currentColor)}',
      '.dtr-seg:active{stroke-width:17 !important}',

      // 环心
      '.dtr-mid{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;pointer-events:none;padding:0 8px}',
      '.dtr-mid-v{font-size:21px;font-weight:650;letter-spacing:-.5px;line-height:1.06;font-variant-numeric:tabular-nums;transition:color .18s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
      '.dtr-mid-u{font-size:9.5px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:1px;text-transform:uppercase;line-height:1.2;text-align:center}',
      '.dtr-mid-s{font-size:10.5px;color:var(--dsw-alias-label-tertiary);line-height:1.3;text-align:center;margin-top:1px}',
      '.dtr-pulse{animation:dtr-pop .36s cubic-bezier(.34,1.56,.64,1)}',
      '@keyframes dtr-pop{0%{transform:scale(.68);opacity:.2}55%{transform:scale(1.13)}78%{transform:scale(.96)}100%{transform:scale(1);opacity:1}}',

      // 图例
      '.dtr-legend{display:flex;flex-direction:column;gap:1px;width:100%;min-width:0}',
      '.dtr-li{display:flex;align-items:center;gap:8px;font-size:11.5px;min-width:0;line-height:1.35;padding:3.5px 6px;border-radius:7px;cursor:pointer;transition:background .15s,opacity .15s,transform .26s cubic-bezier(.34,1.56,.64,1);border:0;background:transparent;width:100%;text-align:left;font-family:inherit;color:inherit}',
      '.dtr-li:hover{background:rgba(127,127,127,.11)}',
      '.dtr-li[data-dim="1"]{opacity:.38}',
      '.dtr-li[data-hot="1"]{background:rgba(127,127,127,.13);transform:translateX(2px)}',
      '.dtr-dot{width:7px;height:7px;border-radius:2px;flex:none;transition:transform .3s cubic-bezier(.34,1.56,.64,1)}',
      '.dtr-li[data-hot="1"] .dtr-dot{transform:scale(1.55)}',
      '.dtr-li-k{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.dtr-li-v{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);flex:none}',

      // 骨架 / 错误
      '.dtr-skel{display:grid;grid-template-columns:repeat(3,1fr);gap:13px}',
      '.dtr-skel>div{height:196px;border-radius:16px;background:linear-gradient(90deg,rgba(127,127,127,.08),rgba(127,127,127,.15),rgba(127,127,127,.08));background-size:200% 100%;animation:dtr-sh 1.25s ease-in-out infinite}',
      '@keyframes dtr-sh{0%{background-position:200% 0}100%{background-position:-200% 0}}',
      '.dtr-err{padding:12px 14px;border-radius:12px;font-size:12.5px;color:var(--dsw-alias-state-error-primary,#e5484d);background:rgba(229,72,77,.09);border:1px solid rgba(229,72,77,.25)}',
      '.dtr-empty{padding:30px 14px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}',
      '.dtr-hint{margin:0;text-align:center;font-size:11px;color:var(--dsw-alias-label-tertiary);opacity:.75}',

      // 窄屏
      '@media (max-width:640px){.dtr-rings{grid-template-columns:1fr}.dtr-card{flex-direction:row;gap:15px;align-items:center;padding:15px}.dtr-card-h{writing-mode:vertical-rl;letter-spacing:.4px}.dtr-legend{flex:1}}',

      // ---- 时间线
      '.dtr-tl{margin-top:2px}',
      '.dtr-tl-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:10px}',
      '.dtr-tl-title{font-size:13px;font-weight:600;letter-spacing:.2px}',
      '.dtr-tl-sum{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      // 三组按钮共用一套骨架，但分主次：tabs / modes 是凹槽 + 浮块，span 是轻量文字
      '.dtr-tl-tabs,.dtr-tl-modes{display:inline-flex;align-items:center;padding:3px;gap:2px;border-radius:11px;background:rgba(127,127,127,.06);box-shadow:inset 0 1px 2px rgba(0,0,0,.05);flex:none}',
      '.dtr-tl-span{display:inline-flex;align-items:center;gap:1px;flex:none}',
      '.dtr-tl-tabs button,.dtr-tl-modes button,.dtr-tl-span button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;line-height:1;display:inline-flex;align-items:center;justify-content:center;gap:4.5px;cursor:pointer;border-radius:8px;white-space:nowrap;transition:background .18s ease,color .18s ease,box-shadow .18s ease,transform .1s ease}',
      '.dtr-tl-tabs button{padding:5.5px 11px;font-size:11.5px;letter-spacing:.2px}',
      '.dtr-tl-modes button{padding:5.5px 9px;font-size:11.5px;letter-spacing:.15px}',
      '.dtr-tl-span button{padding:5.5px 7.5px;font-size:11px;font-variant-numeric:tabular-nums;border-radius:7px}',
      '.dtr-tl-tabs button:hover,.dtr-tl-modes button:hover,.dtr-tl-span button:hover{color:var(--dsw-alias-label-primary);background:rgba(127,127,127,.1)}',
      '.dtr-tl-tabs button:active,.dtr-tl-modes button:active,.dtr-tl-span button:active{transform:scale(.955)}',
      // 选中态：实心填充。白底浮块在浅灰槽上对比只有 1.06，肉眼几乎看不出来 ——
      // 这就是之前"像没渲染样式"的原因，改成深一档的填充，边界立刻清楚。
      '.dtr-tl-tabs button[data-on="1"],.dtr-tl-modes button[data-on="1"]{color:var(--dsw-alias-label-primary);font-weight:600;background:rgba(127,127,127,.2);box-shadow:inset 0 0 0 1px rgba(127,127,127,.13)}',
      '.dtr-tl-tabs button[data-on="1"]:hover,.dtr-tl-modes button[data-on="1"]:hover{background:rgba(127,127,127,.24)}',
      '.dtr-tl-span button[data-on="1"]{color:var(--dsw-alias-label-primary);font-weight:600;background:rgba(127,127,127,.16)}',
      '.dtr-tl-span button[data-on="1"]:hover{background:rgba(127,127,127,.2)}',
      // 图标稍微淡一点，选中或悬停时亮起来
      '.dtr-tl-modes button svg{opacity:.7;transition:opacity .18s ease}',
      '.dtr-tl-modes button[data-on="1"] svg,.dtr-tl-modes button:hover svg{opacity:1}',
      '.dtr-tl-tabs button:focus-visible,.dtr-tl-modes button:focus-visible,.dtr-tl-span button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}',
      '.dtr-tl-right{margin-left:auto;display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
      // overflow 必须是 visible：提示框是 absolute 定位的子元素，一裁就只剩半截
      '.dtr-tl-chart{position:relative;border-radius:14px;border:1px solid rgba(127,127,127,.11);background:linear-gradient(163deg,rgba(127,127,127,.06),rgba(127,127,127,.02));padding:10px 6px 2px;overflow:visible}',
      '.dtr-tl-svg{display:block;width:100%;height:auto}',
      '.dtr-bar{transition:opacity .18s ease}',
      '.dtr-bar:hover{opacity:1 !important}',
      '.dtr-line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}',
      '.dtr-dot{transition:r .16s ease}',
      '.dtr-axis{font-size:9.5px;fill:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dtr-grid{stroke:rgba(127,127,127,.13);stroke-width:1}',
      '.dtr-tip{position:absolute;pointer-events:none;background:var(--dsw-alias-bg-layer-2,#232324);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.32));border-radius:9px;padding:7px 10px;font-size:11.5px;line-height:1.55;box-shadow:0 8px 24px rgba(0,0,0,.3);white-space:nowrap;z-index:6;transform:translate(-50%,0);color:var(--dsw-alias-label-primary);max-width:min(320px,88vw)}',
      // 模型名一长就把框撑破，单独给它省略号
      '.dtr-tip>div{overflow:hidden;text-overflow:ellipsis}',
      '.dtr-tip b{font-weight:650}',
      '.dtr-tip i{font-style:normal;color:var(--dsw-alias-label-tertiary)}',
      '.dtr-tl-legend{display:flex;gap:13px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin:8px 0 2px 4px}',
      '.dtr-tl-legend span{display:inline-flex;align-items:center;gap:5px}',
      '.dtr-tl-legend i{width:8px;height:8px;border-radius:2.5px;display:inline-block}',
      '.dtr-tl-empty{padding:26px 0;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '@media (max-width:640px){.dtr-tl-span{margin-left:0}}',
    ].join('\n')

    function ensureCss() {
      try {
        let el = document.getElementById(CSS_TAG)
        if (!el) {
          el = document.createElement('style')
          el.id = CSS_TAG
          document.head.appendChild(el)
        }
        // 只按 id 去重是不够的：插件热更新时模块会重新执行、DOM 换成新结构，
        // 但页面里那张旧样式表还在，新加的类名就一条规则都命中不了 —— 按钮会裸奔。
        // 所以每次都比对内容，不一样就原地替换。
        if (el.textContent !== CSS) el.textContent = CSS
      } catch {
        /* SSR 之类 */
      }
    }

    // ---------------------------------------------------------------- 格式化
    /**
     * 国际计数法：1.2K / 101.1M / 1.95B / 1.23T
     * 返回 { num, unit }，方便环心把数字和单位分两行排版。
     * 千级以下原样输出（带千分位），不硬凑成 0.xK。
     */
    function fmtCompact(n) {
      const raw = Number(n) || 0
      const v = Math.abs(raw)
      const sign = raw < 0 ? '-' : ''
      const table = [
        [1e12, 'T', 2],
        [1e9, 'B', 2],
        [1e6, 'M', 1],
        [1e3, 'K', 1],
      ]
      for (let i = 0; i < table.length; i += 1) {
        const [t, u, d] = table[i]
        if (v < t) continue
        const scaled = v / t
        // 999999 这类数按 K 算会四舍五入成 1000.0K，得升到上一档才有意义
        if (i > 0 && Number(scaled.toFixed(d)) >= 1000) {
          const [ut, uu, ud] = table[i - 1]
          return { num: sign + (v / ut).toFixed(ud), unit: uu }
        }
        return { num: sign + scaled.toFixed(d), unit: u }
      }
      return { num: sign + Math.round(v).toLocaleString('en-US'), unit: '' }
    }

    /** 拼成一串用于文字位（如副标题、图例） */
    function fmtNum(n) {
      const { num, unit } = fmtCompact(n)
      return unit ? num + unit : num
    }

    function fmtMoney(n) {
      const v = Number(n) || 0
      if (v >= 1000) return '¥' + Math.round(v).toLocaleString('zh-CN')
      if (v >= 1) return '¥' + v.toFixed(2)
      if (v > 0) return '¥' + v.toFixed(3)
      return '¥0'
    }

    function fmtPct(x, digits = 1) {
      return ((Number(x) || 0) * 100).toFixed(digits) + '%'
    }

    function shortModel(m) {
      return String(m ?? 'unknown').replace(/^[a-z]{2,3}:/i, '')
    }

    // ---------------------------------------------------------------- 环形
    /**
     * 分段圆环 + 指向交互。
     * segments: [{ value, color, label, num, unit, sub }]
     * activeIndex: 当前被指的那一段（null = 无）
     */
    function Ring({ size = 124, thickness = 10, segments, activeIndex, onHover, onSelect, center }) {
      const r = (size - thickness) / 2
      const C = 2 * Math.PI * r
      const single = segments.length <= 1
      const hot = activeIndex !== null && activeIndex !== undefined

      let acc = 0
      const arcs = []
      for (let i = 0; i < segments.length; i += 1) {
        const s = segments[i]
        const v = Math.max(0, Number(s.value) || 0)
        if (v <= 0) continue
        const len = C * Math.min(1, v)
        const isHot = hot && activeIndex === i
        arcs.push(
          h('circle', {
            key: i,
            className: 'dtr-seg',
            'data-hot': isHot ? '1' : '0',
            'data-dim': hot && !isHot ? '1' : '0',
            cx: size / 2,
            cy: size / 2,
            r,
            fill: 'none',
            stroke: s.color,
            strokeWidth: isHot ? thickness * 1.45 : thickness,
            strokeDasharray: `${len} ${Math.max(0, C - len)}`,
            strokeDashoffset: -acc,
            strokeLinecap: single ? 'round' : 'butt',
            transform: `rotate(-90 ${size / 2} ${size / 2})`,
            style: { color: s.color },
            onMouseEnter: () => onHover?.(i),
            onMouseLeave: () => onHover?.(null),
            onClick: () => onSelect?.(i),
          }),
        )
        acc += len
      }

      return h(
        'div',
        { className: 'dtr-ring', style: { width: size, height: size } },
        h(
          'svg',
          { className: 'dtr-svg', width: size, height: size, viewBox: `0 0 ${size} ${size}` },
          h('circle', {
            cx: size / 2,
            cy: size / 2,
            r,
            fill: 'none',
            stroke: 'rgba(127,127,127,.15)',
            strokeWidth: thickness,
          }),
          arcs,
        ),
        h('div', { className: 'dtr-mid' }, center),
      )
    }

    // ---------------------------------------------------------------- 图例
    function LegendRow({ color, label, value, hot, dim, onHover, onSelect }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dtr-li',
          'data-hot': hot ? '1' : '0',
          'data-dim': dim ? '1' : '0',
          onMouseEnter: () => onHover?.(true),
          onMouseLeave: () => onHover?.(false),
          onClick: onSelect,
        },
        h('span', { className: 'dtr-dot', style: { background: color } }),
        h('span', { className: 'dtr-li-k', title: label }, label),
        h('span', { className: 'dtr-li-v' }, value),
      )
    }

    const RANGES = [
      { id: 'all', label: '全部' },
      { id: '90d', label: '90 天' },
      { id: '30d', label: '30 天' },
      { id: '7d', label: '7 天' },
      { id: 'today', label: '今天' },
    ]

    /**
     * 三个环统计的是「上方 range 选的那一段」，时间线看的是它自己那个窗口（12h/24h/…）。
     * 两边口径本来就不是一回事，不标出来就会被当成算错了 —— 所以卡片标题后面挂上范围。
     */
    const RANGE_LABEL = {
      all: '累计',
      '90d': '近 90 天',
      '30d': '近 30 天',
      '7d': '近 7 天',
      today: '今天',
    }

    // ---------------------------------------------------------------- 时间线
    /** 每种粒度能选多长 */
    const TL_SPANS = {
      hour: [12, 24, 48, 72],
      day: [7, 14, 30, 90],
      month: [6, 12],
    }
    const TL_DEFAULT = { hour: 24, day: 14, month: 12 }
    const TL_UNITS = [
      { id: 'hour', label: '小时' },
      { id: 'day', label: '天' },
      { id: 'month', label: '月' },
    ]
    /** 堆叠柱的顺序：底 → 顶 */
    const TL_STACK = [
      ['cacheRead', COLORS.cacheRead, '缓存读'],
      ['input', COLORS.input, '未缓存输入'],
      ['output', COLORS.output, '输出'],
      ['cacheWrite', COLORS.cacheWrite, '缓存写'],
    ]

    /** 每种视图一个小图标，扫一眼就知道是哪种图，不用读字 */
    const TL_ICON = {
      bar: () =>
        h(
          'svg',
          { viewBox: '0 0 14 14', width: 13, height: 13, 'aria-hidden': 'true' },
          h('rect', { x: 1.4, y: 6.6, width: 2.8, height: 5.8, rx: 1, fill: 'currentColor', opacity: 0.45 }),
          h('rect', { x: 5.6, y: 3.8, width: 2.8, height: 8.6, rx: 1, fill: 'currentColor' }),
          h('rect', { x: 9.8, y: 1.8, width: 2.8, height: 10.6, rx: 1, fill: 'currentColor', opacity: 0.45 }),
        ),
      line: () =>
        h(
          'svg',
          { viewBox: '0 0 14 14', width: 13, height: 13, 'aria-hidden': 'true', fill: 'none' },
          h('path', {
            d: 'M1.8 10.6 L5 6.4 L8 8.6 L12.2 2.6',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
          h('circle', { cx: 12.2, cy: 2.6, r: 1.5, fill: 'currentColor' }),
        ),
      both: () =>
        h(
          'svg',
          { viewBox: '0 0 14 14', width: 13, height: 13, 'aria-hidden': 'true', fill: 'none' },
          h('rect', { x: 1.5, y: 8, width: 2.3, height: 4.4, rx: 0.8, fill: 'currentColor', opacity: 0.3 }),
          h('rect', { x: 5.85, y: 6.6, width: 2.3, height: 5.8, rx: 0.8, fill: 'currentColor', opacity: 0.3 }),
          h('rect', { x: 10.2, y: 9, width: 2.3, height: 3.4, rx: 0.8, fill: 'currentColor', opacity: 0.3 }),
          h('path', {
            d: 'M1.5 6.4 L6 3.2 L9.2 4.8 L12.5 1.6',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
    }

    /** 右上角选看哪种图 */
    const TL_MODES = [
      { id: 'bar', label: '柱状', hint: '每个时间桶的 token 构成（堆叠）' },
      { id: 'line', label: '折线', hint: 'token 总量随时段的走势' },
      { id: 'both', label: '叠加', hint: '柱状（token）+ 折线（调用次数）' },
    ]

    function tlAxisLabel(key, unit) {
      if (unit === 'month') return key.slice(5) + '月'
      if (unit === 'day') return key.slice(5).replace('-', '/')
      return key.slice(11) + '时'
    }
    function tlFullLabel(key, unit) {
      if (unit === 'month') return key.slice(0, 4) + ' 年 ' + key.slice(5) + ' 月'
      if (unit === 'day') return key
      return key.slice(0, 10) + ' ' + key.slice(11) + ':00'
    }
    function tlSpanLabel(unit, n) {
      if (unit === 'month') return n + ' 个月'
      if (unit === 'day') return n + ' 天'
      return n + ' 小时'
    }

    function TimelineCard() {
      const [unit, setUnit] = useState('hour')
      const [span, setSpan] = useState(0)
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const [loading, setLoading] = useState(true)
      const [hover, setHover] = useState(null)
      const [mode, setMode] = useState('bar')

      const limit = span || TL_DEFAULT[unit]

      useEffect(() => {
        let dead = false
        setLoading(true)
        setErr('')
        fetch(`${API}/timeline?unit=${unit}&limit=${limit}`, { headers: { accept: 'application/json' } })
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return r.json()
          })
          .then((j) => {
            if (dead) return
            if (!j?.ok) throw new Error(j?.error || '接口返回异常')
            setData(j)
          })
          .catch((e) => {
            if (!dead) setErr(String(e?.message ?? e))
          })
          .finally(() => {
            if (!dead) setLoading(false)
          })
        return () => {
          dead = true
        }
      }, [unit, limit])

      useEffect(() => {
        setHover(null)
      }, [unit, limit])

      const buckets = data?.buckets ?? []
      const n = buckets.length
      const sumTok = buckets.reduce((a, b) => a + b.total, 0)
      const sumCost = buckets.reduce((a, b) => a + b.cost, 0)
      const sumCalls = buckets.reduce((a, b) => a + b.calls, 0)

      // 画布坐标
      const W = 840
      const H = 214
      const padL = 46
      const padR = 44
      const padT = 14
      const padB = 28
      const plotW = W - padL - padR
      const plotH = H - padT - padB
      const baseY = padT + plotH

      const maxTok = Math.max(1, ...buckets.map((b) => b.total))
      const maxCalls = Math.max(1, ...buckets.map((b) => b.calls))
      const slotW = n > 0 ? plotW / n : plotW
      const barW = Math.max(2, Math.min(44, slotW * 0.62))
      const cx = (i) => padL + slotW * i + slotW / 2
      const labelStep = Math.max(1, Math.ceil(n / 9))

      const bars = []
      const linePts = []
      const tokenPts = []
      if (n > 0) {
        for (let i = 0; i < n; i++) {
          const b = buckets[i]
          let acc = 0
          for (const [k, color] of TL_STACK) {
            const v = b[k]
            if (!v) continue
            const hgt = (v / maxTok) * plotH
            const y = baseY - acc - hgt
            bars.push(
              h('rect', {
                key: b.key + k,
                className: 'dtr-bar',
                x: cx(i) - barW / 2,
                y,
                width: barW,
                height: Math.max(0.6, hgt),
                fill: color,
                rx: 1.4,
                'data-dim': hover !== null && hover !== i ? '1' : '0',
                opacity: hover !== null && hover !== i ? 0.42 : 1,
              }),
            )
            acc += hgt
          }
          linePts.push([cx(i), baseY - (b.calls / maxCalls) * plotH])
          tokenPts.push([cx(i), baseY - (b.total / maxTok) * plotH])
        }
      }

      const toPath = (pts) =>
        pts.length ? pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') : ''
      const linePath = toPath(linePts)
      const tokenPath = toPath(tokenPts)
      const tokenArea =
        tokenPath && n > 0
          ? `${tokenPath} L ${cx(n - 1).toFixed(1)} ${baseY} L ${cx(0).toFixed(1)} ${baseY} Z`
          : ''

      /** 三档视图：只看柱、只看折线、两个叠一起 */
      const showBars = mode === 'bar' || mode === 'both'
      const showTokenLine = mode === 'line'
      const showCallLine = mode === 'both'

      const grid = []
      for (let g = 1; g <= 3; g++) {
        const y = padT + (plotH / 4) * g
        grid.push(h('line', { key: 'g' + g, className: 'dtr-grid', x1: padL, y1: y, x2: padL + plotW, y2: y }))
      }

      const xLabels = []
      if (n > 0) {
        for (let i = 0; i < n; i += labelStep) {
          xLabels.push(
            h(
              'text',
              {
                key: 'x' + i,
                className: 'dtr-axis',
                x: cx(i),
                y: H - 9,
                textAnchor: 'middle',
              },
              tlAxisLabel(buckets[i].key, unit),
            ),
          )
        }
      }

      const hitAreas = []
      if (n > 0) {
        for (let i = 0; i < n; i++) {
          hitAreas.push(
            h('rect', {
              key: 'hit' + i,
              x: padL + slotW * i,
              y: padT,
              width: slotW,
              height: plotH,
              fill: 'transparent',
              onMouseEnter: () => setHover(i),
              onMouseLeave: () => setHover(null),
              style: { cursor: 'default' },
            }),
          )
        }
      }

      const hovered = hover !== null && buckets[hover] ? buckets[hover] : null

      const body = err
        ? h('div', { className: 'dtr-tl-empty' }, `读不到时间线：${err}`)
        : n === 0
          ? h('div', { className: 'dtr-tl-empty' }, loading ? '正在统计…' : '这个范围里还没有调用记录')
          : h(
              'div',
              { className: 'dtr-tl-chart' },
              hovered
                ? h(
                    'div',
                    {
                      className: 'dtr-tip',
                      style: {
                        // 用 clamp 直接夹住中心点：离左右边不足半个提示框宽时自动往里贴，
                        // 比按比例切成三档翻转更稳（提示框宽度随内容变，档位会露出边角）。
                        left: `clamp(140px, ${(Math.min(1, Math.max(0, cx(hover) / W)) * 100).toFixed(3)}%, calc(100% - 140px))`,
                        top: '6px',
                      },
                    },
                    h('div', null, h('b', null, tlFullLabel(hovered.key, unit))),
                    h('div', null, `${fmtCompact(hovered.total).num}${fmtCompact(hovered.total).unit} token · ${hovered.calls} 次调用`),
                    h('div', null, fmtMoney(hovered.cost)),
                    hovered.models.length
                      ? h(
                          'div',
                          null,
                          h('i', null, hovered.models.map((m) => shortModel(m.model)).join(' / ')),
                        )
                      : null,
                  )
                : null,
              h(
                'svg',
                { className: 'dtr-tl-svg', viewBox: `0 0 ${W} ${H}` },
                grid,
                showTokenLine && tokenArea
                  ? h('path', { d: tokenArea, fill: COLORS.input, opacity: 0.14 })
                  : null,
                showBars ? bars : null,
                showTokenLine && tokenPath
                  ? h('path', { className: 'dtr-line', d: tokenPath, stroke: COLORS.input, strokeWidth: 2.2 })
                  : null,
                showCallLine && linePath
                  ? h('path', { className: 'dtr-line', d: linePath, stroke: COLORS.cost, opacity: 0.9 })
                  : null,
                showTokenLine && n <= 44
                  ? tokenPts.map(([x, y], i) =>
                      h('circle', {
                        key: 'tdot' + i,
                        className: 'dtr-dot',
                        cx: x,
                        cy: y,
                        r: hover === i ? 3.4 : 2.1,
                        fill: COLORS.input,
                      }),
                    )
                  : null,
                showCallLine && n <= 44
                  ? linePts.map(([x, y], i) =>
                      h('circle', {
                        key: 'cdot' + i,
                        className: 'dtr-dot',
                        cx: x,
                        cy: y,
                        r: hover === i ? 3.4 : 2.1,
                        fill: COLORS.cost,
                      }),
                    )
                  : null,
                xLabels,
                h(
                  'text',
                  { className: 'dtr-axis', x: padL - 6, y: padT + 9, textAnchor: 'end' },
                  fmtCompact(maxTok).num + fmtCompact(maxTok).unit,
                ),
                h('text', { className: 'dtr-axis', x: padL - 6, y: baseY, textAnchor: 'end' }, '0'),
                showCallLine
                  ? h(
                      'text',
                      { className: 'dtr-axis', x: padL + plotW + 6, y: padT + 9, textAnchor: 'start' },
                      fmtCompact(maxCalls).num + fmtCompact(maxCalls).unit,
                    )
                  : null,
                hitAreas,
              ),
            )

      return h(
        'div',
        { className: 'dtr-tl' },

        h(
          'div',
          { className: 'dtr-tl-head' },
          h('div', { className: 'dtr-tl-title' }, '用量趋势'),
          h(
            'div',
            { className: 'dtr-tl-sum' },
            sumTok > 0 ? `近 ${tlSpanLabel(unit, limit)}：${fmtCompact(sumTok).num}${fmtCompact(sumTok).unit} token · ${sumCalls} 次 · ${fmtMoney(sumCost)}` : '',
          ),
          h(
            'div',
            { className: 'dtr-tl-tabs' },
            TL_UNITS.map((u) =>
              h(
                'button',
                {
                  key: u.id,
                  type: 'button',
                  'data-on': unit === u.id ? '1' : '0',
                  onClick: () => {
                    setUnit(u.id)
                    setSpan(0)
                  },
                },
                u.label,
              ),
            ),
          ),
          h(
            'div',
            { className: 'dtr-tl-right' },
            h(
              'div',
              { className: 'dtr-tl-modes' },
              TL_MODES.map((m) => {
                const Ico = TL_ICON[m.id]
                return h(
                  'button',
                  {
                    key: m.id,
                    type: 'button',
                    title: m.hint,
                    'aria-pressed': mode === m.id ? 'true' : 'false',
                    'data-on': mode === m.id ? '1' : '0',
                    onClick: () => setMode(m.id),
                  },
                  Ico ? h(Ico) : null,
                  h('span', null, m.label),
                )
              }),
            ),
            h(
              'div',
              { className: 'dtr-tl-span' },
              TL_SPANS[unit].map((s) =>
                h(
                  'button',
                  {
                    key: s,
                    type: 'button',
                    'data-on': limit === s ? '1' : '0',
                    onClick: () => setSpan(s),
                  },
                  unit === 'month' ? s + '月' : unit === 'day' ? s + '天' : s + 'h',
                ),
              ),
            ),
          ),
        ),

        body,

        h(
          'div',
          { className: 'dtr-tl-legend' },
          mode === 'line'
            ? [
                h('span', { key: 'tokline' }, h('i', { style: { background: COLORS.input, borderRadius: '50%' } }), 'token 总量（左轴）'),
              ]
            : mode === 'both'
              ? [
                  ...TL_STACK.map(([, color, name]) =>
                    h('span', { key: name }, h('i', { style: { background: color } }), name),
                  ),
                  h('span', { key: 'calls' }, h('i', { style: { background: COLORS.cost, borderRadius: '50%' } }), '调用次数（折线·右轴）'),
                ]
              : TL_STACK.map(([, color, name]) =>
                  h('span', { key: name }, h('i', { style: { background: color } }), name),
                ),
        ),
      )
    }

    // ---------------------------------------------------------------- 主组件
    function TokenRingSection() {
      const [range, setRange] = useState('7d')
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const [loading, setLoading] = useState(true)

      /** hover: 悬停的 {ring, i}；locked: 点击锁定的 {ring, i} */
      const [hover, setHover] = useState(null)
      const [locked, setLocked] = useState(null)

      useEffect(() => {
        ensureCss()
      }, [])

      const load = useCallback(async (r) => {
        setLoading(true)
        setErr('')
        try {
          const res = await fetch(`${API}/stats?range=${encodeURIComponent(r)}`, {
            headers: { accept: 'application/json' },
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const j = await res.json()
          if (!j?.ok) throw new Error(j?.error || '接口返回异常')
          setData(j)
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        load(range)
      }, [range, load])

      // 切范围时清掉选择，避免指到不存在的段
      useEffect(() => {
        setHover(null)
        setLocked(null)
      }, [range])

      const t = data?.totals

      /** 当前生效的选择：锁定的优先于悬停 */
      const active = locked ?? hover

      const toggle = useCallback((ring, i) => {
        setLocked((prev) =>
          prev && prev.ring === ring && prev.i === i ? null : { ring, i },
        )
      }, [])

      // ---- 三组 segment 数据
      const tokenSegs = useMemo(() => {
        if (!t || !t.total) return []
        const mk = (key, label, value, color) => ({
          key,
          label,
          color,
          value: value / t.total,
          raw: value,
          num: fmtCompact(value).num,
          unit: fmtCompact(value).unit,
          sub: fmtPct(value / t.total),
        })
        return [
          mk('cacheRead', '缓存读', t.cacheRead, COLORS.cacheRead),
          mk('input', '未缓存输入', t.input, COLORS.input),
          mk('output', '输出', t.output, COLORS.output),
          mk('cacheWrite', '缓存写', t.cacheWrite, COLORS.cacheWrite),
        ].filter((s) => s.raw > 0)
      }, [t])

      /** 花费环：绿=真花掉的，灰=缓存替你省的。比例用两者之和铺满整圈 */
      const costSegs = useMemo(() => {
        if (!data) return []
        const spent = Number(data.cost) || 0
        const saved = Number(data.cacheSaved) || 0
        const sum = spent + saved
        if (sum <= 0) return []
        return [
          {
            key: 'cost',
            label: '实际花费',
            color: COLORS.cost,
            value: spent / sum,
            raw: spent,
            num: fmtMoney(spent),
            unit: '',
            sub: fmtPct(spent / sum) + ' · 人民币',
            money: true,
          },
          {
            key: 'saved',
            label: '缓存省下',
            color: COLORS.saved,
            value: saved / sum,
            raw: saved,
            num: fmtMoney(saved),
            unit: '',
            sub: fmtPct(saved / sum) + ' · 若不走缓存',
            money: true,
          },
        ].filter((s) => s.raw > 0)
      }, [data])

      const modelSegs = useMemo(() => {
        const ms = data?.models ?? []
        return ms.slice(0, 8).map((m, i) => ({
          key: m.model,
          label: shortModel(m.model),
          color: MODEL_PALETTE[i % MODEL_PALETTE.length],
          value: m.share,
          raw: m.total,
          num: fmtCompact(m.total).num,
          unit: fmtCompact(m.total).unit,
          sub: fmtPct(m.share) + ' · ' + fmtMoney(m.cost),
          model: m,
        }))
      }, [data])

      /** 根据 active 组装环心三行 */
      const centerOf = useCallback(
        (ringName, segs, fallbackNum, fallbackUnit, fallbackSub) => {
          const on = active && active.ring === ringName ? segs[active.i] : null
          if (on) {
            return [
              h(
                'div',
                { className: 'dtr-mid-v dtr-pulse', key: 'v' },
                on.num,
                on.unit
                  ? h('span', { style: { fontSize: '11px', fontWeight: 600, marginLeft: '2px' } }, on.unit)
                  : null,
              ),
              h('div', { className: 'dtr-mid-u', key: 'u' }, on.label),
              h('div', { className: 'dtr-mid-s', key: 's' }, on.sub),
            ]
          }
          return [
            h('div', { className: 'dtr-mid-v', key: 'v' }, fallbackNum),
            h('div', { className: 'dtr-mid-u', key: 'u' }, fallbackUnit),
            fallbackSub ? h('div', { className: 'dtr-mid-s', key: 's' }, fallbackSub) : null,
          ]
        },
        [active],
      )

      if (loading && !data) {
        return h('div', { className: 'dtr' }, h('div', { className: 'dtr-skel' }, h('div'), h('div'), h('div')))
      }
      if (err) return h('div', { className: 'dtr' }, h('div', { className: 'dtr-err' }, `读不到用量数据：${err}`))
      if (!data || !t || t.total <= 0) {
        return h(
          'div',
          { className: 'dtr' },
          h(
            'div',
            { className: 'dtr-empty' },
            range === 'today'
              ? '今天还没有用量记录，点上面的「全部」看历史。'
              : '这个时间范围里还没有可统计的会话。',
          ),
        )
      }

      const isHot = (ringName, i) => Boolean(active && active.ring === ringName && active.i === i)

      /** 单个卡片的图例（可悬停/点击联动） */
      const legend = (ringName, segs, max) =>
        h(
          'div',
          { className: 'dtr-legend' },
          segs.slice(0, max).map((s, i) =>
            h(LegendRow, {
              key: s.key,
              color: s.color,
              label: s.label,
              value: s.money ? fmtMoney(s.raw) : fmtPct(s.value),
              hot: isHot(ringName, i),
              dim: Boolean(active) && !isHot(ringName, i),
              onHover: (on) => setHover(on ? { ring: ringName, i } : null),
              onSelect: () => toggle(ringName, i),
            }),
          ),
        )

      return h(
        'div',
        { className: 'dtr' },

        // 头部
        h(
          'div',
          { className: 'dtr-head' },
          h(
            'div',
            { className: 'dtr-head-main' },
            h('h2', { className: 'dtr-h1' }, '用量'),
            h(
              'p',
              { className: 'dtr-sub' },
              `${data.sessionCount} 个会话${
                data.archivedSessions ? `（含 ${data.archivedSessions} 个已删，从存留里补的）` : ''
              } · ${data.turns} 次调用 · 定价取自 ${data.pricingSource}`,
            ),
          ),
          h(
            'div',
            { className: 'dtr-range' },
            RANGES.map((r) =>
              h(
                'button',
                { key: r.id, type: 'button', 'data-on': range === r.id ? '1' : '0', onClick: () => setRange(r.id) },
                r.label,
              ),
            ),
          ),
        ),

        // 用量趋势
        h(TimelineCard, {}),

        // 三个环
        h(
          'div',
          { className: 'dtr-rings' },

          // ① token 构成
          h(
            'div',
            { className: 'dtr-card' },
            h(
              'div',
              { className: 'dtr-card-h' },
              'Token 构成',
              h('span', { className: 'dtr-card-h-tag' }, RANGE_LABEL[range] || ''),
            ),
            h(Ring, {
              segments: tokenSegs,
              activeIndex: active && active.ring === 'token' ? active.i : null,
              onHover: (i) => setHover(i === null ? null : { ring: 'token', i }),
              onSelect: (i) => toggle('token', i),
              center: centerOf('token', tokenSegs, fmtNum(t.total), 'TOKENS'),
            }),
            legend('token', tokenSegs, 4),
          ),

          // ② 花费
          h(
            'div',
            { className: 'dtr-card' },
            h(
              'div',
              { className: 'dtr-card-h' },
              '花费 / 省下',
              h('span', { className: 'dtr-card-h-tag' }, RANGE_LABEL[range] || ''),
            ),
            h(Ring, {
              segments: costSegs,
              activeIndex: active && active.ring === 'cost' ? active.i : null,
              onHover: (i) => setHover(i === null ? null : { ring: 'cost', i }),
              onSelect: (i) => toggle('cost', i),
              center: centerOf(
                'cost',
                costSegs,
                fmtMoney(data.cost),
                data.currency || 'RMB',
                '命中率 ' + fmtPct(data.cacheHitRate),
              ),
            }),
            legend('cost', costSegs, 2),
          ),

          // ③ 模型占比
          h(
            'div',
            { className: 'dtr-card' },
            h(
              'div',
              { className: 'dtr-card-h' },
              '模型占比',
              h('span', { className: 'dtr-card-h-tag' }, RANGE_LABEL[range] || ''),
            ),
            h(Ring, {
              segments: modelSegs,
              activeIndex: active && active.ring === 'model' ? active.i : null,
              onHover: (i) => setHover(i === null ? null : { ring: 'model', i }),
              onSelect: (i) => toggle('model', i),
              center: centerOf('model', modelSegs, String(data.models.length), 'MODELS'),
            }),
            legend('model', modelSegs, 4),
          ),
        ),

        h('p', { className: 'dtr-hint' }, '悬停看细节 · 点击锁定 · 再点取消'),
      )
    }

    // ---------------------------------------------------------------- 注册
    const inject = ['slots']

    function apply(ctx) {
      ensureCss()
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: NS, order: 68, label: () => '用量' },
          TokenRingSection,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.TokenRingSection = TokenRingSection
    exports.Ring = Ring
    return module.exports
  },
})
